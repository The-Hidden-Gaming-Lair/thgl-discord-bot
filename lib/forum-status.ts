// Forum status policy for #suggestions-issues (Leon 2026-09-30), driven by the api-forge inbox:
//
//   - Posts are never deleted (the forum is the public history and www.th.gl/suggestions-issues
//     renders every post, archived ones included). Only spam/abuse is removed (spam-guard).
//   - When a post's inbox item (fingerprint forum:<threadId>) closes, the bot sets ONE status tag
//     (moderated, staff/bot only; the website shows tags automatically):
//        done    + bug_post   → Fixed        done + suggestion → Implemented
//        done    + question   → Answered     wontfix (any)     → Closed
//   - 3 days after closing, if nobody replied, the thread is archived (not locked). A reply
//     unarchives it, the inbox sync re-ingests it, the item reopens and the status tag is removed.
//   - needs_info with no reply for 14 days is closed by api-forge (→ Closed here).
// The agent's resolution reply in the thread stays its own job (work-inbox skill); this module
// only mirrors the inbox state onto Discord. Runs every 30 min, inert without INBOX_TOKEN.

import { ChannelType, type Client, type ForumChannel, type ThreadChannel } from "discord.js";
import { SUGGESTIONS_ISSUES_CHANNEL } from "./channels";

const INBOX_API_URL = process.env.INBOX_API_URL ?? "https://api-forge.th.gl";
const INBOX_TOKEN = process.env.INBOX_TOKEN ?? "";
const ARCHIVE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const INTERVAL_MS = 30 * 60 * 1000;

export const STATUS_TAGS = [
  { name: "Fixed", emoji: "✅" },
  { name: "Implemented", emoji: "✨" },
  { name: "Answered", emoji: "💬" },
  { name: "Closed", emoji: "🔒" },
] as const;
type StatusTag = (typeof STATUS_TAGS)[number]["name"];

type InboxItem = {
  id: number;
  fingerprint: string;
  source: string;
  status: string;
  updated_at: string;
};

export function statusTagFor(item: Pick<InboxItem, "status" | "source">): StatusTag | null {
  if (item.status === "wontfix") return "Closed";
  if (item.status !== "done") return null;
  if (item.source === "suggestion") return "Implemented";
  if (item.source === "question") return "Answered";
  return "Fixed";
}

const sqlTime = (t: string) => new Date(`${t.replace(" ", "T")}Z`).getTime();

async function listForumItems(): Promise<InboxItem[]> {
  const res = await fetch(`${INBOX_API_URL}/inbox?status=all&q=forum:&limit=500`, {
    headers: { Authorization: `Bearer ${INBOX_TOKEN}` },
  });
  if (!res.ok) throw new Error(`inbox ${res.status}`);
  const { items } = (await res.json()) as { items: InboxItem[] };
  return items.filter((i) => i.fingerprint.startsWith("forum:"));
}

async function ensureStatusTags(forum: ForumChannel) {
  const missing = STATUS_TAGS.filter((t) => !forum.availableTags.some((a) => a.name === t.name));
  if (!missing.length) return;
  await forum.setAvailableTags([
    ...forum.availableTags,
    ...missing.map((t) => ({ name: t.name, moderated: true, emoji: { id: null, name: t.emoji } })),
  ]);
  console.log(`[forum-status] created tags: ${missing.map((t) => t.name).join(", ")}`);
}

async function syncThread(forum: ForumChannel, thread: ThreadChannel, item: InboxItem) {
  const statusIds = new Map(
    forum.availableTags.filter((t) => STATUS_TAGS.some((s) => s.name === t.name)).map((t) => [t.id, t.name]),
  );
  const want = statusTagFor(item);
  const wantId = want ? forum.availableTags.find((t) => t.name === want)?.id : undefined;
  const keep = thread.appliedTags.filter((id) => !statusIds.has(id));
  // Discord allows at most 5 tags per post.
  const tags = wantId ? [...keep.slice(0, 4), wantId] : keep;
  const tagsChanged =
    tags.length !== thread.appliedTags.length || tags.some((id) => !thread.appliedTags.includes(id));

  const closedFor = Date.now() - sqlTime(item.updated_at);
  const lastActivity = thread.lastMessage?.createdTimestamp ?? thread.createdTimestamp ?? 0;
  const shouldArchive =
    !!want && closedFor > ARCHIVE_AFTER_MS && Date.now() - lastActivity > ARCHIVE_AFTER_MS;

  if (!tagsChanged && (thread.archived || !shouldArchive)) return;
  // An archived thread only accepts `archived: false` first.
  if (thread.archived && tagsChanged) await thread.setArchived(false, "inbox status sync");
  if (tagsChanged) await thread.setAppliedTags(tags, `inbox #${item.id}: ${want ?? "reopened"}`);
  if (shouldArchive || (thread.archived && tagsChanged)) {
    await thread.setArchived(true, `inbox #${item.id} closed (${want})`);
  }
  console.log(
    `[forum-status] #${item.id} ${thread.name}: ${want ?? "no status"}${shouldArchive ? ", archived" : ""}`,
  );
}

async function runOnce(client: Client) {
  const forum = await client.channels.fetch(SUGGESTIONS_ISSUES_CHANNEL.id);
  if (forum?.type !== ChannelType.GuildForum) return;
  await ensureStatusTags(forum);
  const fresh = (await forum.fetch()) as ForumChannel;
  for (const item of await listForumItems()) {
    const threadId = item.fingerprint.slice("forum:".length);
    try {
      const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
      if (!thread || thread.parentId !== forum.id) continue;
      await syncThread(fresh, thread, item);
    } catch (err) {
      console.warn(`[forum-status] #${item.id} (${threadId}) failed:`, (err as Error).message);
    }
  }
}

export function startForumStatusSync(client: Client) {
  if (!INBOX_TOKEN) return;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce(client);
    } catch (err) {
      console.warn("[forum-status] run failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 90_000);
  setInterval(() => void tick(), INTERVAL_MS);
  console.log("[forum-status] syncing inbox status to forum tags every 30 min");
}
