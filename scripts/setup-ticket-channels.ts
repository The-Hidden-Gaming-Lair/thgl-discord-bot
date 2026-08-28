import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { getChannel, getClient, initDiscord } from "../lib/discord";
import { TICKET_STAFF_ROLE_ID } from "../lib/channels";

/**
 * Operator tool.
 *
 * Default (Phase 1): idempotently creates the staff-only ticket test channel
 * and the ticket log channel under the 🔰 Staff category, with the permission
 * overwrites from the design doc. Prints the env values to set.
 *
 * `--production` (Phase 2 cutover): applies the production permission set to
 * 📕・support-ticket instead — @everyone can view + use the panel button and
 * type in their own ticket threads, but cannot write in the channel or create
 * threads; staff get ManageThreads (see all tickets); bot gets its full set.
 * Existing overwrites for other principals are left untouched.
 */

const STAFF_GENERAL_CHANNEL_ID = "900261725750849587"; // 🔰 Staff / #general — anchors the category
const SUPPORT_TICKET_CHANNEL_ID = "1092316764081225788"; // 📕・support-ticket (production panel channel)
const TEST_CHANNEL_NAME = "🎫・ticket-test";
const LOG_CHANNEL_NAME = "🎫・ticket-log";

await initDiscord();
const client = getClient();

if (process.argv.includes("--production")) {
  const channel = getChannel(SUPPORT_TICKET_CHANNEL_ID);
  if (channel.type !== ChannelType.GuildText) {
    throw new Error("support-ticket channel is not a guild text channel");
  }
  // ViewChannel is deliberately not touched for @everyone — the channel is
  // already publicly visible; we only restrict writing and thread creation.
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone, {
    SendMessages: false,
    SendMessagesInThreads: true, // without this, ticket openers can't type in their thread
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
  });
  await channel.permissionOverwrites.edit(TICKET_STAFF_ROLE_ID, {
    SendMessages: true,
    SendMessagesInThreads: true,
    ManageThreads: true, // staff see every private ticket thread — no pings by design
  });
  await channel.permissionOverwrites.edit(client.user!.id, {
    ViewChannel: true,
    SendMessages: true,
    SendMessagesInThreads: true,
    CreatePrivateThreads: true,
    ManageThreads: true,
  });
  console.log(`✔ production permissions applied to #📕・support-ticket (${SUPPORT_TICKET_CHANNEL_ID})`);
  console.log(`\nServer docker-compose env for the cutover:`);
  console.log(`TICKET_CHANNEL_ID=${SUPPORT_TICKET_CHANNEL_ID}`);
  console.log(`TICKET_LOG_CHANNEL_ID=<the 🎫・ticket-log id, see channels.ts docs>`);
  process.exit(0);
}
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
  if ("permissionOverwrites" in panel) {
    await panel.permissionOverwrites.edit(TICKET_STAFF_ROLE_ID, {
      ViewChannel: true,
      SendMessages: true,
      SendMessagesInThreads: true,
      ManageThreads: true,
      CreatePrivateThreads: false,
      CreatePublicThreads: false,
    });
    console.log(`  ↳ staff overwrite synced`);
  }
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
        // Staff see the panel and type in their ticket threads, but must not
        // create threads themselves (only the bot creates tickets).
        // ManageThreads grants visibility into every private ticket thread
        // without needing a ping — no staff mentions are sent by design
        // (owner decision 2026-08-27).
        id: TICKET_STAFF_ROLE_ID,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.ManageThreads,
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
