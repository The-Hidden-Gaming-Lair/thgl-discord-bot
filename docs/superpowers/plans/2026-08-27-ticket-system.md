# THGL Ticket System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MEE6 ticketing with a bot-native system: one persistent private thread per user, opened via panel button + modal, with staff auto-add, staff log channel, and inactivity auto-close — Phase 1 runs staff-only in new test channels; MEE6 stays untouched.

**Architecture:** Discord is the only data store (Approach A of the spec, `docs/superpowers/specs/2026-08-27-ticket-system-design.md`). A ticket = a private thread in the panel channel, matched to its user by a `user:<id>` marker in the first bot message's embed footer. OPEN ⇔ thread not archived; 🟢/🔴 name prefixes are best-effort cosmetics. No DB, no volume.

**Tech Stack:** Bun, TypeScript, discord.js 14.22.1 (already installed). No new dependencies.

**Owner workflow (overrides skill defaults):** Leon works directly on `main` and never wants commits/pushes without his explicit go-ahead. Before executing the first "Commit" step, ask Leon once whether per-task commits are OK; if not, skip all commit steps and let him commit at the end. Never push.

**Live-guild note:** `.env` contains the production `DISCORD_TOKEN`; scripts and a locally-run bot talk to the real THGL guild. That is intended (Phase 1 channels are staff-only). The production bot has no `thgl:ticket:*` handlers, so a locally running dev bot and the deployed bot do not conflict on interactions.

**One deliberate deviation from the spec:** the spec's Open flow checks for an existing open ticket *before* showing the modal. Interactions must be answered within 3 seconds and `showModal` cannot follow a deferral, but a cold user→thread index build can exceed 3 s. So the button *always* shows the modal immediately, and the already-open check happens in the modal-submit handler (which can defer). If the user already has an open ticket, their modal answers are appended to that thread as a new message (status `"appended"`) — no input is lost.

---

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| `lib/channels.ts` | Modify (append) | Ticket channel/role ID constants |
| `lib/tickets.ts` | Create | Pure helpers (markers, names, inactivity math) + core ops (index, open/append/reopen, archive, log) |
| `lib/ticket-interactions.ts` | Create | `InteractionCreate` router, modal, reopen-by-reply, `ThreadDelete` logging |
| `lib/ticket-scheduler.ts` | Create | Inactivity warn/auto-close loop |
| `scripts/test-tickets.ts` | Create | Assertion tests for the pure helpers (no token needed) |
| `scripts/setup-ticket-channels.ts` | Create | Idempotent creation of staff-only test + log channels |
| `scripts/publish-ticket-panel.ts` | Create | Post/update the panel message with the Open-ticket button |
| `index.ts` | Modify | Wire listeners + scheduler |
| `README.md`, `CLAUDE.md` | Modify | Env table + architecture note |

---

### Task 1: Ticket configuration constants

**Files:**
- Modify: `lib/channels.ts` (append at end, after `INFO_CHANNELS`)

- [ ] **Step 1: Append the ticket constants**

```ts
// --- Ticket system (docs/superpowers/specs/2026-08-27-ticket-system-design.md) ---
// Staff/moderator role auto-added (via role mention) to every ticket thread.
export const TICKET_STAFF_ROLE_ID = "1173945621963604069";
// Text channel hosting the ticket panel + private ticket threads.
// Empty = ticket system inert. Phase 1: staff-only test channel (setup script
// prints the id); Phase 2 cutover: 1092316764081225788 (📕・support-ticket).
export const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID ?? "";
// Staff-only channel receiving one embed per ticket event. Empty = logging off.
export const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID ?? "";
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Commit** *(only if Leon approved per-task commits — see header)*

```bash
git add lib/channels.ts
git commit -m "tickets: add channel/role config constants"
```

---

### Task 2: Pure ticket helpers (TDD)

**Files:**
- Create: `lib/tickets.ts` (pure part only — core ops come in Task 3)
- Test: `scripts/test-tickets.ts`

- [ ] **Step 1: Write the failing test file**

Create `scripts/test-tickets.ts`:

```ts
import assert from "node:assert/strict";
import {
  computeInactivityAction,
  deriveActivity,
  formatTicketMarker,
  isWarningMessage,
  parseTicketMarker,
  ticketNameWithState,
  ticketThreadName,
  TICKET_CLOSED_PREFIX,
  TICKET_OPEN_PREFIX,
  TICKET_WARNING_FOOTER,
} from "../lib/tickets";

// --- marker ---
assert.equal(formatTicketMarker("311400587445141504"), "user:311400587445141504");
assert.equal(parseTicketMarker("user:311400587445141504"), "311400587445141504");
assert.equal(
  parseTicketMarker("Ticket for user:311400587445141504 (staff only)"),
  "311400587445141504",
);
assert.equal(parseTicketMarker("<@311400587445141504>"), null); // mention is not a marker
assert.equal(parseTicketMarker("user:abc"), null);
assert.equal(parseTicketMarker(""), null);
assert.equal(parseTicketMarker(null), null);
assert.equal(parseTicketMarker(undefined), null);

// --- names ---
assert.equal(ticketThreadName("devleon", true), `${TICKET_OPEN_PREFIX}devleon`);
assert.equal(ticketThreadName("devleon", false), `${TICKET_CLOSED_PREFIX}devleon`);
assert.equal(ticketThreadName("x".repeat(200), true).length, 100); // Discord cap
assert.equal(
  ticketNameWithState(`${TICKET_OPEN_PREFIX}devleon`, false),
  `${TICKET_CLOSED_PREFIX}devleon`,
);
assert.equal(
  ticketNameWithState(`${TICKET_CLOSED_PREFIX}devleon`, true),
  `${TICKET_OPEN_PREFIX}devleon`,
);
assert.equal(
  ticketNameWithState("devleon", false), // manually renamed thread w/o prefix
  `${TICKET_CLOSED_PREFIX}devleon`,
);

// --- inactivity math (times in ms) ---
const HOUR = 3_600_000;
const base = { nowMs: 100 * HOUR, warnAfterMs: 10 * HOUR, closeAfterMs: 14 * HOUR };
// fresh activity -> nothing
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 95 * HOUR, warned: false }),
  "none",
);
// past warn threshold, not warned -> warn
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 89 * HOUR, warned: false }),
  "warn",
);
// past close threshold but never warned -> warn first, never silently close
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 80 * HOUR, warned: false }),
  "warn",
);
// warned but close threshold not reached -> none
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 89 * HOUR, warned: true }),
  "none",
);
// warned and past close threshold -> close
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 80 * HOUR, warned: true }),
  "close",
);

// --- warning detection ---
const warningMsg = {
  author: { bot: true },
  embeds: [{ footer: { text: TICKET_WARNING_FOOTER } }],
};
const normalBotMsg = { author: { bot: true }, embeds: [{ footer: { text: "user:1" } }] };
const userMsg = { author: { bot: false }, embeds: [] };
assert.equal(isWarningMessage(warningMsg), true);
assert.equal(isWarningMessage(normalBotMsg), false);
assert.equal(isWarningMessage(userMsg), false);

// --- deriveActivity: input is newest-first; warning embeds don't count as activity ---
// newest message is the warning -> warned, activity = message before it
const derived1 = deriveActivity(
  [
    { createdTimestamp: 90 * HOUR, isWarning: true },
    { createdTimestamp: 80 * HOUR, isWarning: false },
    { createdTimestamp: 70 * HOUR, isWarning: false },
  ],
  0,
);
assert.deepEqual(derived1, { lastActivityMs: 80 * HOUR, warned: true });
// user replied after a warning -> not warned anymore, clock reset
const derived2 = deriveActivity(
  [
    { createdTimestamp: 95 * HOUR, isWarning: false },
    { createdTimestamp: 90 * HOUR, isWarning: true },
  ],
  0,
);
assert.deepEqual(derived2, { lastActivityMs: 95 * HOUR, warned: false });
// no messages -> fallback (thread creation time), not warned
assert.deepEqual(deriveActivity([], 42), { lastActivityMs: 42, warned: false });

console.log("All ticket helper tests passed ✔");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run scripts/test-tickets.ts`
Expected: FAIL — `Cannot find module '../lib/tickets'` (or export resolution error).

- [ ] **Step 3: Create `lib/tickets.ts` with the pure helpers**

```ts
// Ticket system core. Design: docs/superpowers/specs/2026-08-27-ticket-system-design.md
// A ticket is a private thread in TICKET_CHANNEL_ID, one per user, matched by a
// `user:<id>` marker in the first bot message's embed footer. Discord is the
// only data store: OPEN ⇔ thread not archived. Name prefixes are cosmetics —
// thread renames are rate-limited (2/10 min), so correctness never depends on them.

export const TICKET_OPEN_PREFIX = "🟢│";
export const TICKET_CLOSED_PREFIX = "🔴│";
export const TICKET_WARNING_FOOTER = "thgl:ticket:warning";
export const TICKET_BUTTON_OPEN = "thgl:ticket:open";
export const TICKET_BUTTON_CLOSE = "thgl:ticket:close";
export const TICKET_MODAL_ID = "thgl:ticket:modal";

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

/** Re-prefix an existing thread name for the given open/closed state. */
export function ticketNameWithState(name: string, open: boolean): string {
  const base = name.replace(TICKET_OPEN_PREFIX, "").replace(TICKET_CLOSED_PREFIX, "");
  return ((open ? TICKET_OPEN_PREFIX : TICKET_CLOSED_PREFIX) + base).slice(0, 100);
}

export function ticketThreadName(username: string, open: boolean): string {
  return ticketNameWithState(username, open);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run scripts/test-tickets.ts`
Expected: `All ticket helper tests passed ✔`, exit 0.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 6: Commit** *(only if approved)*

```bash
git add lib/tickets.ts scripts/test-tickets.ts
git commit -m "tickets: pure helpers (markers, names, inactivity) with tests"
```

---

### Task 3: Ticket core operations (thread index, open/append/reopen, archive, log)

**Files:**
- Modify: `lib/tickets.ts` (append below the pure helpers from Task 2)

These functions touch the Discord client, so they are verified by typecheck here and live smoke tests in Task 10.

- [ ] **Step 1: Append imports at the top of `lib/tickets.ts`**

```ts
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
```

- [ ] **Step 2: Append channel/thread guards**

```ts
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
```

- [ ] **Step 3: Append the user→thread index**

```ts
const INDEX_TTL_MS = 5 * 60 * 1000;
// threadId -> owner userId (null = thread has no marker; not a ticket thread).
// Immutable once known, so it survives index refreshes without refetching.
const threadOwners = new Map<string, string | null>();
let userToThread: Map<string, string> | null = null;
let indexBuiltAt = 0;

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
  threadOwners.set(thread.id, owner);
  return owner;
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
    userToThread = await buildIndex();
    indexBuiltAt = Date.now();
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
```

- [ ] **Step 4: Append message builders**

```ts
export type TicketInput = {
  userId: string;
  username: string;
  subject: string;
  description: string;
  game?: string;
};

function buildTicketEmbed(input: TicketInput): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(input.subject.slice(0, 256))
    .setDescription(input.description.slice(0, 4000))
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
```

- [ ] **Step 5: Append open/append/reopen, archive, and log operations**

```ts
async function sendTicketMessages(thread: AnyThreadChannel, input: TicketInput) {
  // The opener mention adds them to the private thread; the role mention adds
  // and notifies every staff-role member who can view the parent channel.
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

export async function openTicket(input: TicketInput): Promise<OpenTicketResult> {
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
    });
    return { status: "appended", thread: existing };
  }

  if (existing) {
    await existing.setArchived(false);
    existing
      .setName(ticketNameWithState(existing.name, true))
      .catch(() => {/* rename is cosmetic; rate limit is fine */});
    await sendTicketMessages(existing, input);
    await logTicketEvent("Reopened", {
      userId: input.userId,
      subject: input.subject,
      threadId: existing.id,
    });
    return { status: "reopened", thread: existing };
  }

  const channel = getTicketParentChannel();
  const thread = await channel.threads.create({
    name: ticketThreadName(input.username, true),
    type: ChannelType.PrivateThread,
    invitable: false,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `Ticket for ${input.username}`,
  });
  registerTicketThread(input.userId, thread.id);
  await sendTicketMessages(thread, input);
  await logTicketEvent("Opened", {
    userId: input.userId,
    subject: input.subject,
    threadId: thread.id,
  });
  return { status: "created", thread };
}

/** Rename (best-effort) + archive in one PATCH; archive alone as fallback. */
export async function archiveTicketThread(
  thread: AnyThreadChannel,
  opts: { closedBy: string },
) {
  try {
    await thread.edit({
      name: ticketNameWithState(thread.name, false),
      archived: true,
    });
  } catch {
    await thread
      .setArchived(true)
      .catch((err) => console.error("[tickets] archive failed", err));
  }
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
```

- [ ] **Step 6: Verify tests still pass and typecheck**

Run: `bun run scripts/test-tickets.ts && bunx tsc --noEmit`
Expected: `All ticket helper tests passed ✔`, then no tsc output, exit 0.

- [ ] **Step 7: Commit** *(only if approved)*

```bash
git add lib/tickets.ts
git commit -m "tickets: core ops (thread index, open/reopen/append, archive, log)"
```

---

### Task 4: Interaction router + reopen-by-reply + delete logging

**Files:**
- Create: `lib/ticket-interactions.ts`

- [ ] **Step 1: Create `lib/ticket-interactions.ts`**

```ts
import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import { TICKET_CHANNEL_ID, TICKET_STAFF_ROLE_ID } from "./channels";
import {
  archiveTicketThread,
  buildClosedEmbed,
  forgetTicketThread,
  isTicketThread,
  logTicketEvent,
  openTicket,
  ticketNameWithState,
  TICKET_BUTTON_CLOSE,
  TICKET_BUTTON_OPEN,
  TICKET_CLOSED_PREFIX,
  TICKET_MODAL_ID,
} from "./tickets";

function buildTicketModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(TICKET_MODAL_ID)
    .setTitle("Open a support ticket")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("subject")
          .setLabel("Subject")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("description")
          .setLabel("Describe your issue")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("game")
          .setLabel("Game / App (optional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(100),
      ),
    );
}

async function handleOpenButton(interaction: ButtonInteraction) {
  // Must respond within 3s and showModal cannot follow a deferral, so the
  // already-open check happens in the modal submit handler (which can defer).
  await interaction.showModal(buildTicketModal());
}

async function handleModalSubmit(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const subject = interaction.fields.getTextInputValue("subject").trim();
  const description = interaction.fields.getTextInputValue("description").trim();
  const game = interaction.fields.getTextInputValue("game").trim() || undefined;

  const result = await openTicket({
    userId: interaction.user.id,
    username: interaction.user.username,
    subject,
    description,
    game,
  });

  const replies: Record<typeof result.status, string> = {
    created: `✅ Your ticket has been created: <#${result.thread.id}>`,
    reopened: `✅ Your ticket has been reopened: <#${result.thread.id}>`,
    appended: `ℹ️ You already have an open ticket — your message was added there: <#${result.thread.id}>`,
  };
  await interaction.editReply({ content: replies[result.status] });
}

async function handleCloseButton(interaction: ButtonInteraction) {
  const channel = interaction.channel;
  if (!isTicketThread(channel)) {
    await interaction.reply({
      content: "This button only works inside a ticket thread.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Reply first: after archiving, nobody can respond to the interaction.
  await interaction.reply({
    embeds: [buildClosedEmbed(`<@${interaction.user.id}>`)],
  });
  await archiveTicketThread(channel, { closedBy: interaction.user.username });
}

async function handleTicketMessage(message: Message) {
  if (message.author.bot) {
    return;
  }
  const channel = message.channel;
  if (!isTicketThread(channel)) {
    return;
  }
  if (!channel.name.startsWith(TICKET_CLOSED_PREFIX)) {
    return;
  }
  // A reply to a closed ticket auto-unarchived it (Discord behavior) — reopen.
  await channel
    .setName(ticketNameWithState(channel.name, true))
    .catch(() => {/* cosmetic */});
  const isStaff =
    message.member?.roles.cache.has(TICKET_STAFF_ROLE_ID) ?? false;
  if (!isStaff) {
    await channel.send({ content: `<@&${TICKET_STAFF_ROLE_ID}>` });
  }
  await logTicketEvent("Reopened", {
    userId: message.author.id,
    threadId: channel.id,
    detail: "Reopened by reply",
  });
}

async function replyError(interaction: Interaction) {
  if (!interaction.isRepliable()) {
    return;
  }
  const payload = {
    content: "Something went wrong — please try again.",
    flags: MessageFlags.Ephemeral,
  } as const;
  try {
    if (interaction.deferred) {
      await interaction.editReply({ content: payload.content });
    } else if (!interaction.replied) {
      await interaction.reply(payload);
    }
  } catch {
    // Nothing sensible left to do.
  }
}

export function registerTicketListeners(client: Client) {
  if (!TICKET_CHANNEL_ID) {
    console.log("[tickets] disabled (TICKET_CHANNEL_ID not set)");
    return;
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton() && interaction.customId === TICKET_BUTTON_OPEN) {
        await handleOpenButton(interaction);
      } else if (
        interaction.isButton() &&
        interaction.customId === TICKET_BUTTON_CLOSE
      ) {
        await handleCloseButton(interaction);
      } else if (
        interaction.isModalSubmit() &&
        interaction.customId === TICKET_MODAL_ID
      ) {
        await handleModalSubmit(interaction);
      }
      // Anything else (e.g. MEE6 components) is not ours — ignore.
    } catch (err) {
      console.error("[tickets] interaction failed", err);
      await replyError(interaction);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await handleTicketMessage(message);
    } catch (err) {
      console.error("[tickets] message handler failed", err);
    }
  });

  client.on(Events.ThreadDelete, (thread) => {
    if (thread.parentId !== TICKET_CHANNEL_ID) {
      return;
    }
    forgetTicketThread(thread.id);
    void logTicketEvent("Thread deleted", {
      detail: `"${thread.name}" (${thread.id})`,
    });
  });

  console.log("[tickets] listeners registered");
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Commit** *(only if approved)*

```bash
git add lib/ticket-interactions.ts
git commit -m "tickets: interaction router, reopen-by-reply, delete logging"
```

---

### Task 5: Inactivity scheduler

**Files:**
- Create: `lib/ticket-scheduler.ts`

- [ ] **Step 1: Create `lib/ticket-scheduler.ts`**

```ts
import { EmbedBuilder } from "discord.js";
import { TICKET_CHANNEL_ID } from "./channels";
import {
  archiveTicketThread,
  buildClosedEmbed,
  computeInactivityAction,
  deriveActivity,
  getTicketParentChannel,
  isWarningMessage,
  TICKET_WARNING_FOOTER,
} from "./tickets";

/**
 * Periodic ticket maintenance: warn inactive tickets, then auto-close them.
 *
 * Env:
 *   TICKET_SCHEDULER_ENABLED      "false" to disable (default on; also inert
 *                                 while TICKET_CHANNEL_ID is unset)
 *   TICKET_SCHEDULER_INTERVAL_MS  scan interval, default 21600000 (6 h)
 *   TICKET_WARN_AFTER_MS          inactivity before warning, default 5 d
 *   TICKET_CLOSE_AFTER_MS         inactivity before close, default 7 d
 *                                 (measured from last non-warning message;
 *                                 must be > TICKET_WARN_AFTER_MS)
 */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_WARN_AFTER_MS = 5 * 24 * 60 * 60 * 1000;
const DEFAULT_CLOSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 30 * 1000;

let running = false;

function buildWarningEmbed(remainingMs: number): EmbedBuilder {
  const days = Math.max(1, Math.round(remainingMs / (24 * 60 * 60 * 1000)));
  return new EmbedBuilder()
    .setDescription(
      `This ticket has been inactive for a while and will be closed ` +
        `automatically in about ${days} day(s). Reply to keep it open.`,
    )
    .setColor(0xfee75c)
    .setFooter({ text: TICKET_WARNING_FOOTER });
}

export async function runTicketMaintenance() {
  if (running) {
    return;
  }
  running = true;
  try {
    const warnAfterMs =
      Number(process.env.TICKET_WARN_AFTER_MS) || DEFAULT_WARN_AFTER_MS;
    const closeAfterMs =
      Number(process.env.TICKET_CLOSE_AFTER_MS) || DEFAULT_CLOSE_AFTER_MS;

    const channel = getTicketParentChannel();
    const active = await channel.threads.fetchActive();

    for (const thread of active.threads.values()) {
      if (thread.parentId !== TICKET_CHANNEL_ID) {
        continue;
      }
      try {
        const fetched = await thread.messages.fetch({ limit: 10 });
        const infos = [...fetched.values()]
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          .map((message) => ({
            createdTimestamp: message.createdTimestamp,
            isWarning: isWarningMessage(message),
          }));
        const { lastActivityMs, warned } = deriveActivity(
          infos,
          thread.createdTimestamp ?? Date.now(),
        );
        const action = computeInactivityAction({
          lastActivityMs,
          warned,
          nowMs: Date.now(),
          warnAfterMs,
          closeAfterMs,
        });
        if (action === "warn") {
          await thread.send({
            embeds: [buildWarningEmbed(closeAfterMs - warnAfterMs)],
          });
        } else if (action === "close") {
          await thread.send({ embeds: [buildClosedEmbed("auto-close (inactivity)")] });
          await archiveTicketThread(thread, { closedBy: "auto-close" });
        }
      } catch (err) {
        console.error(`[tickets] maintenance failed for thread ${thread.id}`, err);
      }
    }
  } catch (err) {
    console.error("[tickets] maintenance run failed", err);
  } finally {
    running = false;
  }
}

export function startTicketScheduler() {
  if (!TICKET_CHANNEL_ID) {
    return;
  }
  if (process.env.TICKET_SCHEDULER_ENABLED === "false") {
    console.log("[tickets] scheduler disabled (TICKET_SCHEDULER_ENABLED=false)");
    return;
  }
  const interval =
    Number(process.env.TICKET_SCHEDULER_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  setTimeout(() => {
    void runTicketMaintenance();
    setInterval(() => void runTicketMaintenance(), interval);
  }, STARTUP_DELAY_MS);
  console.log(
    `[tickets] scheduler armed (every ${Math.round(interval / 60000)} min)`,
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Commit** *(only if approved)*

```bash
git add lib/ticket-scheduler.ts
git commit -m "tickets: inactivity warn/auto-close scheduler"
```

---

### Task 6: Wire into `index.ts` + local smoke run

**Files:**
- Modify: `index.ts:10-19`

- [ ] **Step 1: Add imports and startup calls**

After line 12 (`import { startGamesSyncScheduler } ...`) add:

```ts
import { registerTicketListeners } from "./lib/ticket-interactions";
import { startTicketScheduler } from "./lib/ticket-scheduler";
```

After line 19 (`startGamesSyncScheduler();`) add:

```ts
registerTicketListeners(client);
startTicketScheduler();
```

- [ ] **Step 2: Typecheck + smoke run without ticket env**

Run: `bunx tsc --noEmit` — expected: no output.
Run: `bun run index.ts` (stop with Ctrl+C after the log lines appear)
Expected output includes: `Ready! Logged in as ...` and `[tickets] disabled (TICKET_CHANNEL_ID not set)`. No scheduler line (inert without channel id). This proves the deployed bot stays inert until env vars are set.

- [ ] **Step 3: Commit** *(only if approved)*

```bash
git add index.ts
git commit -m "tickets: wire listeners and scheduler into startup"
```

---

### Task 7: Setup script for staff-only test channels

**Files:**
- Create: `scripts/setup-ticket-channels.ts`

- [ ] **Step 1: Create `scripts/setup-ticket-channels.ts`**

```ts
import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { getChannel, getClient, initDiscord } from "../lib/discord";
import { TICKET_STAFF_ROLE_ID } from "../lib/channels";

/**
 * Phase-1 operator tool: idempotently creates the staff-only ticket test
 * channel and the ticket log channel under the 🔰 Staff category, with the
 * permission overwrites from the design doc. Prints the env values to set.
 */

const STAFF_GENERAL_CHANNEL_ID = "900261725750849587"; // 🔰 Staff / #general — anchors the category
const TEST_CHANNEL_NAME = "🎫・ticket-test";
const LOG_CHANNEL_NAME = "🎫・ticket-log";

await initDiscord();
const client = getClient();
const staffGeneral = getChannel(STAFF_GENERAL_CHANNEL_ID);
if (!("parent" in staffGeneral) || !staffGeneral.parent || !("guild" in staffGeneral)) {
  throw new Error("Could not resolve the Staff category from #general");
}
const category = staffGeneral.parent;
const guild = staffGeneral.guild as Guild;
const botId = client.user!.id;

function findExisting(name: string) {
  return guild.channels.cache.find(
    (channel) => channel.parentId === category.id && channel.name === name,
  );
}

let panel = findExisting(TEST_CHANNEL_NAME);
if (panel) {
  console.log(`✔ ${TEST_CHANNEL_NAME} already exists: ${panel.id}`);
} else {
  panel = await guild.channels.create({
    name: TEST_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        // Staff act as "users" during the test phase: they need to see the
        // panel and type in their ticket threads, but not create threads
        // themselves (only the bot creates tickets).
        id: TICKET_STAFF_ROLE_ID,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
        ],
        deny: [
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.CreatePublicThreads,
        ],
      },
      {
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.ManageThreads,
        ],
      },
    ],
    reason: "Ticket system Phase 1 test channel",
  });
  console.log(`+ created ${TEST_CHANNEL_NAME}: ${panel.id}`);
}

let log = findExisting(LOG_CHANNEL_NAME);
if (log) {
  console.log(`✔ ${LOG_CHANNEL_NAME} already exists: ${log.id}`);
} else {
  log = await guild.channels.create({
    name: LOG_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: TICKET_STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel] },
      {
        id: botId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
      },
    ],
    reason: "Ticket system log channel",
  });
  console.log(`+ created ${LOG_CHANNEL_NAME}: ${log.id}`);
}

console.log(`\nSet these env vars (locally in .env for testing, later in docker-compose):`);
console.log(`TICKET_CHANNEL_ID=${panel.id}`);
console.log(`TICKET_LOG_CHANNEL_ID=${log.id}`);
process.exit(0);
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Run it against the live guild** *(creates two staff-only channels — visible to staff, harmless; confirm with Leon if he hasn't already OK'd it)*

Run: `bun run scripts/setup-ticket-channels.ts`
Expected output: two `+ created ...` lines (or `✔ ... already exists` on rerun) and the two env values.

- [ ] **Step 4: Verify idempotency**

Run: `bun run scripts/setup-ticket-channels.ts` again.
Expected: both lines say `✔ ... already exists`, same IDs.

- [ ] **Step 5: Add the printed values to `.env`** (dev machine)

```
TICKET_CHANNEL_ID=<printed id>
TICKET_LOG_CHANNEL_ID=<printed id>
```

- [ ] **Step 6: Commit** *(only if approved)*

```bash
git add scripts/setup-ticket-channels.ts
git commit -m "tickets: setup script for staff-only test + log channels"
```

---

### Task 8: Panel publish script

**Files:**
- Create: `scripts/publish-ticket-panel.ts`

- [ ] **Step 1: Create `scripts/publish-ticket-panel.ts`**

```ts
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { initDiscord } from "../lib/discord";
import { getTicketParentChannel, TICKET_BUTTON_OPEN } from "../lib/tickets";

/**
 * Posts (or updates) the ticket panel message in TICKET_CHANNEL_ID.
 * Rerunnable: finds an existing bot panel by our button custom_id and edits it.
 */

await initDiscord();
const channel = getTicketParentChannel();

const embed = new EmbedBuilder()
  .setTitle("How can we help?")
  .setDescription(
    "Click **Open ticket** below to contact the staff privately.\n" +
      "Your ticket is a private thread that only you and the staff can see.\n\n" +
      "If you close a ticket, you can always reopen it later — your history stays.",
  )
  .setColor(0x57f287);

const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder()
    .setCustomId(TICKET_BUTTON_OPEN)
    .setLabel("Open ticket")
    .setEmoji("📩")
    .setStyle(ButtonStyle.Success),
);

const recent = await channel.messages.fetch({ limit: 50 });
const existing = recent.find(
  (message) =>
    message.author.id === channel.client.user.id &&
    message.components.some(
      (component) =>
        "components" in component &&
        component.components.some(
          (child) =>
          child.type === ComponentType.Button &&
            child.customId === TICKET_BUTTON_OPEN,
        ),
    ),
);

if (existing) {
  await existing.edit({ embeds: [embed], components: [row] });
  console.log(`✔ updated panel message ${existing.id} in #${channel.name}`);
} else {
  const message = await channel.send({ embeds: [embed], components: [row] });
  console.log(`+ posted panel message ${message.id} in #${channel.name}`);
}
process.exit(0);
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Publish the panel to the test channel**

Precondition: `.env` contains `TICKET_CHANNEL_ID` from Task 7.
Run: `bun run scripts/publish-ticket-panel.ts`
Expected: `+ posted panel message <id> in #🎫・ticket-test`.

- [ ] **Step 4: Verify rerun edits instead of duplicating**

Run: `bun run scripts/publish-ticket-panel.ts` again.
Expected: `✔ updated panel message <same id> ...`.

- [ ] **Step 5: Commit** *(only if approved)*

```bash
git add scripts/publish-ticket-panel.ts
git commit -m "tickets: panel publish script"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md` (env var table area — follow the existing FAQ/games sync table format)
- Modify: `CLAUDE.md` (Key Components section)

- [ ] **Step 1: Add a Ticket System env table to README.md**

Add alongside the existing sync env tables:

```markdown
### Ticket system

Self-hosted replacement for MEE6 ticketing (design:
`docs/superpowers/specs/2026-08-27-ticket-system-design.md`). One persistent
private thread per user in the panel channel; OPEN ⇔ thread not archived.

| Env var | Description | Default |
| --- | --- | --- |
| `TICKET_CHANNEL_ID` | Text channel with the panel + private ticket threads. Empty = ticket system off. | _(empty)_ |
| `TICKET_LOG_CHANNEL_ID` | Staff-only channel for ticket event embeds. Empty = logging off. | _(empty)_ |
| `TICKET_SCHEDULER_ENABLED` | `false` disables the inactivity scheduler. | `true` |
| `TICKET_SCHEDULER_INTERVAL_MS` | Maintenance scan interval. | `21600000` (6 h) |
| `TICKET_WARN_AFTER_MS` | Inactivity before the warning message. | `432000000` (5 d) |
| `TICKET_CLOSE_AFTER_MS` | Inactivity before auto-close (> warn value). | `604800000` (7 d) |

Operator scripts: `scripts/setup-ticket-channels.ts` (create staff-only
test/log channels), `scripts/publish-ticket-panel.ts` (post/update the panel).
```

- [ ] **Step 2: Add a Ticket System section to CLAUDE.md**

Add under "Key Components" (after the Games Sync block, matching its style):

```markdown
**Ticket System** (`lib/tickets.ts`, `lib/ticket-interactions.ts`, `lib/ticket-scheduler.ts`):

- Self-hosted replacement for MEE6 ticketing. A ticket is a **private thread** in `TICKET_CHANNEL_ID`, **one persistent thread per user** (close = archive, reopen = unarchive the same thread — full history preserved). Discord is the only data store: threads are matched to users via a `user:<id>` marker in the first bot message's embed footer; **OPEN ⇔ thread not archived** (🟢/🔴 name prefixes are best-effort cosmetics; renames are rate-limited).
- Flow: panel button (`thgl:ticket:open`) → modal → private thread with opener mention + staff-role mention (`TICKET_STAFF_ROLE_ID` — role mention auto-adds and notifies staff). Close button archives; a user reply to a closed thread auto-unarchives it and the bot re-pings staff. Inactivity scheduler warns then auto-closes (`TICKET_*` env vars, see README).
- Inert unless `TICKET_CHANNEL_ID` is set. Phase 1 (current): staff-only test channels under 🔰 Staff. Phase 2: point `TICKET_CHANNEL_ID` at 📕・support-ticket (`1092316764081225788`) and retire the MEE6 panel — until then **MEE6 ticketing stays untouched**.
- Operator scripts: `scripts/setup-ticket-channels.ts`, `scripts/publish-ticket-panel.ts`; pure-logic tests in `scripts/test-tickets.ts`.
```

- [ ] **Step 3: Commit** *(only if approved)*

```bash
git add README.md CLAUDE.md
git commit -m "tickets: document env vars and architecture"
```

---

### Task 10: Live staff test (Phase 1 verification)

No file changes. Run the bot locally (`bun dev` — the deployed bot has no ticket code yet and won't interfere) with `.env` containing the Task 7 channel IDs. Leon (or staff) executes the checklist in Discord; the executor watches logs and the log channel.

- [ ] **Step 1: Functional checklist** (normal timings)

1. Click **Open ticket** in `#🎫・ticket-test` → modal appears with Subject/Description/Game fields.
2. Submit → ephemeral "Your ticket has been created: #🟢│…"; thread contains ticket embed (subject/description/game, `user:<id>` footer), Close button, and a staff-role ping; opener + staff-role members are thread members; `#🎫・ticket-log` shows "Ticket opened".
3. Click **Open ticket** again, submit different text → ephemeral "already have an open ticket"; new embed appended to the same thread; log shows "Ticket appended". **No second thread.**
4. Click **Close ticket** → "Ticket closed by @…" embed, thread renamed 🔴 and archived; log shows "Ticket closed".
5. Click **Open ticket** → submit → same thread unarchived, renamed 🟢, new embed + staff ping; ephemeral says "reopened"; log shows "Ticket reopened". History from before the close is still visible above.
6. Close again, then **reply as the opener in the archived thread** (find it via the thread browser) → thread unarchives, renames 🟢, staff ping posted (reply came from a staff member? then no ping — expected), log shows "Reopened … by reply".
7. Have a *second* staff member open a ticket → separate thread; both tickets independent.
8. Delete a test thread manually → log shows "Ticket thread deleted"; that user can open a fresh ticket afterwards.
9. Verify a non-staff account cannot see `#🎫・ticket-test` at all.

- [ ] **Step 2: Auto-close drill** (fast timings)

Stop the bot, restart with:

```powershell
$env:TICKET_WARN_AFTER_MS = "60000"       # 1 min
$env:TICKET_CLOSE_AFTER_MS = "180000"     # 3 min
$env:TICKET_SCHEDULER_INTERVAL_MS = "30000" # 30 s
bun run index.ts
```

1. Open a ticket, wait ≥ 90 s without replying → warning embed appears ("will be closed automatically…").
2. Keep waiting (≥ 3 min since your last real message) → "closed by auto-close" embed, thread archived, log shows "Ticket closed / Closed by auto-close".
3. Open another ticket, wait for the warning, then **reply** → next scans do NOT close it (warned state cleared by your reply; warning may re-appear after another minute — correct).
4. Stop the bot; unset the fast timings (new shell or remove the env vars).

- [ ] **Step 3: Report results to Leon**

Summarize pass/fail per checklist item. On full pass, Phase 1 is done; deployment (push → GH Action → `docker-compose pull` per the deploy recipe) and the docker-compose env vars, plus the eventual Phase 2 cutover, are Leon's call and **not part of this plan**.

---

## Self-review notes

- **Spec coverage**: config ✔ (T1), pure helpers + tests ✔ (T2), index/open/append/reopen/archive/log ✔ (T3), interactions + reopen-by-reply + ThreadDelete ✔ (T4), scheduler ✔ (T5), wiring ✔ (T6), setup script incl. permission checklist ✔ (T7), panel script ✔ (T8), README/CLAUDE.md ✔ (T9), manual checklist ✔ (T10). Phase 2 cutover is intentionally out of scope (spec: separate, after sign-off).
- **Deviation from spec** (documented in header): already-open check moved from button to modal-submit due to the 3-second interaction deadline; adds the `"appended"` status, which is strictly better UX (input preserved).
- **Type consistency**: `ticketNameWithState(name, open)` used by T3/T4; `archiveTicketThread(thread, { closedBy })` used by T4/T5; `deriveActivity(messagesNewestFirst, fallbackMs)` and `computeInactivityAction({...})` shared by T2 tests and T5; custom_id constants only from `lib/tickets.ts`.
