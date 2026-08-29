import {
  ActionRowBuilder,
  EmbedBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Interaction,
  type ModalSubmitInteraction,
} from "discord.js";
import { TICKET_CHANNEL_ID, TICKET_STAFF_ROLE_ID } from "./channels";
import {
  archiveTicketThread,
  buildClosedEmbed,
  buildCloseRow,
  consumeBotUnarchive,
  forgetTicketThread,
  isTicketThread,
  logTicketEvent,
  openTicket,
  TICKET_BUTTON_CLOSE,
  TICKET_BUTTON_OPEN,
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
  const result = await openTicket({
    userId: interaction.user.id,
    username: interaction.user.username,
    subject: interaction.fields.getTextInputValue("subject").trim(),
    description: interaction.fields.getTextInputValue("description").trim(),
    game: interaction.fields.getTextInputValue("game").trim() || undefined,
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
  if (channel.archived) {
    await interaction.reply({
      content: "This ticket is already closed.",
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

  // Multi-instance safety: every handler ACKNOWLEDGES the interaction
  // (deferReply/reply/showModal) BEFORE performing any side effect. Discord
  // accepts only ONE acknowledgment per interaction, so if a second bot
  // process (e.g. local dev alongside production) receives the same event,
  // the loser throws on the ack and performs no side effects. Keep that
  // ordering in every handler.
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

  client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
    try {
      if (newThread.parentId !== TICKET_CHANNEL_ID) {
        return;
      }
      if (!oldThread.archived || newThread.archived) {
        return; // only archived → active transitions
      }
      if (consumeBotUnarchive(newThread.id)) {
        return; // panel reopen; openTicket already handles messages + log
      }
      // A user message auto-unarchived a closed ticket (or staff unarchived
      // it manually) — reopen it and notify the team (unless the reply came
      // from staff; pings are back per owner decision 2026-08-29). The
      // message always carries a fresh Close button so nobody has to scroll
      // for one.
      const latest = (await newThread.messages.fetch({ limit: 1 })).first();
      const isStaff =
        latest?.member?.roles.cache.has(TICKET_STAFF_ROLE_ID) ?? false;
      const pingStaff = Boolean(latest && !latest.author.bot && !isStaff);
      await newThread.send({
        content: pingStaff ? `<@&${TICKET_STAFF_ROLE_ID}>` : undefined,
        embeds: [
          new EmbedBuilder()
            .setDescription("🔓 Ticket reopened by reply.")
            .setColor(0x57f287),
        ],
        components: [buildCloseRow()],
      });
      await logTicketEvent("Reopened", {
        userId: latest?.author.id,
        threadId: newThread.id,
        detail: "Reopened by reply",
      });
    } catch (err) {
      console.error("[tickets] thread update handler failed", err);
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
