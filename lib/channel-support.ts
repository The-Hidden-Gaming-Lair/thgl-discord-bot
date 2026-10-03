// Game-channel support (Leon 2026-10-01): the inbox agent also answers players in the game
// channels ("Apps & Games" / "More Games"), not only in tickets and the forum. This module
// only DETECTS who may need help and hands it to the api-forge inbox; the agent session
// (work-inbox skill, source `channel_message`) decides per message: answer directly, link an
// existing forum post, open a forum post on the player's behalf, point to a private ticket,
// or stay silent for plain chat.
//
//   - Scope: only channels that belong to a THGL game (canonical games feed) plus our own
//     #thgl-companion-app / #other-games. Channels of other products in the same categories
//     (#palia-tracker = paliatracker.com, #diablo-iv-companion …) are never answered.
//   - Candidates: messages from members (not bots / staff) that look like a question, a bug
//     report or a request (`looksLikeSupport`), plus every reply to the bot and every message
//     that mentions it (the player is talking to us).
//   - Debounce: a channel's candidates are held until it has been quiet for QUIET_MS, so a
//     conversation lands as ONE item and a person gets the chance to answer first. A staff
//     reply to a candidate (reply or @mention of its author) drops it.
//   - One inbox item per channel (fingerprint channel:<channelId>): new candidates count up on
//     an open item and reopen a closed one; each flush's messages are in that occurrence's
//     detail, the newest batch also in `data.messages`.
// Pending batches live in memory only: a restart drops what was not flushed yet (at most
// QUIET_MS of messages). Inert without INBOX_TOKEN.

import {
  ChannelType,
  Events,
  type Client,
  type Message,
  type TextChannel,
} from "discord.js";
import { TICKET_STAFF_ROLE_ID } from "./channels";
import { getCanonicalGames } from "./games-feed";
import {
  APPS_AND_GAMES_CATEGORY,
  channelKey,
  expectedChannelKey,
  MORE_GAMES_CATEGORY,
} from "./games-provision";
import { ingest, inboxEnabled } from "./inbox-sync";

export const QUIET_MS = Number(process.env.CHANNEL_SUPPORT_QUIET_MS) || 10 * 60 * 1000;
/** A flood guard: at most this many candidates per batch (the agent reads the channel anyway). */
const MAX_BATCH = 15;

const GAME_CATEGORIES = new Set([APPS_AND_GAMES_CATEGORY, MORE_GAMES_CATEGORY]);

// Words that mark a request for help, a bug or a feature wish. English first (most of the
// server), plus the most common German / French / Spanish / Portuguese forms. Tuned on 176
// real messages from #palia-map and #thgl-companion-app (2026-10-01): generic words alone
// ("problem", "fix", "overlay") matched chatter, so they only count in a phrase.
const SUPPORT_WORDS = new RegExp(
  [
    String.raw`\b(bug|bugged|glitch(ed|y)?|broken|crash(es|ed|ing)?\b(?! out)|error|freez(e|es|ing)|stutter(s|ing)?)\b`,
    String.raw`\b(not|isn'?t|aren'?t|doesn'?t|don'?t|won'?t|can'?t|cannot|couldn'?t|never|no longer|stopped) (work|working|show|showing|load|loading|open|opening|start|starting|launch|launching|appear|appearing|detect|detecting|track|tracking|update|updating|going|go|respond|responding)\b`,
    String.raw`\b(is|are|seems?|still|now) (missing|wrong|incorrect|inaccurate|outdated|gone|blank|black|down|stuck)\b`,
    // Missing map content without "is/are" ("new map missing the new collectible X", 2026-10-02):
    // only next to a map word, so "missing you all" / "missing one piece" stay chat.
    String.raw`\b(map|maps|marker|markers|icon|icons|filter|filters|pins?)\b[^.?!\n]{0,40}\bmissing\b`,
    String.raw`\bmissing\b[^.?!\n]{0,40}\b(on|from|in) the (map|app|overlay)\b`,
    String.raw`\b(not|isn'?t|aren'?t) (yet )?(on|in) the (map|app|overlay)\b`,
    String.raw`\bno (marker|icon|filter|pin)s? (for|at)\b`,
    String.raw`\b(how (do|can|to|does)|where (is|are|do|can)|is there (a|any)|any(one|body) know|any (fix|idea|way))\b`,
    String.raw`\b(need help|help me|having (an?|the|this|same|some) (issue|problem|trouble)|an? (issue|problem) with)\b`,
    String.raw`\b(suggestion|feature request|would be (nice|great|cool|awesome)|please add|could you add|can you add|will there be)\b`,
    String.raw`\b(funktioniert nicht|geht nicht|fehlt|fehler|hilfe|ne marche pas|ne fonctionne pas|no funciona|não funciona|ayuda|ajuda)\b`,
  ].join("|"),
  "i",
);

const THANKS =
  /^(thanks?|thank you|ty|tysm|thx|ok(ay)?|oh|ah|yes|yeah|yep|no|nope|lol|lmao|haha|same|glad|great|nice|awesome|perfect)\b/i;

/** True when a member's message looks like it needs an answer from us. Pure, for tests. */
export function looksLikeSupport(text: string): boolean {
  const t = text
    .replace(/<a?:\w+:\d+>/g, " ") // custom emoji
    .replace(/https?:\/\/\S+/g, " ")
    .trim();
  if (t.length < 12) return false; // "lol", "ty", "same here"
  if (t.split(/\s+/).length < 4) return false;
  if (THANKS.test(t) && !t.includes("?")) return false; // "thank you! This worked!", "glad im not the problem lol"
  return SUPPORT_WORDS.test(t) || (t.includes("?") && t.split(/\s+/).length >= 5);
}

type Candidate = {
  id: string;
  userId: string;
  username: string;
  content: string;
  url: string;
  at: number;
  toBot: boolean;
  attachments: number;
};

type Batch = { channel: TextChannel; messages: Candidate[]; timer?: ReturnType<typeof setTimeout> };
const pending = new Map<string, Batch>();

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const isStaff = (m: Message) =>
  !!TICKET_STAFF_ROLE_ID && (m.member?.roles.cache.has(TICKET_STAFF_ROLE_ID) ?? false);

function isGameChannel(m: Message): m is Message<true> & { channel: TextChannel } {
  return (
    m.inGuild() &&
    m.channel.type === ChannelType.GuildText &&
    !!m.channel.parent &&
    GAME_CATEGORIES.has(m.channel.parent.name)
  );
}

/**
 * THGL's own channels that belong to no single game. Every other watched channel must map to a
 * THGL game: the game categories also hold channels for OTHER products (#palia-tracker is
 * paliatracker.com, #diablo-iv-companion is not our Diablo IV map, #new-world-companion), where
 * an answer about our apps would be wrong (Leon 2026-10-02).
 */
const OWN_NON_GAME_CHANNELS = new Set(["thgl-companion-app", "other-games"]);

/**
 * "skip" for a channel we must not answer in, the game id for a game channel, null for our own
 * non-game channels. Exported for tests.
 */
export function channelScope(
  channelName: string,
  games: { id: string; discordId: string }[],
): string | null | "skip" {
  const key = channelKey(channelName);
  if (OWN_NON_GAME_CHANNELS.has(key)) return null;
  return games.find((g) => expectedChannelKey(g.discordId) === key)?.id ?? "skip";
}

async function scopeFor(channel: TextChannel): Promise<string | null | "skip"> {
  // getCanonicalGames falls back to the bundled list when the feed is down.
  return channelScope(channel.name, await getCanonicalGames().catch(() => []));
}

/** The ingest body for one flushed batch. Exported for tests. */
export function batchBody(
  channel: { id: string; name: string; url: string },
  appId: string | null,
  messages: Candidate[],
) {
  const lines = messages.map(
    (c) =>
      `[${c.id}] ${c.username} (<@${c.userId}>)${c.toBot ? " → bot" : ""}: ${clip(c.content.replace(/\s+/g, " "), 600)}` +
      `${c.attachments ? ` [+${c.attachments} attachment(s)]` : ""} ${c.url}`,
  );
  return {
    fingerprint: `channel:${channel.id}`,
    source: "channel_message",
    appId,
    title: clip(`#${channel.name}: player messages that may need an answer`, 280),
    summary: clip(
      [
        `Game channel #${channel.name} (${channel.id}). Members asked for help, reported a bug or wished for a feature.`,
        "Work it with the work-inbox skill, source channel_message (references/game-channel-support.md): read the channel around these messages, then per message answer / link the existing forum post / open a forum post for them / send them to a ticket / stay silent.",
        `Latest batch:\n${lines.join("\n")}`,
      ].join("\n\n"),
      7900,
    ),
    sourceUrl: messages[0]?.url ?? channel.url,
    priority: messages.some((c) => c.toBot) ? 3 : 2,
    detail: clip(lines.join("\n"), 7900),
    data: {
      channelId: channel.id,
      channelName: channel.name,
      messages: messages.map(({ id, userId, username, url }) => ({ id, userId, username, url })),
    },
  };
}

async function flush(channelId: string) {
  const batch = pending.get(channelId);
  pending.delete(channelId);
  if (!batch?.messages.length) return;
  const { channel, messages } = batch;
  const scope = await scopeFor(channel);
  if (scope === "skip") return;
  await ingest(batchBody(channel, scope, messages));
  console.log(`[channel-support] #${channel.name}: ${messages.length} message(s) → inbox`);
}

function schedule(batch: Batch) {
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => void flush(batch.channel.id).catch(warn), QUIET_MS);
}

const warn = (err: unknown) => console.warn("[channel-support] failed:", err);

async function onMessage(m: Message) {
  if (!isGameChannel(m)) return;
  const batch = pending.get(m.channelId);

  if (m.author.bot || m.webhookId || isStaff(m)) {
    // Someone from the team answered: drop what they replied to or whose author they pinged.
    if (!batch) return;
    const repliedTo = m.reference?.messageId;
    const pinged = new Set(m.mentions.users.keys());
    batch.messages = batch.messages.filter((c) => c.id !== repliedTo && !pinged.has(c.userId));
    if (!batch.messages.length) {
      if (batch.timer) clearTimeout(batch.timer);
      pending.delete(m.channelId);
    }
    return;
  }

  const botId = m.client.user.id;
  const toBot = m.mentions.repliedUser?.id === botId || m.mentions.users.has(botId);
  const text = m.content ?? "";
  // A reply to another member is a conversation (often a helper answering); the agent reads
  // the channel around every candidate anyway.
  const repliedUser = m.mentions.repliedUser;
  const toMember = !!repliedUser && !repliedUser.bot && repliedUser.id !== m.author.id;
  if (!toBot && (toMember || !looksLikeSupport(text))) return;
  // Not ours to answer: another product's channel (#palia-tracker, #diablo-iv-companion …).
  if ((await scopeFor(m.channel)) === "skip") return;
  if (!text.trim() && !m.attachments.size) return;

  const b: Batch = batch ?? { channel: m.channel, messages: [] };
  if (b.messages.length < MAX_BATCH) {
    b.messages.push({
      id: m.id,
      userId: m.author.id,
      username: m.author.username,
      content: text,
      url: m.url,
      at: m.createdTimestamp,
      toBot,
      attachments: m.attachments.size,
    });
  }
  pending.set(m.channelId, b);
  schedule(b);
}

export function registerChannelSupport(client: Client) {
  if (!inboxEnabled()) return;
  client.on(Events.MessageCreate, (m) => void onMessage(m).catch(warn));
  console.log(`[channel-support] watching game channels (quiet ${QUIET_MS / 60000} min)`);
}
