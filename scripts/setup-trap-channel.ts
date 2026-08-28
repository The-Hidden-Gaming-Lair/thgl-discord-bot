import { ChannelType, PermissionFlagsBits } from "discord.js";
import { getChannel, getClient, initDiscord } from "../lib/discord";

/**
 * Creates the spam honeypot channel: the FIRST channel in display order where
 * @everyone can write. Spam scripts enumerate the channel list and post into
 * the first writable channels — this catches them before any real channel.
 * Idempotent: reuses an existing channel with the same name.
 */

const TRAP_CHANNEL_NAME = "🪤・bot-trap";
const RULES_CHANNEL_ID = "957662198392565860"; // anchors the top category

await initDiscord();
const client = getClient();
const rules = getChannel(RULES_CHANNEL_ID);
if (!("parent" in rules) || !rules.parent || !("guild" in rules)) {
  throw new Error("Could not resolve the top category from the rules channel");
}
const category = rules.parent;
const guild = rules.guild;

let trap = guild.channels.cache.find(
  (channel) => channel.parentId === category.id && channel.name === TRAP_CHANNEL_NAME,
);
if (trap) {
  console.log(`✔ ${TRAP_CHANNEL_NAME} already exists: ${trap.id}`);
} else {
  trap = await guild.channels.create({
    name: TRAP_CHANNEL_NAME,
    type: ChannelType.GuildText,
    parent: category.id,
    topic:
      "⚠️ Do NOT post here. This channel catches spam bots — messages are removed automatically. Need help? Use the support ticket channel.",
    permissionOverwrites: [
      {
        // Bait: @everyone can write here (the only writable channel this high
        // in the list) — but not start threads or react.
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
        deny: [
          PermissionFlagsBits.CreatePublicThreads,
          PermissionFlagsBits.CreatePrivateThreads,
          PermissionFlagsBits.AddReactions,
        ],
      },
      {
        id: client.user!.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ],
    reason: "Spam honeypot — first writable channel in enumeration order",
  });
  console.log(`+ created ${TRAP_CHANNEL_NAME}: ${trap.id}`);

  if (trap.type === ChannelType.GuildText) {
    const notice = await trap.send({
      content:
        "⚠️ **Do not post in this channel.**\nIt exists to catch spam bots — anything posted here is removed automatically.\nLooking for help? Head to the support ticket channel. 🎫",
    });
    await notice.pin().catch(() => {});
  }
}

console.log(`\nTRAP_CHANNEL_ID=${trap.id}`);
process.exit(0);
