// "Was this helpful?" — reporter feedback on the inbox agent's resolution replies (Leon
// 2026-10-01: feedback must be more than an emoji; ask at the end whether it helped and for
// more feedback, and use it to self-optimize).
//
// A resolution reply (data-forge scripts/discord-post.mjs --feedback <itemId>) ends with the
// question "Did this solve it? …" and two buttons. Both open a short form; the WRITTEN answer
// is what counts:
//   - "Yes, solved"  → optional: "How was the help? What could I do better?" + "Anything
//                      else you would like?". Logged; any text becomes a `feedback:<itemId>`
//                      inbox item, so the agent turns it into a skill / FAQ / tool improvement.
//   - "Not solved"   → required: "What is still not working?" + optional "What could I have
//                      done better?". Logged, and the rated item is re-ingested (reopens into
//                      the agent lane; a forum post loses its Fixed tag). That session fixes it
//                      AND the cause of the miss (work-inbox skill §5).
// A plain written reply in the thread / channel works too: the reply reopens the item and the
// agent records it as feedback (MCP inbox_feedback_record).
// Only the person the reply was for (or staff) can use the buttons.
//
// custom_id: ifb:<itemId>:<userId>:<s|n>  (button)   ifbm:<itemId>:<userId>:<s|n>  (modal)

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import { TICKET_STAFF_ROLE_ID } from "./channels";
import { inboxApi, inboxEnabled, ingest } from "./inbox-sync";

export type FeedbackIds = { itemId: number; userId: string; solved: boolean };

/** Parses ifb:<itemId>:<userId>:<s|n> (button) or ifbm:… (modal). Pure, for tests. */
export function parseFeedbackId(customId: string, prefix: "ifb" | "ifbm" = "ifb"): FeedbackIds | null {
  const m = customId.match(new RegExp(`^${prefix}:(\\d+):(\\d{15,21}):([sn])$`));
  return m ? { itemId: Number(m[1]), userId: m[2], solved: m[3] === "s" } : null;
}

/** One text for the inbox log from the form's answers. Pure, for tests. */
export function feedbackComment(solved: boolean, first: string, second: string): string {
  const parts = solved
    ? [first && `How was the help: ${first}`, second && `Would like: ${second}`]
    : [first && `Still not working: ${first}`, second && `Could have done better: ${second}`];
  return parts.filter(Boolean).join(" | ");
}

/** Cached GuildMember (roles.cache) or the raw API member (roles: string[]). */
function isStaff(member: unknown): boolean {
  if (!TICKET_STAFF_ROLE_ID || !member || typeof member !== "object" || !("roles" in member)) {
    return false;
  }
  const roles = (member as GuildMember | { roles: string[] }).roles;
  return Array.isArray(roles)
    ? roles.includes(TICKET_STAFF_ROLE_ID)
    : !!(roles as GuildMember["roles"])?.cache?.has(TICKET_STAFF_ROLE_ID);
}

const input = (id: string, label: string, placeholder: string, required: boolean) =>
  new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setPlaceholder(placeholder)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(required)
      .setMaxLength(1000),
  );

function feedbackModal(ids: FeedbackIds): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(
    `ifbm:${ids.itemId}:${ids.userId}:${ids.solved ? "s" : "n"}`,
  );
  return ids.solved
    ? modal
        .setTitle("Glad it's solved! Quick feedback")
        .addComponents(
          input("first", "How was the help? What could I do better?", "e.g. quick and clear / the steps were confusing / took too long", false),
          input("second", "Anything else you would like?", "a feature, a missing marker, something that annoys you", false),
        )
    : modal
        .setTitle("Sorry! What is still wrong?")
        .addComponents(
          input("first", "What is still not working?", "e.g. the marker is still missing on the northern map", true),
          input("second", "What could I have done better?", "e.g. I did not understand the steps / you misread my question", false),
        );
}

const thanksRow = (label: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ifb:done")
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

async function handleButton(interaction: ButtonInteraction, ids: FeedbackIds) {
  if (interaction.user.id !== ids.userId && !isStaff(interaction.member)) {
    await interaction.reply({
      content: `This question was for <@${ids.userId}>. If you have the same problem, write it in a message here and I'll look at it.`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { users: [] },
    });
    return;
  }
  await interaction.showModal(feedbackModal(ids));
}

async function handleModal(interaction: ModalSubmitInteraction, ids: FeedbackIds) {
  const first = interaction.fields.getTextInputValue("first").trim();
  const second = interaction.fields.getTextInputValue("second").trim();
  const comment = feedbackComment(ids.solved, first, second);
  const label = ids.solved
    ? "Thanks for your feedback!"
    : "Thanks, I'll take another look";
  // Answer within Discord's 3 s window first, then log.
  if (interaction.isFromMessage()) {
    await interaction.update({ components: [thanksRow(label)] });
  } else {
    await interaction.reply({ content: label, flags: MessageFlags.Ephemeral });
  }

  const user = interaction.user.username;
  await inboxApi(`/inbox/${ids.itemId}/feedback`, "POST", {
    rating: ids.solved ? "solved" : "unsolved",
    user,
    comment: comment || undefined,
  });
  const rated = await inboxApi<{
    item: { fingerprint: string; source: string; title: string; app_id: string | null };
  }>(`/inbox/${ids.itemId}`);
  if (!rated?.item) return;
  const where = interaction.message?.url ?? "";

  if (!ids.solved) {
    // Reopen the rated item: re-ingesting its fingerprint moves a closed (or needs_info)
    // item back into the agent lane with the reporter's words in the log.
    await ingest({
      fingerprint: rated.item.fingerprint,
      source: rated.item.source,
      title: rated.item.title,
      priority: 3,
      detail: `Feedback: NOT SOLVED from ${user} (<@${interaction.user.id}>) on ${where}\n${comment}`,
    });
    return;
  }
  if (comment) {
    // Solved, with written feedback: its own item, so the agent learns from it.
    await ingest({
      fingerprint: `feedback:${ids.itemId}`,
      source: "feedback",
      appId: rated.item.app_id,
      title: `Feedback on #${ids.itemId}: ${rated.item.title}`.slice(0, 280),
      summary:
        `${user} said the issue is solved and wrote feedback on the reply ${where}. ` +
        `Work it with the work-inbox skill, source feedback (section 5).`,
      priority: 1,
      detail: `Feedback: SOLVED from ${user} (<@${interaction.user.id}>)\n${comment}`,
      data: { itemId: ids.itemId, userId: interaction.user.id, solved: true },
    });
  }
}

export function registerInboxFeedback(client: Client) {
  if (!inboxEnabled()) return;
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isButton()) {
        const ids = parseFeedbackId(interaction.customId, "ifb");
        if (ids) await handleButton(interaction, ids);
      } else if (interaction.isModalSubmit()) {
        const ids = parseFeedbackId(interaction.customId, "ifbm");
        if (ids) await handleModal(interaction, ids);
      }
    } catch (err) {
      console.error("[inbox-feedback] interaction failed", err);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: "Something went wrong, please try again.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    }
  });
  console.log("[inbox-feedback] feedback form active");
}
