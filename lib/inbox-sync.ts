// THGL Inbox ingestion: turns what lands in Discord into api-forge inbox items
// (the one queue Leon, Joey and the autonomous agent work — see api-forge
// CLAUDE.md "THGL Inbox"). Sources:
//   - #app-debug crash reports      → crash:<Crash ID>   (repeats group, a fixed crash reopens)
//   - #app-debug debug snapshots    → snapshot:<messageId>
//   - support tickets (threads)     → ticket:<threadId>  (a user reply reopens needs_info)
//   - suggestions-issues forum      → forum:<threadId>   (bug / suggestion / question)
// Inert unless INBOX_TOKEN is set (a `bot` actor token; bots may only ingest).
// Every ingest is idempotent per fingerprint, and the startup backfill uses
// `ifNew` so a restart never counts an item twice.

import {
  ChannelType,
  Events,
  type AnyThreadChannel,
  type Client,
  type Message,
} from "discord.js";
import {
  SUGGESTIONS_ISSUES_CHANNEL,
  TICKET_CHANNEL_ID,
  TICKET_STAFF_ROLE_ID,
} from "./channels";
import { getSuggestionMeta } from "./suggestions-meta";
import { parseTicketMarker } from "./tickets";

export const APP_DEBUG_CHANNEL_ID =
  process.env.APP_DEBUG_CHANNEL_ID ?? "1414887114352365679";
const INBOX_API_URL = process.env.INBOX_API_URL ?? "https://api-forge.th.gl";
const INBOX_TOKEN = process.env.INBOX_TOKEN ?? "";

type IngestBody = {
  fingerprint: string;
  source: string;
  title: string;
  appId?: string | null;
  summary?: string | null;
  sourceUrl?: string | null;
  priority?: number;
  detail?: string | null;
  data?: unknown;
  ifNew?: boolean;
};

async function ingest(body: IngestBody): Promise<void> {
  if (!INBOX_TOKEN) return;
  try {
    const res = await fetch(`${INBOX_API_URL}/inbox`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INBOX_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[inbox] ingest ${body.fingerprint} failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.warn(`[inbox] ingest ${body.fingerprint} failed:`, err);
  }
}

const field = (m: Message, name: string) =>
  m.embeds[0]?.fields.find((f) => f.name === name)?.value?.trim() ?? "";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Game id-ish label from "PaliaClientSteam-Win64-Shipping.exe (PID: 1)". */
function gameFromActiveGames(active: string): string | null {
  const exe = active.split("(")[0].trim();
  if (!exe || exe === "None") return null;
  return exe.replace(/\.exe$/i, "").replace(/-Win64-Shipping$/i, "");
}

// --------------------------------------------------------------------------
// #app-debug
// --------------------------------------------------------------------------

export function crashBody(m: Message): IngestBody | null {
  const embed = m.embeds[0];
  if (!embed?.title?.includes("Application Crash")) return null;
  const crashId = field(m, "Crash ID");
  if (!crashId) return null;
  const version = field(m, "App Version").split(" ")[0];
  const thread = field(m, "Thread");
  const game = gameFromActiveGames(field(m, "Active Games"));
  const kind =
    embed.description?.match(/Signal: (\w+)/)?.[1] ??
    embed.description?.match(/Exception Code: (0x[0-9a-f]+[^\n`]*)/i)?.[1]?.trim() ??
    "crash";
  return {
    fingerprint: `crash:${crashId}`,
    source: "crash",
    appId: "thglapp",
    title: clip(`THGLApp crash ${kind}${game ? ` with ${game}` : ""} (${version || "?"})`, 280),
    summary: clip(
      [
        `Crash ID: ${crashId}`,
        `Thread: ${thread}`,
        `Memory: ${field(m, "Memory")}`,
        `Stack:\n${field(m, "Stack Trace")}`,
        `Recent activity:\n${field(m, "Recent Activity")}`,
        "Symbolicate against the matching THGLApp build (memory reference_thglapp_crash_symbolication); the Crash ID's offsets shift between versions, so one bug can appear under several IDs.",
      ].join("\n"),
      7900,
    ),
    sourceUrl: m.url,
    priority: 2,
    detail: `${version} · ${game ?? "no game"} · ${field(m, "OS")} · ${m.url}`,
    data: { crashId, version, game, thread },
  };
}

export function snapshotBody(m: Message): IngestBody | null {
  const embed = m.embeds[0];
  if (embed?.title !== "Debug Snapshot") return null;
  const reporter = field(m, "Discord");
  const game = field(m, "Game");
  const context = (embed.description ?? "").replace(/^\*\*User Context:\*\*\s*/, "");
  const files = [...m.attachments.values()].map((a) => `${a.name}: ${a.url}`);
  return {
    fingerprint: `snapshot:${m.id}`,
    source: "debug_snapshot",
    appId: null,
    title: clip(`Debug snapshot from ${reporter || "unknown"}${game ? ` (${game})` : ""}`, 280),
    summary: clip(
      [
        `User context: ${context || "(none)"}`,
        `Version: ${field(m, "Version")}`,
        `Security: ${field(m, "Security")}`,
        `Files:\n${files.join("\n")}`,
        "Usually belongs to a support ticket from the same user: find it, analyse the snapshot there (memory feedback_support_ticket_read_snapshot) and close this item with the ticket.",
      ].join("\n"),
      7900,
    ),
    sourceUrl: m.url,
    priority: 2,
    data: { reporter, game },
  };
}

// --------------------------------------------------------------------------
// Tickets + forum
// --------------------------------------------------------------------------

function ticketOpenBody(m: Message, thread: AnyThreadChannel): IngestBody | null {
  const embed = m.embeds[0];
  const userId = parseTicketMarker(embed?.footer?.text);
  if (!embed || !userId) return null;
  const game = field(m, "Game / App");
  return {
    fingerprint: `ticket:${thread.id}`,
    source: "ticket",
    appId: null,
    title: clip(`Ticket: ${embed.title ?? thread.name}`, 280),
    summary: clip(
      `${embed.description ?? ""}\n\nGame / App: ${game || "?"}\nReporter: <@${userId}> (${thread.name})\nWork it with the discord-bug-feed skill; reply as the bot per ship-and-announce §6.`,
      7900,
    ),
    sourceUrl: thread.url,
    priority: 3,
    data: { threadId: thread.id, userId, game },
  };
}

function forumBody(thread: AnyThreadChannel, starter: Message | null): IngestBody {
  const tagNames = thread.appliedTags
    .map((id) => thread.parent?.type === ChannelType.GuildForum
      ? thread.parent.availableTags.find((t) => t.id === id)?.name
      : undefined)
    .filter((n): n is string => !!n);
  const content = starter?.content ?? "";
  const meta = getSuggestionMeta({
    threadId: thread.id,
    title: thread.name,
    content,
    appliedTagNames: tagNames,
  });
  return {
    fingerprint: `forum:${thread.id}`,
    source: meta.category === "bug" ? "bug_post" : meta.category,
    appId: meta.games[0] ?? null,
    title: clip(`${meta.category === "bug" ? "Bug" : meta.category === "question" ? "Question" : "Suggestion"}: ${thread.name}`, 280),
    summary: clip(`${content}\n\nGames: ${meta.games.join(", ") || "?"}`, 7900),
    sourceUrl: thread.url,
    priority: meta.category === "bug" ? 2 : meta.category === "question" ? 1 : 0,
    data: { threadId: thread.id, games: meta.games, category: meta.category },
  };
}

const isStaff = (m: Message) =>
  !!TICKET_STAFF_ROLE_ID && (m.member?.roles.cache.has(TICKET_STAFF_ROLE_ID) ?? false);

async function onMessage(m: Message) {
  // #app-debug: webhook posts from THGLApp.
  if (m.channelId === APP_DEBUG_CHANNEL_ID) {
    const body = crashBody(m) ?? snapshotBody(m);
    if (body) await ingest(body);
    return;
  }
  if (!m.channel.isThread()) return;
  const thread = m.channel;

  if (TICKET_CHANNEL_ID && thread.parentId === TICKET_CHANNEL_ID) {
    if (m.author.id === m.client.user.id) {
      const body = ticketOpenBody(m, thread);
      if (body) await ingest(body);
      return;
    }
    if (m.author.bot || isStaff(m) || !m.content.trim()) return;
    // A reporter reply: new information, reopens an item waiting on them.
    await ingest({
      fingerprint: `ticket:${thread.id}`,
      source: "ticket",
      title: `Ticket: ${thread.name}`,
      sourceUrl: thread.url,
      priority: 3,
      detail: clip(`${m.author.username}: ${m.content}`, 7900),
    });
    return;
  }

  if (thread.parentId === SUGGESTIONS_ISSUES_CHANNEL.id) {
    if (m.author.bot) return;
    if (m.id === thread.id) {
      await ingest(forumBody(thread, m));
      return;
    }
    if (isStaff(m) || !m.content.trim()) return;
    await ingest({
      ...forumBody(thread, null),
      summary: null,
      detail: clip(`${m.author.username}: ${m.content}`, 7900),
    });
  }
}

/** Startup backfill: every open ticket and the recent forum posts, ifNew. */
async function backfill(client: Client) {
  try {
    if (TICKET_CHANNEL_ID) {
      const ch = await client.channels.fetch(TICKET_CHANNEL_ID);
      if (ch && "threads" in ch) {
        const active = await ch.threads.fetchActive();
        for (const thread of active.threads.values()) {
          const first = (await thread.messages.fetch({ limit: 1, after: "0" })).first();
          const body = first ? ticketOpenBody(first, thread) : null;
          if (body) await ingest({ ...body, ifNew: true });
        }
      }
    }
    const forum = await client.channels.fetch(SUGGESTIONS_ISSUES_CHANNEL.id);
    if (forum?.type === ChannelType.GuildForum) {
      const active = await forum.threads.fetchActive();
      for (const thread of active.threads.values()) {
        if (thread.parentId !== forum.id) continue;
        const starter = await thread.fetchStarterMessage().catch(() => null);
        await ingest({ ...forumBody(thread, starter), ifNew: true });
      }
    }
    console.log("[inbox] backfill done");
  } catch (err) {
    console.warn("[inbox] backfill failed:", err);
  }
}

export function registerInboxSync(client: Client) {
  if (!INBOX_TOKEN) {
    console.log("[inbox] INBOX_TOKEN not set - inbox sync disabled");
    return;
  }
  client.on(Events.MessageCreate, (m) => {
    void onMessage(m).catch((err) => console.warn("[inbox] message handler failed:", err));
  });
  void backfill(client);
  console.log(`[inbox] syncing to ${INBOX_API_URL}`);
}
