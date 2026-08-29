import {
  ApplicationCommandOptionType,
  EmbedBuilder,
  Events,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { UPDATES_CHANNELS } from "./channels";
import { getMessagesFromCentralChannel } from "./game-updates";

/**
 * `/updates` slash command: latest release notes for a game, straight from
 * the central app-updates channel (same matching as /api/updates/{game}).
 */

const UPDATES_COMMAND = "updates";
const TEXT_LIMIT = 1500;

function searchGames(query: string): string[] {
  const q = query.toLowerCase().trim();
  const names = UPDATES_CHANNELS.map((c) => c.name);
  const matches = q ? names.filter((name) => name.includes(q)) : names;
  return matches.slice(0, 25);
}

async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const query = interaction.options.getFocused();
  await interaction.respond(
    searchGames(query).map((name) => ({ name, value: name })),
  );
}

async function handleCommand(interaction: ChatInputCommandInteraction) {
  const game = interaction.options.getString("game", true);

  if (!UPDATES_CHANNELS.some((c) => c.name === game)) {
    await interaction.reply({
      content: `Unknown game "${game.slice(0, 100)}" — pick one from the autocomplete.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  const messages = await getMessagesFromCentralChannel(game, 1);
  const latest = messages[0];

  if (!latest) {
    await interaction.editReply({
      content: `No recent update found for **${game}** in the app-updates cache.`,
    });
    return;
  }

  const text =
    latest.text.length > TEXT_LIMIT
      ? latest.text.slice(0, TEXT_LIMIT).trimEnd() + "\n…"
      : latest.text;

  const embed = new EmbedBuilder()
    .setTitle(`Latest update — ${game}`)
    .setDescription(text || "*(no text)*")
    .setColor(0x57f287)
    .setTimestamp(latest.timestamp);
  if (latest.images[0]) {
    embed.setImage(latest.images[0]);
  }

  await interaction.editReply({ embeds: [embed] });
}

export function registerUpdatesCommand(client: Client) {
  const guild = client.guilds.cache.first();
  if (!guild) {
    return;
  }

  void guild.commands
    .create({
      name: UPDATES_COMMAND,
      description: "Show the latest release notes for a game/app",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "game",
          description: "Which game/app",
          required: true,
          autocomplete: true,
        },
      ],
    })
    .then(() => console.log("[updates-command] /updates registered"))
    .catch((err) =>
      console.error("[updates-command] registration failed", err),
    );

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (
        interaction.isAutocomplete() &&
        interaction.commandName === UPDATES_COMMAND
      ) {
        await handleAutocomplete(interaction);
      } else if (
        interaction.isChatInputCommand() &&
        interaction.commandName === UPDATES_COMMAND
      ) {
        await handleCommand(interaction);
      }
    } catch (err) {
      console.error("[updates-command] interaction failed", err);
      if (interaction.isChatInputCommand() && interaction.isRepliable()) {
        try {
          if (interaction.deferred) {
            await interaction.editReply({
              content: "Something went wrong — please try again.",
            });
          } else if (!interaction.replied) {
            await interaction.reply({
              content: "Something went wrong — please try again.",
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch {
          // Nothing sensible left to do.
        }
      }
    }
  });
}
