// Forum status policy for #suggestions-issues (Leon 2026-09-30, deletion 2026-10-02), driven by
// the api-forge inbox:
//
//   - Open posts (open / needs_leon / needs_info, i.e. our turn or waiting) are never touched.
//     Spam/abuse is removed immediately (spam-guard).
//   - When a post's inbox item (fingerprint forum:<threadId>) closes, the bot sets ONE status tag
//     (moderated, staff/bot only; the website shows tags automatically):
//        done    + bug_post   → Fixed        done + suggestion → Implemented
//        done    + question   → Answered     wontfix (any)     → Closed
//   - 3 days after closing, if nobody replied, the thread is archived (not locked). A reply
//     unarchives it, the inbox sync re-ingests it, the item reopens and the status tag is removed.
//   - needs_info with no reply for 14 days is closed by api-forge (→ Closed here).
//   - 30 days after closing, with no message in the thread for 30 days, the thread is DELETED:
//     old workarounds in solved posts go stale and mislead players. The inbox item stays as the
//     record; the website drops the post (it reads the forum live, a deleted post 404s).
// The agent's resolution reply in the thread stays its own job (work-inbox skill); this module
// only mirrors the inbox state onto Discord. Runs every 30 min, inert without INBOX_TOKEN.

import {
  ChannelType,
  DiscordAPIError,
  RESTJSONErrorCodes,
  SnowflakeUtil,
  type Client,
  type ForumChannel,
  type ThreadChannel,
} from "discord.js";
import { SUGGESTIONS_ISSUES_CHANNEL } from "./channels";

const INBOX_API_URL = process.env.INBOX_API_URL ?? "https://api-forge.th.gl";
const INBOX_TOKEN = process.env.INBOX_TOKEN ?? "";
const DAY_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_AFTER_MS = 3 * DAY_MS;
const DELETE_AFTER_MS = 30 * DAY_MS;
const PAGE = 500;
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
  const all: InboxItem[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(
      `${INBOX_API_URL}/inbox?status=all&q=forum:&limit=${PAGE}&offset=${offset}`,
      { headers: { Authorization: `Bearer ${INBOX_TOKEN}` } },
    );
    if (!res.ok) throw new Error(`inbox ${res.status}`);
    const { items } = (await res.json()) as { items: InboxItem[] };
    all.push(...items);
    if (items.length < PAGE) break;
  }
  return all.filter((i) => i.fingerprint.startsWith("forum:"));
}

/** Threads deleted (by us or anyone): no refetch every run for the rest of the process. */
const gone = new Set<string>();

/** Last message time from the snowflake: `thread.lastMessage` is only set when cached. */
const lastActivityOf = (thread: ThreadChannel) =>
  thread.lastMessageId
    ? SnowflakeUtil.timestampFrom(thread.lastMessageId)
    : (thread.createdTimestamp ?? Date.now());

async function ensureStatusTags(forum: ForumChannel) {
  const missing = STATUS_TAGS.filter((t) => !forum.availableTags.some((a) => a.name === t.name));
  if (!missing.length) return;
  await forum.setAvailableTags([
    ...forum.availableTags,
    ...missing.map((t) => ({ name: t.name, moderated: true, emoji: { id: null, name: t.emoji } })),
  ]);
  console.log(`[forum-status] created tags: ${missing.map((t) => t.name).join(", ")}`);
}

/** Returns true when the thread was deleted. */
async function syncThread(
  forum: ForumChannel,
  thread: ThreadChannel,
  item: InboxItem,
): Promise<boolean> {
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
  const quietFor = Date.now() - lastActivityOf(thread);

  if (want && closedFor > DELETE_AFTER_MS && quietFor > DELETE_AFTER_MS) {
    await thread.delete(`inbox #${item.id} closed (${want}) over 30 days ago`);
    console.log(`[forum-status] #${item.id} ${thread.name}: deleted (${want}, 30 days closed)`);
    return true;
  }

  const shouldArchive = !!want && closedFor > ARCHIVE_AFTER_MS && quietFor > ARCHIVE_AFTER_MS;

  if (!tagsChanged && (thread.archived || !shouldArchive)) return false;
  // An archived thread only accepts `archived: false` first.
  if (thread.archived && tagsChanged) await thread.setArchived(false, "inbox status sync");
  if (tagsChanged) await thread.setAppliedTags(tags, `inbox #${item.id}: ${want ?? "reopened"}`);
  if (shouldArchive || (thread.archived && tagsChanged)) {
    await thread.setArchived(true, `inbox #${item.id} closed (${want})`);
  }
  console.log(
    `[forum-status] #${item.id} ${thread.name}: ${want ?? "no status"}${shouldArchive ? ", archived" : ""}`,
  );
  return false;
}

async function runOnce(client: Client) {
  const forum = await client.channels.fetch(SUGGESTIONS_ISSUES_CHANNEL.id);
  if (forum?.type !== ChannelType.GuildForum) return;
  await ensureStatusTags(forum);
  const fresh = (await forum.fetch()) as ForumChannel;
  for (const item of await listForumItems()) {
    const threadId = item.fingerprint.slice("forum:".length);
    if (gone.has(threadId)) continue;
    try {
      const thread = (await client.channels.fetch(threadId)) as ThreadChannel | null;
      if (!thread || thread.parentId !== forum.id) continue;
      if (await syncThread(fresh, thread, item)) gone.add(threadId);
    } catch (err) {
      // Deleted threads keep their (closed) inbox item; skip them quietly from now on.
      if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownChannel) {
        gone.add(threadId);
        continue;
      }
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
