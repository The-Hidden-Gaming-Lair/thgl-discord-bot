import {
  ApplicationCommandType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type MessageContextMenuCommandInteraction,
} from "discord.js";
import { TICKET_CHANNEL_ID, TICKET_STAFF_ROLE_ID } from "./channels";
import { openTicket } from "./tickets";

/**
 * "Create Ticket" message context-menu command (staff-only): right-click any
 * user message → opens (or reuses) a ticket for that message's AUTHOR, with
 * the message quoted and linked. Replaces the "please open a ticket" dance
 * when users report issues in game channels.
 */

const COMMAND_NAME = "Create Ticket";
const QUOTE_LIMIT = 800;

async function handleCreateTicket(
  interaction: MessageContextMenuCommandInteraction,
) {
  // Hidden from non-staff via defaultMemberPermissions; this is defense in depth.
  const isStaff =
    interaction.inCachedGuild() &&
    interaction.member.roles.cache.has(TICKET_STAFF_ROLE_ID);
  if (!isStaff) {
    await interaction.reply({
      content: "Only staff can create tickets from messages.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const target = interaction.targetMessage;
  if (target.author.bot) {
    await interaction.reply({
      content: "Can't create a ticket for a bot message.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channelName =
    target.channel && "name" in target.channel && target.channel.name
      ? `#${target.channel.name}`
      : "another channel";
  const quote = target.content?.trim()
    ? target.content.trim().slice(0, QUOTE_LIMIT)
    : "*(no text — see the original message)*";

  const result = await openTicket({
    userId: target.author.id,
    username: target.author.username,
    subject: `Your message in ${channelName}`.slice(0, 100),
    description: `${quote}\n\n🔗 [Original message](${target.url}) — ticket created by staff so we can help you here.`,
  });

  const replies: Record<typeof result.status, string> = {
    created: `✅ Ticket created for ${target.author.username}: <#${result.thread.id}>`,
    reopened: `✅ Their ticket was reopened: <#${result.thread.id}>`,
    appended: `ℹ️ They already have an open ticket — message added there: <#${result.thread.id}>`,
  };
  await interaction.editReply({ content: replies[result.status] });
}

export function registerTicketMessageCommand(client: Client) {
  if (!TICKET_CHANNEL_ID) {
    return; // ticket system inert
  }
  const guild = client.guilds.cache.first();
  if (!guild) {
    return;
  }

  void guild.commands
    .create({
      name: COMMAND_NAME,
      type: ApplicationCommandType.Message,
      // Staff role has ManageMessages; hides the entry for regular users.
      defaultMemberPermissions: PermissionFlagsBits.ManageMessages,
    })
    .then(() => console.log(`[tickets] "${COMMAND_NAME}" context command registered`))
    .catch((err) =>
      console.error("[tickets] context command registration failed", err),
    );

  client.on(Events.InteractionCreate, async (interaction) => {
    if (
      !interaction.isMessageContextMenuCommand() ||
      interaction.commandName !== COMMAND_NAME
    ) {
      return;
    }
    try {
      await handleCreateTicket(interaction);
    } catch (err) {
      console.error("[tickets] context command failed", err);
      try {
        const payload = { content: "Something went wrong — please try again." };
        if (interaction.deferred) {
          await interaction.editReply(payload);
        } else if (!interaction.replied) {
          await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        }
      } catch {
        // Nothing sensible left to do.
      }
    }
  });
}
