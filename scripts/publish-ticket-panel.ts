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
    "**Before opening a ticket, please check the following:**\n\n" +
      "- Use the [**Discord search**](https://support.discord.com/hc/en-us/articles/115000468588-Using-Search) to see if your question has already been answered.\n" +
      "- Check the `#updates` channels for the latest info on each game.\n" +
      "- Visit the <#1038352744341311528> for answers to common questions.\n" +
      "- Do NOT write the same request in multiple channels!\n\n" +
      "If you can't find what you're looking for, click **📩 Open ticket** below — we're here to help!\n" +
      "Your ticket is a private thread that only you and the staff can see. " +
      "If you close it, you can reopen it later — your history stays.",
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
