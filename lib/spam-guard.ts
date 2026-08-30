import {
  Client,
  Events,
  EmbedBuilder,
  type Message,
  type TextChannel,
} from "discord.js";

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

// Rule 0: instant single-message signatures from recently-joined members
const RULE0_JOIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RULE0_IMAGE_THRESHOLD = 3;
const INVITE_ONLY_RE = /^(?:https?:\/\/)?(?:www\.)?discord(?:\.gg|(?:app)?\.com\/invite)\/\S+$/i;

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
}

// --- State ---

const userMessages = new Map<string, TrackedMessage[]>();
const flaggedUsers = new Set<string>();

// --- Core ---

function trackMessage(message: Message) {
  if (!message.guild) return;
  // Bots (including this one) and safe/staff roles are excluded BEFORE any
  // trap or rule logic — they can never be deleted, banned, or even logged.
  if (message.author.bot) return;

  if (SAFE_ROLE_IDS.length > 0 && message.member) {
    const hasRole = message.member.roles.cache.some((role) =>
      SAFE_ROLE_IDS.includes(role.id)
    );
    if (hasRole) return;
  }

  if (message.channelId === TRAP_CHANNEL_ID) {
    void handleTrapMessage(message);
    return;
  }

  if (checkRule0(message)) return;

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
  };

  const existing = userMessages.get(message.author.id) ?? [];
  existing.push(entry);
  userMessages.set(message.author.id, existing);

  checkRules(message.author.id, message.author.tag, message.client);
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
      message.client,
      message.author.id,
      message.author.tag,
      "Honeypot",
      `Posted ${hasAttachment ? "attachment(s)" : "a link"} in the trap channel <#${TRAP_CHANNEL_ID}>`,
      [toTrackedMessage(message)]
    );
    return;
  }

  // Human-looking text post: delete quietly, log for staff, take no action.
  await message.delete().catch(() => {});
  if (!MOD_LOG_CHANNEL_ID) return;
  try {
    const channel = message.client.channels.cache.get(MOD_LOG_CHANNEL_ID) as
      | TextChannel
      | undefined;
    if (channel) {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("Trap channel post (no action)")
            .setColor(0xffa500)
            .setDescription(
              `${message.author.tag} (<@${message.author.id}>) posted plain text in <#${TRAP_CHANNEL_ID}> — message deleted, user NOT banned.\n\n${message.content.substring(0, 500)}`
            )
            .setTimestamp(),
        ],
      });
    }
  } catch {
    // Logging must never break handling.
  }
}

/**
 * Rule 0: single-message signatures so obvious they warrant instant action —
 * but ONLY for members who joined less than 7 days ago. Established members
 * can never trigger it.
 */
function checkRule0(message: Message): boolean {
  const joinedAt = message.member?.joinedTimestamp;
  if (!joinedAt || Date.now() - joinedAt > RULE0_JOIN_AGE_MS) {
    return false;
  }
  if (flaggedUsers.has(message.author.id)) return true;

  const imageCount = message.attachments.filter((a) =>
    a.contentType?.startsWith("image/")
  ).size;
  const noText = message.content.trim().length === 0;

  if (imageCount >= RULE0_IMAGE_THRESHOLD && noText) {
    flaggedUsers.add(message.author.id);
    void handleDetection(
      message.client,
      message.author.id,
      message.author.tag,
      "Image burst (new member)",
      `${imageCount} images with no text in a single message, member joined <7 days ago`,
      [toTrackedMessage(message)]
    );
    return true;
  }

  if (
    message.attachments.size === 0 &&
    INVITE_ONLY_RE.test(message.content.trim())
  ) {
    flaggedUsers.add(message.author.id);
    void handleDetection(
      message.client,
      message.author.id,
      message.author.tag,
      "Invite link (new member)",
      "Message is nothing but a Discord invite link, member joined <7 days ago",
      [toTrackedMessage(message)]
    );
    return true;
  }

  return false;
}

function checkRules(userId: string, userTag: string, client: Client) {
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
    handleDetection(
      client,
      userId,
      userTag,
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
    handleDetection(
      client,
      userId,
      userTag,
      "Rapid multi-channel posting",
      `${rule2Channels.size} channels in ${RULE2_WINDOW_MS / 1000}s`,
      entries
    );
    return;
  }
}

async function handleDetection(
  client: Client,
  userId: string,
  userTag: string,
  rule: string,
  detail: string,
  entries: TrackedMessage[]
) {
  const messageDetails = entries.map(
    (e) =>
      `<#${e.channelId}>: ${e.content.substring(0, 200)}${e.content.length > 200 ? "..." : ""}${e.imageCount > 0 ? ` [${e.imageCount} image(s)]` : ""}`
  );

  const embed = new EmbedBuilder()
    .setTitle("Spam Detected")
    .setColor(0xff0000)
    .addFields(
      { name: "User", value: `${userTag} (<@${userId}>) \`${userId}\`` },
      { name: "Rule", value: rule },
      { name: "Detail", value: detail },
      {
        name: "Messages",
        value: messageDetails.slice(0, 10).join("\n\n").substring(0, 1024) || "None",
      },
      { name: "Mode", value: SPAM_GUARD_MODE === "act" ? "Acting" : "Log only" }
    )
    .setTimestamp();

  // Log to mod channel
  try {
    const channel = MOD_LOG_CHANNEL_ID
      ? (client.channels.cache.get(MOD_LOG_CHANNEL_ID) as
          | TextChannel
          | undefined)
      : undefined;
    if (channel) {
      await channel.send({ embeds: [embed] });
    } else {
      console.log(`[SpamGuard] Mod channel ${MOD_LOG_CHANNEL_ID} not found`);
      console.log(
        `[SpamGuard] Detection: ${userTag} (${userId}) - ${rule} - ${detail}`
      );
    }
  } catch (err) {
    console.log(`[SpamGuard] Failed to send mod log: ${err}`);
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

  // Clear flagged users after TTL so they can be re-detected on repeat offenses
  flaggedUsers.clear();
}

// --- Setup ---

export function setupSpamGuard(client: Client) {
  client.on(Events.MessageCreate, (message) => {
    trackMessage(message);
  });

  setInterval(cleanup, CLEANUP_INTERVAL_MS);

  console.log(
    `[SpamGuard] Initialized (mode: ${SPAM_GUARD_MODE}, safe roles: ${SAFE_ROLE_IDS.length})`
  );
}
