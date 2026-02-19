import {
  Client,
  Events,
  EmbedBuilder,
  type Message,
  type TextChannel,
} from "discord.js";

// --- Configuration ---

const SPAM_GUARD_MODE: "log" | "act" = "log";
const MOD_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID;

const SAFE_ROLE_IDS = process.env.SAFE_ROLE_IDS
  ? process.env.SAFE_ROLE_IDS.split(",").map((id) => id.trim())
  : [];

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
}

// --- State ---

const userMessages = new Map<string, TrackedMessage[]>();
const flaggedUsers = new Set<string>();

// --- Core ---

function trackMessage(message: Message) {
  if (!message.guild) return;
  if (message.author.bot) return;

  if (SAFE_ROLE_IDS.length > 0 && message.member) {
    const hasRole = message.member.roles.cache.some((role) =>
      SAFE_ROLE_IDS.includes(role.id)
    );
    if (hasRole) return;
  }

  const imageCount = message.attachments.filter((a) =>
    a.contentType?.startsWith("image/")
  ).size;

  const entry: TrackedMessage = {
    channelId: message.channelId,
    messageId: message.id,
    guildId: message.guildId!,
    timestamp: Date.now(),
    imageCount,
  };

  const existing = userMessages.get(message.author.id) ?? [];
  existing.push(entry);
  userMessages.set(message.author.id, existing);

  checkRules(message.author.id, message.author.tag, message.client);
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
  const channelLinks = entries.map(
    (e) =>
      `<#${e.channelId}> - [message](https://discord.com/channels/${e.guildId}/${e.channelId}/${e.messageId})`
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
        value: channelLinks.slice(0, 10).join("\n") || "None",
      },
      { name: "Mode", value: SPAM_GUARD_MODE === "act" ? "Acting" : "Log only" }
    )
    .setTimestamp();

  // Log to mod channel
  try {
    const channel = client.channels.cache.get(MOD_LOG_CHANNEL_ID) as
      | TextChannel
      | undefined;
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

    // Ban user
    if (guild) {
      try {
        await guild.members.ban(userId, { reason: `[SpamGuard] ${rule}` });
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
