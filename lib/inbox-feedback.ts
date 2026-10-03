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
// ANYONE can use the buttons (several players often share a problem), and every answer is shown
// publicly on the reply under "Feedback" (withFeedbackLine) - the buttons stay for the next one.
//
// Whether they CHECKED the result is tracked too (Leon 2026-10-03): "Fixed - I checked it" (v)
// vs "Looks good, not checked yet" (u); `s` = the older single "Yes, solved" button (not asked).
//
// custom_id: ifb:<itemId>:<userId>:<v|u|s|n>  (button)   ifbm:…  (modal)

import {
  ActionRowBuilder,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
} from "discord.js";
import { USER_FEEDBACK_CHANNEL_ID } from "./channels";
import { inboxApi, inboxEnabled, ingest } from "./inbox-sync";

export type FeedbackIds = {
  itemId: number;
  userId: string;
  solved: boolean;
  /** true = checked it themselves, false = not checked yet, undefined = not asked. */
  verified?: boolean;
  code: "v" | "u" | "s" | "n";
};

/** Parses ifb:<itemId>:<userId>:<v|u|s|n> (button) or ifbm:… (modal). Pure, for tests. */
export function parseFeedbackId(customId: string, prefix: "ifb" | "ifbm" = "ifb"): FeedbackIds | null {
  const m = customId.match(new RegExp(`^${prefix}:(\\d+):(\\d{15,21}):([vusn])$`));
  if (!m) return null;
  const code = m[3] as FeedbackIds["code"];
  return {
    itemId: Number(m[1]),
    userId: m[2],
    solved: code !== "n",
    verified: code === "v" ? true : code === "u" ? false : undefined,
    code,
  };
}

export const FEEDBACK_HEADER = "**Feedback**";
const DISCORD_LIMIT = 2000;

/**
 * Public feedback on the bot's reply (Leon 2026-10-03: feedback was invisible to everyone but the
 * log, so the agent's "thanks for the feedback" looked like it answered nothing, and staff could
 * not see it in the channel). Each answer becomes one subtext line under a "Feedback" heading at
 * the end of the reply; the same person answering again replaces their line. Long comments are
 * clipped, and the oldest lines give way when the 2000-char limit is reached. Pure, for tests.
 */
export function withFeedbackLine(
  content: string,
  f: { userId: string; solved: boolean; verified?: boolean; first: string; second: string },
): string {
  const verdict = !f.solved
    ? "❌ Not solved"
    : f.verified === true
      ? "✅ Fixed, checked it"
      : f.verified === false
        ? "👍 Looks good, not checked yet"
        : "✅ Solved";
  const clean = (s: string) =>
    s.replace(/\s+/g, " ").replace(/@(everyone|here)/gi, "@​$1").replace(/<@[!&]?\d+>/g, "@user").trim();
  const text = [f.first, f.second].map(clean).filter(Boolean).join(" | ");
  const quote = text ? `: "${text.length > 160 ? `${text.slice(0, 159)}…` : text}"` : "";
  const line = `-# ${verdict} · <@${f.userId}>${quote}`;

  const at = content.lastIndexOf(`\n\n${FEEDBACK_HEADER}\n`);
  const body = at >= 0 ? content.slice(0, at) : content;
  const lines = at >= 0
    ? content.slice(at + FEEDBACK_HEADER.length + 3).split("\n").filter((l) => l && !l.includes(`<@${f.userId}>`))
    : [];
  lines.push(line);
  let out = `${body}\n\n${FEEDBACK_HEADER}\n${lines.join("\n")}`;
  while (out.length > DISCORD_LIMIT && lines.length > 1) {
    lines.shift();
    out = `${body}\n\n${FEEDBACK_HEADER}\n${lines.join("\n")}`;
  }
  return out.slice(0, DISCORD_LIMIT);
}

/** One text for the inbox log from the form's answers. Pure, for tests. */
export function feedbackComment(solved: boolean, first: string, second: string): string {
  const parts = solved
    ? [first && `How was the help: ${first}`, second && `Would like: ${second}`]
    : [first && `Still not working: ${first}`, second && `Could have done better: ${second}`];
  return parts.filter(Boolean).join(" | ");
}

/** The #user-feedback post for one form answer (staff-only channel). Pure, for tests. */
export function feedbackChannelText(f: {
  solved: boolean;
  verified?: boolean;
  userId: string;
  itemId: number;
  title: string;
  where: string;
  first: string;
  second: string;
}): string {
  const [q1, q2] = f.solved
    ? ["How was the help", "Would like"]
    : ["Still not working", "Could have done better"];
  const quote = (s: string) => (s ? s.split("\n").map((l) => `> ${l}`).join("\n") : "> (empty)");
  return [
    `${f.solved ? "✅ **Solved**" : "❌ **Not solved**"}${
      f.verified === true ? " (checked it)" : f.verified === false ? " (not checked yet)" : ""
    } from <@${f.userId}> on #${f.itemId} ${f.title}`.slice(0, 300),
    f.where && `Reply: ${f.where}`,
    `**${q1}:**`,
    quote(f.first),
    `**${q2}:**`,
    quote(f.second),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 2000);
}

async function postToFeedbackChannel(interaction: ModalSubmitInteraction, { text }: { text: string }) {
  if (!USER_FEEDBACK_CHANNEL_ID) return;
  try {
    const channel = await interaction.client.channels.fetch(USER_FEEDBACK_CHANNEL_ID);
    if (channel?.isSendable()) {
      await channel.send({ content: text, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    console.error("[inbox-feedback] posting to #user-feedback failed", err);
  }
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
  const modal = new ModalBuilder().setCustomId(`ifbm:${ids.itemId}:${ids.userId}:${ids.code}`);
  return ids.solved
    ? modal
        .setTitle(ids.verified === false ? "Thanks! Quick feedback" : "Glad it's solved! Quick feedback")
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

async function handleButton(interaction: ButtonInteraction, ids: FeedbackIds) {
  // Anyone involved may answer (Leon 2026-10-03: "multiple people should be able to send
  // feedback") - often several players share the same problem.
  await interaction.showModal(feedbackModal(ids));
}

async function handleModal(interaction: ModalSubmitInteraction, ids: FeedbackIds) {
  const first = interaction.fields.getTextInputValue("first").trim();
  const second = interaction.fields.getTextInputValue("second").trim();
  const comment = feedbackComment(ids.solved, first, second);
  const label = !ids.solved
    ? "Thanks, I'll take another look"
    : ids.verified === false
      ? "Thanks! If it doesn't work once you try it, just reply here"
      : "Thanks for your feedback!";
  // Answer within Discord's 3 s window first, then log. The answer goes public on the reply
  // itself (withFeedbackLine) and the buttons STAY, so others can add theirs; the thank-you is
  // only shown to the person who answered.
  if (interaction.isFromMessage() && interaction.message) {
    await interaction.update({
      content: withFeedbackLine(interaction.message.content, {
        userId: interaction.user.id,
        solved: ids.solved,
        verified: ids.verified,
        first,
        second,
      }),
      allowedMentions: { parse: [], users: [] },
    });
    await interaction.followUp({ content: label, flags: MessageFlags.Ephemeral }).catch(() => {});
  } else {
    await interaction.reply({ content: label, flags: MessageFlags.Ephemeral });
  }

  const user = interaction.user.username;
  await inboxApi(`/inbox/${ids.itemId}/feedback`, "POST", {
    rating: ids.solved ? "solved" : "unsolved",
    user,
    comment: comment || undefined,
    verified: ids.verified,
  });
  const rated = await inboxApi<{
    item: { fingerprint: string; source: string; title: string; app_id: string | null };
  }>(`/inbox/${ids.itemId}`);
  if (!rated?.item) return;
  const where = interaction.message?.url ?? "";

  await postToFeedbackChannel(interaction, {
    text: feedbackChannelText({
      solved: ids.solved,
      verified: ids.verified,
      userId: interaction.user.id,
      itemId: ids.itemId,
      title: rated.item.title,
      where,
      first,
      second,
    }),
  });

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
      detail: `Feedback: SOLVED${
        ids.verified === true ? " (checked it)" : ids.verified === false ? " (not checked yet)" : ""
      } from ${user} (<@${interaction.user.id}>)\n${comment}`,
      data: { itemId: ids.itemId, userId: interaction.user.id, solved: true, verified: ids.verified },
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
