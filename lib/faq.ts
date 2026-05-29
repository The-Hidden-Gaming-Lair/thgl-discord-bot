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

// FAQ label → forum tag NAME. Resolved to tag IDs at runtime against the
// channel's available tags, so it survives tag-ID changes. Unmapped labels
// fall back to FALLBACK_TAG_NAME.
const LABEL_TO_TAG_NAME: Record<string, string> = {
  Palia: "Palia",
  "Once Human": "Once Human",
  Palworld: "Palworld",
  "Dune: Awakening": "THGL",
  "New World": "Aeternum Map",
  Overwolf: "THGL",
  "Companion App": "THGL",
  General: "THGL",
  Linux: "THGL",
  Subscription: "THGL",
  Technical: "THGL",
};
const FALLBACK_TAG_NAME = "THGL";

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
 * Build the starter-message body for an entry. The trailing canonical link
 * also serves as the identity marker used to match threads on resync.
 */
export function buildPostBody(entry: FaqEntry, baseUrl: string): string {
  const url = webUrl(baseUrl, entry.id);
  const footer = `\n\n📖 **Read the full answer:** ${url}`;
  const body = absolutizeLinks(entry.answer.trim());

  const budget = MAX_MESSAGE_LENGTH - footer.length;
  if (body.length <= budget) {
    return body + footer;
  }

  // Truncate at the last newline that fits, falling back to a hard cut.
  const ellipsis = "\n\n…";
  const hardBudget = budget - ellipsis.length;
  let cut = body.lastIndexOf("\n", hardBudget);
  if (cut < hardBudget * 0.6) {
    cut = hardBudget; // no convenient newline; hard cut
  }
  return body.slice(0, cut).trimEnd() + ellipsis + footer;
}

function threadName(entry: FaqEntry): string {
  const name = entry.headline?.trim() || entry.question.trim();
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
    const tagName = LABEL_TO_TAG_NAME[label] ?? FALLBACK_TAG_NAME;
    const id = byName.get(tagName.toLowerCase());
    if (id) ids.add(id);
  }
  if (ids.size === 0) {
    const fallback = byName.get(FALLBACK_TAG_NAME.toLowerCase());
    if (fallback) ids.add(fallback);
  }
  return [...ids].slice(0, MAX_APPLIED_TAGS);
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
  const infos: ThreadInfo[] = [];
  for (const thread of threads) {
    const starter = await thread.fetchStarterMessage().catch(() => null);
    const byBot = !!starter && !!botId && starter.author.id === botId;
    infos.push({
      thread,
      byBot,
      faqId: starter ? parseFaqId(starter.content) : null,
      title: thread.name,
    });
  }
  return infos;
}

export async function syncFaq(
  options: { applyDeletes?: boolean } = {},
): Promise<FaqSyncReport> {
  const applyDeletes = options.applyDeletes ?? false;
  const feed = await fetchFaqFeed();
  const forum = getForumChannel(FAQ_CHANNEL.id) as ForumChannel;
  const availableTags = forum.availableTags;

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
