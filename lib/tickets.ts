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
  type Guild,
  type TextChannel,
} from "discord.js";
import { getClient } from "./discord";
import {
  TICKET_CHANNEL_ID,
  TICKET_LOG_CHANNEL_ID,
  TICKET_STAFF_ROLE_ID,
  TICKET_STAFF_USER_IDS,
} from "./channels";
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
    .setColor(0x57f287)
    .setFooter({ text: formatTicketMarker(input.userId) })
    .setTimestamp();
  if (input.game) {
    embed.addFields({ name: "Game / App", value: input.game.slice(0, 1024) });
  }
  return embed;
}

function buildCloseRow(): ActionRowBuilder<ButtonBuilder> {
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

const STAFF_CACHE_TTL_MS = 5 * 60 * 1000;
let staffCache: { at: number; ids: string[] } | null = null;

async function getStaffMemberIds(guild: Guild): Promise<string[]> {
  if (staffCache && Date.now() - staffCache.at < STAFF_CACHE_TTL_MS) {
    return staffCache.ids;
  }
  const ids: string[] = [];
  for (const id of TICKET_STAFF_USER_IDS) {
    // Single-member fetch needs no privileged intent. `force` bypasses the
    // cache, which wouldn't see role changes without the GuildMembers intent.
    const member = await guild.members
      .fetch({ user: id, force: true })
      .catch(() => null);
    if (
      member &&
      !member.user.bot &&
      member.roles.cache.has(TICKET_STAFF_ROLE_ID)
    ) {
      ids.push(id);
    }
  }
  staffCache = { at: Date.now(), ids };
  return ids;
}

/**
 * Silently add every configured staff member (re-verified against the staff
 * role) to the thread. Unlike a role mention this sends no ping (owner
 * decision 2026-08-27: no pings) — the thread just appears in each staff
 * member's thread list.
 */
async function addStaffToThread(thread: AnyThreadChannel) {
  try {
    const ids = await getStaffMemberIds(thread.guild);
    for (const id of ids) {
      await thread.members
        .add(id)
        .catch(() => {/* individual add failure is non-fatal */});
    }
  } catch (err) {
    console.error("[tickets] adding staff to thread failed", err);
  }
}

async function sendTicketMessages(thread: AnyThreadChannel, input: TicketInput) {
  // The opener mention adds them to the private thread; staff are added
  // silently afterwards (addStaffToThread) — never via role mention, which
  // would ping.
  await thread.send({
    content: `<@${input.userId}>`,
    embeds: [buildTicketEmbed(input)],
    components: [buildCloseRow()],
  });
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
    });
    await logTicketEvent("Appended", {
      userId: input.userId,
      subject: input.subject,
      threadId: existing.id,
      detail: input.game ? `Game: ${input.game}` : undefined,
    });
    return { status: "appended", thread: existing };
  }

  if (existing) {
    markBotUnarchive(existing.id);
    await existing.setArchived(false);
    await sendTicketMessages(existing, input);
    await addStaffToThread(existing); // catches staff who joined the team since creation
    await logTicketEvent("Reopened", {
      userId: input.userId,
      subject: input.subject,
      threadId: existing.id,
      detail: input.game ? `Game: ${input.game}` : undefined,
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
  await addStaffToThread(thread);
  await logTicketEvent("Opened", {
    userId: input.userId,
    subject: input.subject,
    threadId: thread.id,
    detail: input.game ? `Game: ${input.game}` : undefined,
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
  opts: { userId?: string; subject?: string; threadId?: string; detail?: string },
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
          .setColor(0x5865f2)
          .setTimestamp(),
      ],
    });
  } catch (err) {
    // Logging must never break ticket operations.
    console.error("[tickets] log failed", err);
  }
}
