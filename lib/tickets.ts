// Ticket system core. Design: docs/superpowers/specs/2026-08-27-ticket-system-design.md
// A ticket is a private thread in TICKET_CHANNEL_ID, one per user, matched by a
// `user:<id>` marker in the first bot message's embed footer. Discord is the
// only data store: OPEN ⇔ thread not archived. Thread names are just the username
// and are never renamed.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ThreadAutoArchiveDuration,
  type AnyThreadChannel,
  type Channel,
  type TextChannel,
} from "discord.js";
import { getClient } from "./discord";
import {
  TICKET_CHANNEL_ID,
  TICKET_LOG_CHANNEL_ID,
  TICKET_STAFF_ROLE_ID,
} from "./channels";
import { GAME_CONFIGS } from "./game-roles";
export const TICKET_WARNING_FOOTER = "thgl:ticket:warning";
export const TICKET_BUTTON_OPEN = "thgl:ticket:open";
export const TICKET_BUTTON_CLOSE = "thgl:ticket:close";
export const TICKET_MODAL_ID = "thgl:ticket:modal";

// Rejects <@mentions> (word boundary fails on "@"), non-digit suffixes, and
// anything shorter than 15 or longer than 21 digits (snowflake range).
const TICKET_MARKER_RE = /\buser:(\d{15,21})\b/;

export function formatTicketMarker(userId: string) {
  return `user:${userId}`;
}

export function parseTicketMarker(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  const match = text.match(TICKET_MARKER_RE);
  return match ? match[1] : null;
}

/** Thread name for a user's ticket — just the username, capped at Discord's 100 chars. */
export function ticketThreadName(username: string): string {
  return username.slice(0, 100);
}

export type InactivityAction = "none" | "warn" | "close";

export function computeInactivityAction(opts: {
  lastActivityMs: number;
  warned: boolean;
  nowMs: number;
  warnAfterMs: number;
  closeAfterMs: number;
}): InactivityAction {
  const idle = opts.nowMs - opts.lastActivityMs;
  if (opts.warned) {
    return idle > opts.closeAfterMs ? "close" : "none";
  }
  return idle > opts.warnAfterMs ? "warn" : "none";
}

export function isWarningMessage(message: {
  author: { bot: boolean };
  embeds: { footer?: { text?: string } | null }[];
}): boolean {
  return (
    message.author.bot &&
    message.embeds.some((embed) => embed.footer?.text === TICKET_WARNING_FOOTER)
  );
}

/**
 * Derive last activity + warned state from a thread's newest messages
 * (newest first). The bot's warning embed does not count as activity —
 * otherwise posting the warning would reset the clock and nothing would
 * ever auto-close.
 */
export function deriveActivity(
  messagesNewestFirst: { createdTimestamp: number; isWarning: boolean }[],
  fallbackMs: number,
): { lastActivityMs: number; warned: boolean } {
  const newest = messagesNewestFirst[0];
  const lastReal = messagesNewestFirst.find((message) => !message.isWarning);
  return {
    lastActivityMs: lastReal?.createdTimestamp ?? fallbackMs,
    warned: newest?.isWarning ?? false,
  };
}

// --- Game embed colors (staff idea approved 2026-08-29: color-code ticket
// embeds by game so the log channel is scannable at a glance) ---

export const TICKET_DEFAULT_COLOR = 0x57f287;

/** Match the free-text Game/App input to a known game slug via titleKeywords. */
export function matchGameSlug(gameText: string): string | null {
  const text = gameText.toLowerCase().trim();
  if (!text) {
    return null;
  }
  for (const config of GAME_CONFIGS) {
    const keywords = [config.name, ...(config.titleKeywords ?? [])];
    for (const keyword of keywords) {
      const k = keyword.toLowerCase();
      // Containment either way, but only for reasonably specific inputs —
      // otherwise short texts like "a" would match everything.
      if (text.includes(k) || (text.length >= 4 && k.includes(text))) {
        return config.name;
      }
    }
  }
  return null;
}

function hslToRgbInt(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  const to255 = (v: number) => Math.round((v + m) * 255);
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

/**
 * Stable per-game embed color: same game text (matched via titleKeywords,
 * else the raw text) always hashes to the same hue. No game given → default.
 */
export function gameColor(gameText: string | undefined | null): number {
  const text = gameText?.trim();
  if (!text) {
    return TICKET_DEFAULT_COLOR;
  }
  const key = matchGameSlug(text) ?? text.toLowerCase();
  // FNV-1a
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  return hslToRgbInt(hue, 0.65, 0.55);
}

// --- Discord-client-bound operations ---

export function getTicketParentChannel(): TextChannel {
  const client = getClient();
  const channel = client.channels.cache.get(TICKET_CHANNEL_ID);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(
      `Ticket channel ${TICKET_CHANNEL_ID || "(unset)"} is not a guild text channel`,
    );
  }
  return channel;
}

export function isTicketThread(
  channel: Channel | null,
): channel is AnyThreadChannel {
  return (
    Boolean(TICKET_CHANNEL_ID) &&
    channel !== null &&
    channel.isThread() &&
    channel.parentId === TICKET_CHANNEL_ID
  );
}

const INDEX_TTL_MS = 5 * 60 * 1000;
// threadId -> owner userId (null = thread has no marker; not a ticket thread).
// Immutable once known, so it survives index refreshes without refetching.
const threadOwners = new Map<string, string | null>();
let userToThread: Map<string, string> | null = null;
let indexBuiltAt = 0;
let indexPromise: Promise<Map<string, string>> | null = null;

async function getThreadOwner(thread: AnyThreadChannel): Promise<string | null> {
  const cached = threadOwners.get(thread.id);
  if (cached !== undefined) {
    return cached;
  }
  // First message in the thread is the bot's ticket embed; its footer holds the marker.
  const messages = await thread.messages.fetch({ after: "0", limit: 1 });
  const first = messages.first();
  const owner =
    parseTicketMarker(first?.embeds[0]?.footer?.text) ??
    parseTicketMarker(first?.content);
  if (!threadOwners.has(thread.id)) {
    threadOwners.set(thread.id, owner);
  }
  return threadOwners.get(thread.id) ?? owner;
}

async function buildIndex(): Promise<Map<string, string>> {
  const channel = getTicketParentChannel();
  const threads: AnyThreadChannel[] = [];

  const active = await channel.threads.fetchActive();
  threads.push(...active.threads.values());

  // Private archived threads: GET /threads/archived/private, needs ManageThreads.
  let before: Date | undefined;
  while (true) {
    const batch = await channel.threads.fetchArchived({
      type: "private",
      fetchAll: true,
      limit: 100,
      before,
    });
    threads.push(...batch.threads.values());
    if (!batch.hasMore || batch.threads.size === 0) {
      break;
    }
    const oldest = [...batch.threads.values()].at(-1);
    before = oldest?.archivedAt ?? undefined;
    if (!before) {
      break;
    }
  }

  // Active threads were added first, so on (unexpected) duplicates per user
  // the open thread wins over archived ones.
  const map = new Map<string, string>();
  for (const thread of threads) {
    if (thread.parentId !== TICKET_CHANNEL_ID) {
      continue;
    }
    const owner = await getThreadOwner(thread).catch(() => null);
    if (owner && !map.has(owner)) {
      map.set(owner, thread.id);
    }
  }
  return map;
}

export async function findTicketThread(
  userId: string,
): Promise<AnyThreadChannel | null> {
  if (!userToThread || Date.now() - indexBuiltAt > INDEX_TTL_MS) {
    indexPromise ??= buildIndex();
    try {
      userToThread = await indexPromise;
      indexBuiltAt = Date.now();
    } finally {
      indexPromise = null;
    }
  }
  const threadId = userToThread.get(userId);
  if (!threadId) {
    return null;
  }
  const channel = await getClient()
    .channels.fetch(threadId)
    .catch(() => null);
  if (!channel || !channel.isThread()) {
    userToThread.delete(userId);
    threadOwners.delete(threadId);
    return null;
  }
  return channel;
}

export function registerTicketThread(userId: string, threadId: string) {
  threadOwners.set(threadId, userId);
  userToThread?.set(userId, threadId);
}

export function forgetTicketThread(threadId: string) {
  threadOwners.delete(threadId);
  if (userToThread) {
    for (const [userId, id] of userToThread) {
      if (id === threadId) {
        userToThread.delete(userId);
      }
    }
  }
}

// Threads the bot itself is unarchiving (panel reopen) — lets the ThreadUpdate
// listener ignore them and react only to user-driven unarchives.
const botUnarchives = new Set<string>();

export function markBotUnarchive(threadId: string) {
  botUnarchives.add(threadId);
  setTimeout(() => botUnarchives.delete(threadId), 30_000);
}

export function consumeBotUnarchive(threadId: string): boolean {
  return botUnarchives.delete(threadId);
}

export type TicketInput = {
  userId: string;
  username: string;
  subject: string;
  description: string;
  game?: string;
};

function buildTicketEmbed(input: TicketInput): EmbedBuilder {
  const embed = new EmbedBuilder()
    // Discord's "required" modal fields accept whitespace-only input; an
    // empty embed title/description would throw on send.
    .setTitle(input.subject.slice(0, 256) || "Support ticket")
    .setDescription(input.description.slice(0, 4000) || "*(no description)*")
    .setColor(gameColor(input.game))
    .setFooter({ text: formatTicketMarker(input.userId) })
    .setTimestamp();
  if (input.game) {
    embed.addFields({ name: "Game / App", value: input.game.slice(0, 1024) });
  }
  return embed;
}

export function buildCloseRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_BUTTON_CLOSE)
      .setLabel("Close ticket")
      .setEmoji("🔒")
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildClosedEmbed(closedBy: string): EmbedBuilder {
  return new EmbedBuilder()
    .setDescription(
      `Ticket closed by ${closedBy}. Reply here or use the panel to open it again.`,
    )
    .setColor(0xed4245)
    .setTimestamp();
}

async function sendTicketMessages(thread: AnyThreadChannel, input: TicketInput) {
  // The opener mention adds them to the private thread; the staff-role
  // mention adds AND notifies the whole team. Owner decision 2026-08-29:
  // pings are back — silent one-by-one member adds notified staff anyway,
  // and whoever dislikes pings can mute the panel channel.
  await thread.send({
    content: `<@${input.userId}>`,
    embeds: [buildTicketEmbed(input)],
    components: [buildCloseRow()],
  });
  await thread.send({ content: `<@&${TICKET_STAFF_ROLE_ID}>` });
}

export type OpenTicketResult = {
  status: "created" | "reopened" | "appended";
  thread: AnyThreadChannel;
};

// Serialize opens per user: two racing modal submits (double-fire, second
// device) would otherwise both see "no thread" and create duplicate threads.
// The later call waits, then lands in the append/reopen path of the first.
const inFlightOpens = new Map<string, Promise<OpenTicketResult>>();

export function openTicket(input: TicketInput): Promise<OpenTicketResult> {
  const prior = inFlightOpens.get(input.userId) ?? Promise.resolve();
  const run = prior
    .catch(() => {/* prior failure doesn't block this attempt */})
    .then(() => doOpenTicket(input));
  inFlightOpens.set(input.userId, run);
  run.finally(() => {
    if (inFlightOpens.get(input.userId) === run) {
      inFlightOpens.delete(input.userId);
    }
  });
  return run;
}

async function doOpenTicket(input: TicketInput): Promise<OpenTicketResult> {
  const existing = await findTicketThread(input.userId);

  if (existing && !existing.archived) {
    // Already open: append the new modal answers instead of rejecting them.
    await existing.send({
      content: `<@${input.userId}>`,
      embeds: [buildTicketEmbed(input)],
      components: [buildCloseRow()],
    });
    await logTicketEvent("Appended", {
      userId: input.userId,
      subject: input.subject,
      threadId: existing.id,
      detail: input.game ? `Game: ${input.game}` : undefined,
      color: input.game ? gameColor(input.game) : undefined,
    });
    return { status: "appended", thread: existing };
  }

  if (existing) {
    markBotUnarchive(existing.id);
    await existing.setArchived(false);
    await sendTicketMessages(existing, input);
    await logTicketEvent("Reopened", {
      userId: input.userId,
      subject: input.subject,
      threadId: existing.id,
      detail: input.game ? `Game: ${input.game}` : undefined,
      color: input.game ? gameColor(input.game) : undefined,
    });
    return { status: "reopened", thread: existing };
  }

  const channel = getTicketParentChannel();
  const thread = await channel.threads.create({
    name: ticketThreadName(input.username),
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `Ticket for ${input.username}`,
  });
  // Register before sending: if the sends fail, the user's retry finds this
  // thread via the index and converges on it instead of creating a duplicate.
  registerTicketThread(input.userId, thread.id);
  await sendTicketMessages(thread, input);
  await logTicketEvent("Opened", {
    userId: input.userId,
    subject: input.subject,
    threadId: thread.id,
    detail: input.game ? `Game: ${input.game}` : undefined,
      color: input.game ? gameColor(input.game) : undefined,
  });
  return { status: "created", thread };
}

/** Archive the thread (the only state transition — names are never touched). */
export async function archiveTicketThread(
  thread: AnyThreadChannel,
  opts: { closedBy: string },
) {
  await thread
    .setArchived(true)
    .catch((err) => console.error("[tickets] archive failed", err));
  await logTicketEvent("Closed", {
    threadId: thread.id,
    detail: `Closed by ${opts.closedBy}`,
  });
}

export async function logTicketEvent(
  event: "Opened" | "Reopened" | "Appended" | "Closed" | "Thread deleted",
  opts: {
    userId?: string;
    subject?: string;
    threadId?: string;
    detail?: string;
    color?: number;
  },
) {
  if (!TICKET_LOG_CHANNEL_ID) {
    return;
  }
  try {
    const channel = getClient().channels.cache.get(TICKET_LOG_CHANNEL_ID);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      return;
    }
    const lines = [
      opts.userId ? `User: <@${opts.userId}>` : null,
      opts.subject ? `Subject: ${opts.subject.slice(0, 200)}` : null,
      opts.threadId ? `Thread: <#${opts.threadId}>` : null,
      opts.detail ?? null,
    ].filter(Boolean);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Ticket ${event.toLowerCase()}`)
          .setDescription(lines.join("\n") || null)
          .setColor(opts.color ?? 0x5865f2)
          .setTimestamp(),
      ],
    });
  } catch (err) {
    // Logging must never break ticket operations.
    console.error("[tickets] log failed", err);
  }
}
