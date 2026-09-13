import {
  ChannelType,
  Client,
  Events,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type GuildChannel,
  type Message,
  type TextChannel,
} from "discord.js";
import { getSelfAssignableRoleIds } from "./game-resolver";

// --- Configuration ---

const SPAM_GUARD_MODE: "log" | "act" = "act";
const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID;

const STAFF_ROLE_ID = "1173945621963604069";

const SAFE_ROLE_IDS = [
  STAFF_ROLE_ID,
  ...(process.env.SAFE_ROLE_IDS
    ? process.env.SAFE_ROLE_IDS.split(",").map((id) => id.trim())
    : []),
];

// Honeypot: first writable channel in display order (spam scripts enumerate
// the channel list and post into the first channels that accept messages).
// Created by scripts/setup-trap-channel.ts.
const TRAP_CHANNEL_ID = process.env.TRAP_CHANNEL_ID ?? "1542957161494093909";
// Bot signature: only messages with attachments or links get banned in the
// trap — a confused human typing plain text is deleted + logged, never banned.
const LINK_RE = /(https?:\/\/\S+|discord\.gg\/\S+|discord(?:app)?\.com\/invite\/\S+)/i;

// Support surfaces where user content is NEVER touched. Legitimate users —
// often brand-new accounts, which is exactly what Rule 0 targets — post bursts
// of screenshots and log files here; a ticket thread's screenshots got a real
// user banned (staff report 2026-09-10). The rules only make sense in the
// public browsing channels a spam script enumerates.
// An id may be a channel, a forum, or a whole category; threads and forum
// posts inherit the exemption from their parent (see isExemptChannel).
const EXEMPT_CHANNEL_IDS = new Set(
  [
    "1092316764081225788", // 📕・support-ticket (panel + private ticket threads)
    process.env.TICKET_CHANNEL_ID, // whatever the running instance uses
    "1021543411293106217", // ❕・suggestions-issues (forum + posts)
    "1173952040137932852", // 🎫 Created Tickets (legacy MEE6 category)
    "1173952042448990299", // 🎫 Claimed Tickets (legacy MEE6 category)
    "1173952044097347624", // 🎫 Closed Tickets (legacy MEE6 category)
    ...(process.env.SPAM_GUARD_EXEMPT_CHANNEL_IDS ?? "").split(","),
  ]
    .map((id) => id?.trim())
    .filter((id): id is string => Boolean(id)),
);

// Rule 0: instant single-message signatures. Three legs decide whether an
// account is allowed to trigger a ban off a SINGLE message:
//   1. joined less than 7 days ago (the original gate)
//   2. holds no onboarding role — the onboarding prompt is required, so an
//      account that picked nothing and posts this signature is not a real user
//   3. established member WITH onboarding roles but no posting history — the hijacked
//      -account case. Recorded only (see RULE0_HISTORY_LEG): a real member who
//      simply never talked before must not be banned on this evidence alone.
const RULE0_JOIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RULE0_IMAGE_THRESHOLD = 3;
const INVITE_ONLY_RE = /^(?:https?:\/\/)?(?:www\.)?discord(?:\.gg|(?:app)?\.com\/invite)\/\S+$/i;
/** "log" = mod-log entry only, "ban" = act like legs 1 and 2. */
const RULE0_HISTORY_LEG: "log" | "ban" = "log";
/** How long a member counts as a known poster after their last message. */
const KNOWN_POSTER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROLE_REFRESH_MS = 10 * 60 * 1000;

// Rule 1: Cross-channel image spam
const RULE1_IMAGE_THRESHOLD = 3;
const RULE1_CHANNEL_THRESHOLD = 2;
const RULE1_WINDOW_MS = 60_000;

// Rule 2: Rapid multi-channel posting
const RULE2_CHANNEL_THRESHOLD = 4;
const RULE2_WINDOW_MS = 30_000;

// Cleanup
const CLEANUP_INTERVAL_MS = 120_000;
const ENTRY_TTL_MS = 60_000;

// --- Types ---

interface TrackedMessage {
  channelId: string;
  messageId: string;
  guildId: string;
  timestamp: number;
  imageCount: number;
  content: string;
  /** Kept for the mod log: campaigns reuse the same files across accounts. */
  attachments: {
    name: string;
    size: number;
    width: number | null;
    height: number | null;
    contentType: string | null;
  }[];
}

// --- State ---

const userMessages = new Map<string, TrackedMessage[]>();
const flaggedUsers = new Set<string>();
/** userId -> timestamp of their last message anywhere in the guild. */
const knownPosters = new Map<string, number>();
/**
 * Every role a real member can pick up by going through onboarding (game roles
 * plus non-game options like Coding/Development). Empty until the first refresh
 * succeeds, which keeps Rule 0's leg 2 disabled until we have real data.
 */
let selfAssignableRoleIds = new Set<string>();

async function refreshSelfAssignableRoleIds() {
  try {
    const ids = await getSelfAssignableRoleIds();
    // Never shrink to nothing: an empty set disables the "no onboarding role"
    // leg rather than making every member look role-less.
    if (ids.size > 0) selfAssignableRoleIds = ids;
  } catch (err) {
    console.log(`[SpamGuard] self-assignable role refresh failed: ${err}`);
  }
}

// --- Core ---

/**
 * True when the message sits in an exempt channel, in a thread/forum post of
 * one, or anywhere under an exempt category. Walks up two levels: thread →
 * parent channel → category.
 */
function isExemptChannel(message: Message): boolean {
  const channel = message.channel;
  if (EXEMPT_CHANNEL_IDS.has(channel.id)) return true;

  const parentId = "parentId" in channel ? channel.parentId : null;
  if (!parentId) return false;
  if (EXEMPT_CHANNEL_IDS.has(parentId)) return true;

  const parent = message.client.channels.cache.get(parentId);
  const categoryId = parent && "parentId" in parent ? parent.parentId : null;
  return categoryId ? EXEMPT_CHANNEL_IDS.has(categoryId) : false;
}

function trackMessage(message: Message) {
  if (!message.guild) return;
  // Bots (including this one) and safe/staff roles are excluded BEFORE any
  // trap or rule logic — they can never be deleted, banned, or even logged.
  if (message.author.bot) return;

  // Read BEFORE recording this message, otherwise everyone always has history.
  // Recorded for every human message including exempt channels: someone who
  // only ever talks in their ticket is still a real member.
  const hadHistory = knownPosters.has(message.author.id);
  knownPosters.set(message.author.id, Date.now());

  if (SAFE_ROLE_IDS.length > 0 && message.member) {
    const hasRole = message.member.roles.cache.some((role) =>
      SAFE_ROLE_IDS.includes(role.id)
    );
    if (hasRole) return;
  }

  // Support channels are excluded before the flagged-user sweep too: a user
  // wrongly flagged elsewhere must not lose their ticket screenshots.
  if (isExemptChannel(message)) return;

  if (flaggedUsers.has(message.author.id)) {
    // The user is being (or just was) banned — this message slipped in while
    // the ban was in flight. Discord's deleteMessageSeconds purge can miss
    // messages committed in the same instant (confirmed 2026-08-30: the
    // recurring "one leftover message" staff removed by hand), so delete it
    // ourselves; the gateway still delivers it to us.
    void message.delete().catch(() => {});
    return;
  }

  if (message.channelId === TRAP_CHANNEL_ID) {
    void handleTrapMessage(message);
    return;
  }

  if (checkRule0(message, hadHistory)) return;

  const imageCount = message.attachments.filter((a) =>
    a.contentType?.startsWith("image/")
  ).size;

  const content = message.content || message.embeds.map((e) => e.title || e.description || "").filter(Boolean).join(" | ") || "[no text content]";

  const entry: TrackedMessage = {
    channelId: message.channelId,
    messageId: message.id,
    guildId: message.guildId!,
    timestamp: Date.now(),
    imageCount,
    content,
    attachments: describeAttachments(message),
  };

  const existing = userMessages.get(message.author.id) ?? [];
  existing.push(entry);
  userMessages.set(message.author.id, existing);

  checkRules(message);
}

function describeAttachments(message: Message): TrackedMessage["attachments"] {
  return [...message.attachments.values()].map((a) => ({
    name: a.name,
    size: a.size,
    width: a.width,
    height: a.height,
    contentType: a.contentType,
  }));
}

// --- Scoreboard: pinned counter embed in the trap channel ---

const TRAP_COUNTER_FOOTER = "thgl:trap:counter";
// Serialize increments so two near-simultaneous bans don't race the
// read-modify-write on the counter message.
let counterQueue: Promise<void> = Promise.resolve();

function buildCounterEmbed(total: number, trapped: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("🛡️ Spam Guard Scoreboard")
    .addFields(
      { name: "Spammers banned", value: String(total), inline: true },
      { name: "🪤 Caught by this trap", value: String(trapped), inline: true },
    )
    .setColor(0x57f287)
    .setFooter({ text: TRAP_COUNTER_FOOTER })
    .setTimestamp();
}

function parseCounterField(message: Message, name: string): number {
  const value = message.embeds[0]?.fields.find((f) => f.name.includes(name))?.value;
  return Number.parseInt(value ?? "0", 10) || 0;
}

export function bumpSpamCounter(client: Client, trapped: boolean) {
  counterQueue = counterQueue.then(async () => {
    try {
      const channel = client.channels.cache.get(TRAP_CHANNEL_ID) as
        | TextChannel
        | undefined;
      if (!channel) return;
      const recent = await channel.messages.fetch({ limit: 30 });
      const counter = recent.find(
        (m) =>
          m.author.id === client.user?.id &&
          m.embeds[0]?.footer?.text === TRAP_COUNTER_FOOTER,
      );
      const total = (counter ? parseCounterField(counter, "banned") : 0) + 1;
      const trappedCount =
        (counter ? parseCounterField(counter, "trap") : 0) + (trapped ? 1 : 0);
      const embed = buildCounterEmbed(total, trappedCount);
      if (counter) {
        await counter.edit({ embeds: [embed] });
      } else {
        const created = await channel.send({ embeds: [embed] });
        await created.pin().catch(() => {});
      }
    } catch (err) {
      console.log(`[SpamGuard] counter update failed: ${err}`);
    }
  });
}

function toTrackedMessage(message: Message): TrackedMessage {
  return {
    channelId: message.channelId,
    messageId: message.id,
    guildId: message.guildId!,
    timestamp: Date.now(),
    imageCount: message.attachments.filter((a) =>
      a.contentType?.startsWith("image/")
    ).size,
    content: message.content || "[no text content]",
    attachments: describeAttachments(message),
  };
}

/**
 * Honeypot channel: ANY post is removed. Only messages matching the bot
 * signature (attachment or link) lead to a ban — plain text is deleted and
 * logged with no action, so a confused human is never punished.
 */
async function handleTrapMessage(message: Message) {
  const hasAttachment = message.attachments.size > 0;
  const hasLink = LINK_RE.test(message.content);

  if (hasAttachment || hasLink) {
    if (flaggedUsers.has(message.author.id)) return;
    flaggedUsers.add(message.author.id);
    await handleDetection(
      message,
      "Honeypot",
      `Posted ${hasAttachment ? "attachment(s)" : "a link"} in the trap channel <#${TRAP_CHANNEL_ID}>`,
      [toTrackedMessage(message)]
    );
    return;
  }

  // Human-looking text post: delete quietly, log for staff, take no action.
  await message.delete().catch(() => {});
  await sendModLog(
    message.client,
    new EmbedBuilder()
      .setTitle("Trap channel post (no action)")
      .setColor(0xffa500)
      .setDescription(
        `${message.author.tag} (<@${message.author.id}>) posted plain text in <#${TRAP_CHANNEL_ID}> — message deleted, user NOT banned.

${message.content.substring(0, 500)}`
      )
      .setTimestamp()
  );
}

export type Rule0Rule = "Image burst" | "Invite link";
export type Rule0Gate = "new member" | "no onboarding role" | "review";

/**
 * Rule 0's decision table, kept pure so it can be tested without Discord: the
 * signature (what the message looks like) and the gate (who it may be acted on
 * for). Returns null when the message is not a Rule 0 signature, or when the
 * author looks like a real member.
 *
 * Only the "new member" gate acts on its own. Everything else additionally
 * requires that the account has never posted: an established member who talks
 * here is never touched by Rule 0, whatever their roles are.
 */
export function rule0Decision(input: {
  imageCount: number;
  attachmentCount: number;
  content: string;
  /** null when the gateway gave us no member object. */
  joinedAt: number | null;
  hasMember: boolean;
  roleIds: string[];
  knownMemberRoleIds: Set<string>;
  hadHistory: boolean;
  now?: number;
}): { rule: Rule0Rule; gate: Rule0Gate } | null {
  const text = input.content.trim();
  const isImageBurst = input.imageCount >= RULE0_IMAGE_THRESHOLD && text.length === 0;
  const isBareInvite = input.attachmentCount === 0 && INVITE_ONLY_RE.test(text);
  if (!isImageBurst && !isBareInvite) return null;
  const rule: Rule0Rule = isImageBurst ? "Image burst" : "Invite link";

  const now = input.now ?? Date.now();
  if (input.joinedAt !== null && now - input.joinedAt <= RULE0_JOIN_AGE_MS) {
    return { rule, gate: "new member" };
  }
  if (input.hadHistory) return null;

  // Never posted here. An account that also picked nothing in onboarding did
  // not arrive the way members arrive — but only with a member object and a
  // loaded role set, so missing data can never read as "picked nothing".
  if (
    input.hasMember &&
    input.knownMemberRoleIds.size > 0 &&
    !input.roleIds.some((id) => input.knownMemberRoleIds.has(id))
  ) {
    return { rule, gate: "no onboarding role" };
  }
  // Onboarded, established, but silent until now: the hijacked-account shape.
  return { rule, gate: "review" };
}

/**
 * Rule 0: single-message signatures so obvious they warrant instant action.
 * The signature is the same for everyone; the gate decides who it may be acted
 * on (see the constants above). Returns true when the message was handled.
 */
function checkRule0(message: Message, hadHistory: boolean): boolean {
  const member = message.member;
  const imageCount = message.attachments.filter((a) =>
    a.contentType?.startsWith("image/")
  ).size;
  const decision = rule0Decision({
    imageCount,
    attachmentCount: message.attachments.size,
    content: message.content,
    joinedAt: member?.joinedTimestamp ?? null,
    hasMember: member != null,
    roleIds: member ? [...member.roles.cache.keys()] : [],
    knownMemberRoleIds: selfAssignableRoleIds,
    hadHistory,
  });
  if (!decision) return false;
  if (flaggedUsers.has(message.author.id)) return true;

  const signature =
    decision.rule === "Image burst"
      ? `${imageCount} images with no text in a single message`
      : "message is nothing but a Discord invite link";

  if (decision.gate === "new member") {
    flaggedUsers.add(message.author.id);
    void handleDetection(
      message,
      `${decision.rule} (new member)`,
      `${signature}, member joined <7 days ago`,
      [toTrackedMessage(message)]
    );
    return true;
  }

  // Both remaining gates rest on "has never posted", which the in-memory map
  // alone cannot prove — hand off to the async double check.
  void resolveSilentAccount(message, decision.rule, decision.gate, signature);
  return false;
}

/**
 * The two Rule 0 gates that hinge on the account never having posted. The
 * in-memory map is empty after every restart, so a miss is double-checked
 * against the channel's recent messages before anything happens.
 *
 * "no onboarding role" bans; "review" (onboarded but silent) only records,
 * while RULE0_HISTORY_LEG is "log" — flip it once the mod log shows those are
 * never real members.
 */
async function resolveSilentAccount(
  message: Message,
  rule: Rule0Rule,
  gate: Exclude<Rule0Gate, "new member">,
  signature: string
) {
  try {
    const previous = await message.channel.messages.fetch({
      limit: 100,
      before: message.id,
    });
    if (previous.some((m) => m.author.id === message.author.id)) return;
  } catch {
    return; // fail safe: never act on a lookup failure
  }
  if (flaggedUsers.has(message.author.id)) return;

  const entries = [toTrackedMessage(message)];
  const detail =
    gate === "no onboarding role"
      ? `${signature}; account holds no onboarding role and has never posted here`
      : `${signature}; onboarded member with no prior message here`;

  if (gate === "no onboarding role" || RULE0_HISTORY_LEG === "ban") {
    flaggedUsers.add(message.author.id);
    await handleDetection(message, `${rule} (${gate})`, detail, entries);
    return;
  }

  await sendModLog(
    message.client,
    new EmbedBuilder()
      .setTitle("Rule 0 review (no action)")
      .setColor(0xffa500)
      .setThumbnail(message.author.displayAvatarURL())
      .addFields(
        { name: "User", value: describeUser(message) },
        { name: "Would-be rule", value: `${rule} (${gate})` },
        { name: "Detail", value: detail },
        ...offenderFields(message, entries),
        { name: "Mode", value: "Log only (RULE0_HISTORY_LEG)" }
      )
      .setTimestamp()
  );
}

function checkRules(message: Message) {
  const userId = message.author.id;
  if (flaggedUsers.has(userId)) return;

  const entries = userMessages.get(userId);
  if (!entries) return;

  const now = Date.now();

  // Rule 1: Cross-channel image spam
  const rule1Entries = entries.filter(
    (e) => now - e.timestamp < RULE1_WINDOW_MS && e.imageCount > 0
  );
  const rule1Channels = new Set(rule1Entries.map((e) => e.channelId));
  const totalImages = rule1Entries.reduce((sum, e) => sum + e.imageCount, 0);

  if (
    totalImages >= RULE1_IMAGE_THRESHOLD &&
    rule1Channels.size >= RULE1_CHANNEL_THRESHOLD
  ) {
    flaggedUsers.add(userId);
    void handleDetection(
      message,
      "Cross-channel image spam",
      `${totalImages} images across ${rule1Channels.size} channels in ${RULE1_WINDOW_MS / 1000}s`,
      entries
    );
    return;
  }

  // Rule 2: Rapid multi-channel posting
  const rule2Entries = entries.filter(
    (e) => now - e.timestamp < RULE2_WINDOW_MS
  );
  const rule2Channels = new Set(rule2Entries.map((e) => e.channelId));

  if (rule2Channels.size >= RULE2_CHANNEL_THRESHOLD) {
    flaggedUsers.add(userId);
    void handleDetection(
      message,
      "Rapid multi-channel posting",
      `${rule2Channels.size} channels in ${RULE2_WINDOW_MS / 1000}s`,
      entries
    );
    return;
  }
}

// --- Forensics: what the mod log should teach us about a spammer ---

const TEXTLIKE_TYPES = new Set<number>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

const clamp = (value: string) =>
  value.length > 1024 ? `${value.slice(0, 1021)}...` : value;

/**
 * Where a channel sits in the two orders a spam script can enumerate: Discord's
 * raw `position` field (a per-category sort key — sorting by it globally ignores
 * categories, and that is the order the recurring campaigns demonstrably use)
 * and the order a human sees in the client. Logging both says which enumeration
 * a campaign used, and whether the honeypot is still ahead of what got hit.
 */
function channelRanks(guild: Guild) {
  const writable = ([...guild.channels.cache.values()] as GuildChannel[]).filter(
    (channel) => {
      if (!TEXTLIKE_TYPES.has(channel.type)) return false;
      const perms = channel.permissionsFor(guild.roles.everyone);
      return (
        (perms?.has(PermissionFlagsBits.ViewChannel) ?? false) &&
        (perms?.has(PermissionFlagsBits.SendMessages) ?? false)
      );
    }
  );

  const ranks = new Map<
    string,
    { raw: number; rawRank: number; displayRank: number }
  >();
  [...writable]
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .forEach((c, i) =>
      ranks.set(c.id, { raw: c.rawPosition, rawRank: i + 1, displayRank: 0 })
    );
  [...writable]
    .sort(
      (a, b) =>
        (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) ||
        a.position - b.position
    )
    .forEach((c, i) => {
      const entry = ranks.get(c.id);
      if (entry) entry.displayRank = i + 1;
    });
  return ranks;
}

function describeAge(ts: number | null | undefined): string {
  if (!ts) return "unknown";
  const days = Math.floor((Date.now() - ts) / 86_400_000);
  return `<t:${Math.floor(ts / 1000)}:d> (${days}d ago)`;
}

function describeUser(message: Message): string {
  const nickname = message.member?.nickname;
  return `${message.author.tag} (<@${message.author.id}>) \`${message.author.id}\`${
    nickname ? `\nnickname: ${nickname}` : ""
  }`;
}

/**
 * The "who was this account?" half of a mod-log entry. Account/join age and
 * roles say whether it was a sleeper or a hijacked member; the channel ranks
 * say how it picked its targets; the attachment names/sizes let us recognise
 * the same campaign across accounts.
 */
function offenderFields(message: Message, entries: TrackedMessage[]) {
  const member = message.member;
  const roles = member
    ? [...member.roles.cache.values()].filter((r) => r.id !== message.guildId)
    : [];
  const selfAssigned = roles.filter((r) => selfAssignableRoleIds.has(r.id));
  const ranks = message.guild ? channelRanks(message.guild) : null;

  const channelLines = [...new Set(entries.map((e) => e.channelId))].map((id) => {
    const rank = ranks?.get(id);
    return rank
      ? `<#${id}> — raw ${rank.raw}, #${rank.rawRank} by raw order, #${rank.displayRank} by display order`
      : `<#${id}>`;
  });

  const attachments = entries.flatMap((e) => e.attachments);
  const attachmentLines = attachments.slice(0, 8).map((a) => {
    const dims = a.width && a.height ? `${a.width}x${a.height} ` : "";
    const type = a.contentType ? ` ${a.contentType}` : "";
    return `\`${a.name}\` ${dims}${Math.round(a.size / 1024)} KB${type}`;
  });

  return [
    {
      name: "Account",
      value: `created ${describeAge(message.author.createdTimestamp)}\njoined ${describeAge(member?.joinedTimestamp)}`,
      inline: true,
    },
    {
      name: `Roles (${roles.length})`,
      value: clamp(roles.map((r) => r.name).join(", ") || "none"),
      inline: true,
    },
    {
      name: `Onboarding roles (${selfAssigned.length})`,
      value: clamp(selfAssigned.map((r) => r.name).join(", ") || "none"),
      inline: true,
    },
    { name: "Channels hit", value: clamp(channelLines.join("\n") || "none") },
    {
      name: `Attachments (${attachments.length})`,
      value: clamp(attachmentLines.join("\n") || "none"),
    },
  ];
}

async function sendModLog(client: Client, embed: EmbedBuilder) {
  if (!MOD_LOG_CHANNEL_ID) return;
  const channel = client.channels.cache.get(MOD_LOG_CHANNEL_ID) as
    | TextChannel
    | undefined;
  if (!channel) {
    console.log(`[SpamGuard] Mod channel ${MOD_LOG_CHANNEL_ID} not found`);
    return;
  }
  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    // The embed is the evidence — if Discord rejects it (a field built wrong,
    // a length missed), fall back to plain text rather than lose the entry.
    console.log(`[SpamGuard] Failed to send mod log embed: ${err}`);
    const flat = [
      `**${embed.data.title ?? "Spam Guard"}** (embed rejected: ${err})`,
      embed.data.description ?? "",
      ...(embed.data.fields ?? []).map((f) => `**${f.name}**: ${f.value}`),
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 1900);
    await channel.send({ content: flat }).catch((fallbackErr) => {
      console.log(`[SpamGuard] Mod log fallback also failed: ${fallbackErr}`);
    });
  }
}

async function handleDetection(
  message: Message,
  rule: string,
  detail: string,
  entries: TrackedMessage[]
) {
  const client = message.client;
  const userId = message.author.id;
  const userTag = message.author.tag;

  const messageDetails = entries.map(
    (e) =>
      `<#${e.channelId}>: ${e.content.substring(0, 200)}${e.content.length > 200 ? "..." : ""}${e.imageCount > 0 ? ` [${e.imageCount} image(s)]` : ""}`
  );

  const embed = new EmbedBuilder()
    .setTitle("Spam Detected")
    .setColor(0xff0000)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: "User", value: describeUser(message) },
      { name: "Rule", value: rule },
      { name: "Detail", value: detail },
      ...offenderFields(message, entries),
      {
        name: "Messages",
        value: clamp(messageDetails.slice(0, 10).join("\n\n")) || "None",
      },
      { name: "Mode", value: SPAM_GUARD_MODE === "act" ? "Acting" : "Log only" }
    )
    .setTimestamp();

  await sendModLog(client, embed);
  if (!MOD_LOG_CHANNEL_ID) {
    console.log(
      `[SpamGuard] Detection: ${userTag} (${userId}) - ${rule} - ${detail}`
    );
  }

  // Act mode: delete messages + ban
  if (SPAM_GUARD_MODE === "act") {
    const guildId = entries[0]?.guildId;
    const guild = guildId ? client.guilds.cache.get(guildId) : undefined;

    // Delete messages
    await Promise.all(
      entries.map(async (e) => {
        try {
          const ch = client.channels.cache.get(e.channelId) as
            | TextChannel
            | undefined;
          if (ch) {
            const msg = await ch.messages.fetch(e.messageId);
            await msg.delete();
          }
        } catch {
          // Message may already be deleted
        }
      })
    );

    // Ban user. deleteMessageSeconds purges the user's recent messages
    // SERVER-SIDE — this catches the in-flight message that lands while we
    // are deleting/banning (it was posted before the ban propagated and our
    // per-message delete loop never saw it; staff had to remove those by hand).
    if (guild) {
      try {
        await guild.members.ban(userId, {
          reason: `[SpamGuard] ${rule}`,
          deleteMessageSeconds: 60 * 60,
        });
        bumpSpamCounter(client, rule === "Honeypot");
      } catch (err) {
        console.log(`[SpamGuard] Failed to ban ${userId}: ${err}`);
      }
    }
  }

  // Clear tracked messages for this user
  userMessages.delete(userId);
}

function cleanup() {
  const now = Date.now();
  for (const [userId, entries] of userMessages) {
    const fresh = entries.filter((e) => now - e.timestamp < ENTRY_TTL_MS);
    if (fresh.length === 0) {
      userMessages.delete(userId);
    } else {
      userMessages.set(userId, fresh);
    }
  }

  for (const [userId, at] of knownPosters) {
    if (now - at > KNOWN_POSTER_TTL_MS) knownPosters.delete(userId);
  }

  // Clear flagged users after TTL so they can be re-detected on repeat offenses
  flaggedUsers.clear();
}

// --- Setup ---

export function setupSpamGuard(client: Client) {
  client.on(Events.MessageCreate, (message) => {
    trackMessage(message);
  });

  setInterval(cleanup, CLEANUP_INTERVAL_MS);

  // Rule 0's "no onboarding role" leg needs the live role set; it stays disabled
  // until the first refresh succeeds.
  if (client.isReady()) void refreshSelfAssignableRoleIds();
  else client.once(Events.ClientReady, () => void refreshSelfAssignableRoleIds());
  setInterval(() => void refreshSelfAssignableRoleIds(), ROLE_REFRESH_MS);

  console.log(
    `[SpamGuard] Initialized (mode: ${SPAM_GUARD_MODE}, safe roles: ${SAFE_ROLE_IDS.length}, exempt channels: ${EXEMPT_CHANNEL_IDS.size})`
  );
}
