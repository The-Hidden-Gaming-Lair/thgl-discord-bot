import {
  ForumChannel,
  ThreadChannel,
  type GuildForumTag,
} from "discord.js";
import { getClient, getForumChannel, getForumPosts } from "./discord";
import { FAQ_CHANNEL } from "./channels";

/**
 * Web → Discord FAQ sync.
 *
 * The web FAQ (`faq-entries.ts`, exposed at FAQ_API_URL) is the single
 * source of truth. This module reconciles the FAQ forum channel so that
 * every web entry has exactly one bot-authored thread, kept up to date.
 *
 * Because a bot can only edit messages it authored, the synced threads are
 * always bot-authored. Legacy/foreign threads (and orphaned bot threads
 * whose entry was removed) are deleted — but only when `applyDeletes` is
 * set, so the first run can be inspected as a dry run.
 */

const FAQ_API_URL =
  process.env.FAQ_API_URL || "https://www.th.gl/api/faq";

// Discord hard limit for a (non-nitro bot) message. The full answer lives
// on the web; we mirror as much as fits and always link to the canonical page.
const MAX_MESSAGE_LENGTH = 2000;
const MAX_THREAD_NAME_LENGTH = 100;
const MAX_APPLIED_TAGS = 5;

export type FaqEntry = {
  id: string;
  headline: string;
  question: string;
  answer: string;
  labels: string[];
};

type FaqFeed = {
  baseUrl: string;
  count: number;
  entries: FaqEntry[];
};

// Forum threads are tagged with the entry's own web FAQ labels (1:1 by name).
// Missing label tags are created on the forum during sync (ensureForumTags),
// so the Discord tags mirror the website. FALLBACK is only used if a label
// somehow has no tag (e.g. the 20-tag forum cap was hit).
const FALLBACK_TAG_NAME = "THGL";
// Discord allows at most 20 tags per forum channel.
const MAX_FORUM_TAGS = 20;

export type FaqSyncAction =
  | { action: "create"; id: string; headline: string }
  | { action: "update"; id: string; headline: string; threadId: string }
  | { action: "skip"; id: string; threadId: string }
  | {
      action: "delete";
      id: string | null;
      threadId: string;
      title: string;
      reason: "orphan" | "foreign";
      hasWebEquivalent: boolean;
      applied: boolean;
    }
  | { action: "error"; id: string | null; threadId?: string; error: string };

export type FaqSyncReport = {
  dryRun: boolean;
  source: string;
  entryCount: number;
  created: number;
  updated: number;
  skipped: number;
  deleted: number;
  pendingDeletions: number;
  errors: number;
  actions: FaqSyncAction[];
};

async function fetchFaqFeed(): Promise<FaqFeed> {
  const res = await fetch(FAQ_API_URL, {
    headers: { "user-agent": "thgl-discord-bot/faq-sync" },
  });
  if (!res.ok) {
    throw new Error(`FAQ feed responded ${res.status} (${FAQ_API_URL})`);
  }
  const data = (await res.json()) as FaqFeed;
  if (!Array.isArray(data?.entries)) {
    throw new Error("FAQ feed missing `entries` array");
  }
  return data;
}

function webUrl(baseUrl: string, id: string) {
  return `${baseUrl.replace(/\/$/, "")}/${id}`;
}

/**
 * Rewrite root-relative markdown links (e.g. `(/support-me)`) to absolute
 * th.gl URLs so they work inside Discord.
 */
function absolutizeLinks(markdown: string): string {
  return markdown.replace(/\]\((\/[^)]*)\)/g, "](https://www.th.gl$1)");
}

/**
 * Build the starter-message body for an entry. The thread title carries the
 * question (see threadName), so the body is just the answer. The trailing
 * canonical link also serves as the identity marker used to match threads on
 * resync.
 */
export function buildPostBody(entry: FaqEntry, baseUrl: string): string {
  const url = webUrl(baseUrl, entry.id);
  const answer = absolutizeLinks(entry.answer.trim());

  // Most answers fit whole; only say "read the full answer" when truncated.
  const linkFooter = `\n\n🔗 **Web version:** ${url}`;
  const truncFooter = `\n\n📖 **Read the full answer:** ${url}`;

  if (answer.length + linkFooter.length <= MAX_MESSAGE_LENGTH) {
    return answer + linkFooter;
  }

  // Truncate the answer at the last newline that fits, else a hard cut.
  const ellipsis = "\n\n…";
  const budget = MAX_MESSAGE_LENGTH - truncFooter.length - ellipsis.length;
  let cut = answer.lastIndexOf("\n", budget);
  if (cut < budget * 0.6) {
    cut = budget; // no convenient newline; hard cut
  }
  return answer.slice(0, cut).trimEnd() + ellipsis + truncFooter;
}

// The thread title is the question (the answer reads as a reply to it, e.g. a
// leading "No,…"), matching the web FAQ detail page.
function threadName(entry: FaqEntry): string {
  const name = entry.question?.trim() || entry.headline.trim();
  return name.length > MAX_THREAD_NAME_LENGTH
    ? name.slice(0, MAX_THREAD_NAME_LENGTH - 1).trimEnd() + "…"
    : name;
}

function resolveTagIds(
  labels: string[],
  availableTags: GuildForumTag[],
): string[] {
  const byName = new Map(
    availableTags.map((t) => [t.name.toLowerCase(), t.id] as const),
  );
  const ids = new Set<string>();
  for (const label of labels) {
    const id = byName.get(label.toLowerCase());
    if (id) ids.add(id);
  }
  if (ids.size === 0) {
    const fallback = byName.get(FALLBACK_TAG_NAME.toLowerCase());
    if (fallback) ids.add(fallback);
  }
  return [...ids].slice(0, MAX_APPLIED_TAGS);
}

/**
 * Reconcile the forum's tag set to exactly the labels used by the web FAQ
 * (requires Manage Channels). Existing tags with a matching name keep their
 * id/emoji; missing labels are created; any other tags (e.g. orphaned legacy
 * game tags) are removed. The FAQ forum is fully bot-managed, so its tag set
 * mirrors the website. On failure (e.g. missing permission or the 20-tag cap)
 * it logs and returns the current tags so the sync still proceeds.
 */
async function reconcileForumTags(
  forum: ForumChannel,
  requiredLabels: string[],
): Promise<GuildForumTag[]> {
  const existing = forum.availableTags;
  const desired = [...new Set(requiredLabels)].slice(0, MAX_FORUM_TAGS);
  const existingByName = new Map(
    existing.map((t) => [t.name.toLowerCase(), t] as const),
  );

  const desiredSet = new Set(desired.map((n) => n.toLowerCase()));
  const alreadyExact =
    existing.length === desired.length &&
    existing.every((t) => desiredSet.has(t.name.toLowerCase()));
  if (alreadyExact) return existing;

  try {
    const target = desired.map((name) => {
      const ex = existingByName.get(name.toLowerCase());
      return ex
        ? {
            id: ex.id,
            name: ex.name,
            moderated: ex.moderated,
            emoji: ex.emoji?.id || ex.emoji?.name ? ex.emoji : null,
          }
        : { name, moderated: false };
    });
    const updated = await forum.setAvailableTags(
      target,
      "FAQ sync: reconcile tags to web labels",
    );
    const removed = existing
      .filter((t) => !desiredSet.has(t.name.toLowerCase()))
      .map((t) => t.name);
    const added = desired.filter(
      (n) => !existingByName.has(n.toLowerCase()),
    );
    console.log(
      `[faq-sync] tags reconciled (+${added.length} -${removed.length})` +
        (added.length ? ` added: ${added.join(", ")}` : "") +
        (removed.length ? ` removed: ${removed.join(", ")}` : ""),
    );
    return updated.availableTags;
  } catch (error: any) {
    console.error(
      `[faq-sync] could not reconcile tags (${error?.message ?? error}); ` +
        "check the bot's Manage Channels permission. Proceeding without changes.",
    );
    return existing;
  }
}

/** Extract the FAQ id from a synced thread's starter body (the canonical link). */
function parseFaqId(content: string): string | null {
  const match = content.match(/th\.gl\/faq\/([a-z0-9-]+)/i);
  return match ? match[1] : null;
}

type ThreadInfo = {
  thread: ThreadChannel;
  faqId: string | null;
  byBot: boolean;
  title: string;
};

async function loadThreads(channelId: string): Promise<ThreadInfo[]> {
  const client = getClient();
  const botId = client.user?.id;
  const threads = await getForumPosts(channelId); // active + archived
  // Fetch starter messages in parallel — sequential fetching of ~30+ threads
  // is the main cost and easily exceeds the request timeout.
  return Promise.all(
    threads.map(async (thread) => {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      const byBot = !!starter && !!botId && starter.author.id === botId;
      return {
        thread,
        byBot,
        faqId: starter ? parseFaqId(starter.content) : null,
        title: thread.name,
      } satisfies ThreadInfo;
    }),
  );
}

export async function syncFaq(
  options: { applyDeletes?: boolean } = {},
): Promise<FaqSyncReport> {
  const applyDeletes = options.applyDeletes ?? false;
  const feed = await fetchFaqFeed();
  const forum = getForumChannel(FAQ_CHANNEL.id) as ForumChannel;

  // Mirror the web FAQ labels as the forum's tag set (creates missing,
  // removes orphaned legacy tags).
  const usedLabels = feed.entries.flatMap((e) => e.labels);
  const availableTags = await reconcileForumTags(forum, usedLabels);

  const threads = await loadThreads(FAQ_CHANNEL.id);
  // Bot-authored threads we manage, keyed by FAQ id (first one wins).
  const managed = new Map<string, ThreadInfo>();
  for (const info of threads) {
    if (info.byBot && info.faqId && !managed.has(info.faqId)) {
      managed.set(info.faqId, info);
    }
  }
  const webIds = new Set(feed.entries.map((e) => e.id));

  const report: FaqSyncReport = {
    dryRun: !applyDeletes,
    source: FAQ_API_URL,
    entryCount: feed.entries.length,
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    pendingDeletions: 0,
    errors: 0,
    actions: [],
  };

  // 1. Create / update a bot thread for every web entry (always, additive).
  for (const entry of feed.entries) {
    const body = buildPostBody(entry, feed.baseUrl);
    const name = threadName(entry);
    const tagIds = resolveTagIds(entry.labels, availableTags);
    const existing = managed.get(entry.id);

    try {
      if (!existing) {
        await forum.threads.create({
          name,
          message: { content: body },
          appliedTags: tagIds,
          reason: `FAQ sync: create ${entry.id}`,
        });
        report.created++;
        report.actions.push({ action: "create", id: entry.id, headline: name });
        continue;
      }

      const thread = existing.thread;
      if (thread.archived) {
        await thread.setArchived(false, "FAQ sync: update");
      }
      const starter = await thread.fetchStarterMessage();
      if (!starter) {
        throw new Error("starter message unavailable");
      }
      const needsBody = starter.content !== body;
      const needsName = thread.name !== name;
      const needsTags =
        thread.appliedTags.slice().sort().join(",") !==
        tagIds.slice().sort().join(",");

      if (needsBody) await starter.edit({ content: body });
      if (needsName) await thread.setName(name, "FAQ sync");
      if (needsTags) await thread.setAppliedTags(tagIds, "FAQ sync");

      if (needsBody || needsName || needsTags) {
        report.updated++;
        report.actions.push({
          action: "update",
          id: entry.id,
          headline: name,
          threadId: thread.id,
        });
      } else {
        report.skipped++;
        report.actions.push({
          action: "skip",
          id: entry.id,
          threadId: thread.id,
        });
      }
    } catch (error: any) {
      report.errors++;
      report.actions.push({
        action: "error",
        id: entry.id,
        threadId: existing?.thread.id,
        error: error?.message ?? String(error),
      });
    }
  }

  // 2. Delete threads that should no longer exist:
  //    - foreign (legacy, non-bot) threads — replaced by the synced set
  //    - orphaned bot threads whose entry was removed from the web FAQ
  //    Gated behind applyDeletes; otherwise reported as pending.
  for (const info of threads) {
    const isOrphanBot = info.byBot && (!info.faqId || !webIds.has(info.faqId));
    const isForeign = !info.byBot;
    if (!isOrphanBot && !isForeign) continue;

    const hasWebEquivalent = !!info.faqId && webIds.has(info.faqId);
    // A foreign thread whose topic we just (re)created as a bot thread is
    // safe to remove. A foreign thread with no web equivalent is unique
    // legacy content — flag it loudly so it isn't silently destroyed.
    const reason: "orphan" | "foreign" = isForeign ? "foreign" : "orphan";

    if (!applyDeletes) {
      report.pendingDeletions++;
      report.actions.push({
        action: "delete",
        id: info.faqId,
        threadId: info.thread.id,
        title: info.title,
        reason,
        hasWebEquivalent,
        applied: false,
      });
      continue;
    }

    try {
      await info.thread.delete(`FAQ sync: remove ${reason}`);
      report.deleted++;
      report.actions.push({
        action: "delete",
        id: info.faqId,
        threadId: info.thread.id,
        title: info.title,
        reason,
        hasWebEquivalent,
        applied: true,
      });
    } catch (error: any) {
      report.errors++;
      report.actions.push({
        action: "error",
        id: info.faqId,
        threadId: info.thread.id,
        error: error?.message ?? String(error),
      });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Run management
//
// The sync makes many sequential Discord writes and can run well past an HTTP
// request timeout, so callers start it in the background and poll status. A
// single run-lock prevents overlapping runs (which would create duplicates).
// ---------------------------------------------------------------------------

let syncRunning = false;
let lastStartedAt: number | null = null;
let lastFinishedAt: number | null = null;
let lastReport: FaqSyncReport | null = null;
let lastError: string | null = null;

export function getFaqSyncStatus() {
  return {
    running: syncRunning,
    lastStartedAt,
    lastFinishedAt,
    lastError,
    lastReport,
  };
}

async function executeSync(options: { applyDeletes?: boolean }) {
  lastStartedAt = Date.now();
  try {
    const report = await syncFaq(options);
    lastReport = report;
    lastError = null;
    console.log(
      `[faq-sync] ${report.created} created, ${report.updated} updated, ` +
        `${report.skipped} unchanged, ${report.deleted} deleted, ` +
        `${report.pendingDeletions} pending, ${report.errors} errors`,
    );
  } catch (error: any) {
    lastError = error?.message ?? String(error);
    console.error("[faq-sync] run failed:", lastError);
  } finally {
    lastFinishedAt = Date.now();
    syncRunning = false;
  }
}

/**
 * Start a sync in the background. Returns synchronously so HTTP handlers and
 * the scheduler don't block on the work. No-op if a run is already in flight.
 */
export function startFaqSync(options: { applyDeletes?: boolean } = {}): {
  started: boolean;
  alreadyRunning: boolean;
} {
  if (syncRunning) {
    return { started: false, alreadyRunning: true };
  }
  syncRunning = true;
  void executeSync(options);
  return { started: true, alreadyRunning: false };
}
