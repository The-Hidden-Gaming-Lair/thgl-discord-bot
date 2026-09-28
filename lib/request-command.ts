import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import {
  fetchGames,
  postInThread,
  requestGame,
  searchGames,
  syncGameRequests,
  type SearchResult,
} from "./game-requests";

/**
 * `/request` slash command: request support for a game from Discord.
 *
 * Autocomplete searches Steam through www.th.gl/api/stats/search (same
 * search as www.th.gl/requests). A new game is requested on the website as
 * `discord:<user id>` and its #game-requests thread is created right away.
 * For a game that's already tracked, the reply points to its thread (votes
 * are the 👍 reactions there) or, when supported, to its tools.
 * Games that aren't on Steam go through the website form (reviewed first).
 */

const REQUEST_COMMAND = "request";
const SITE_URL = "https://www.th.gl";
const SEARCH_CACHE_TTL_MS = 60 * 1000;

const searchCache = new Map<string, { at: number; results: SearchResult[] }>();

async function cachedSearch(q: string): Promise<SearchResult[]> {
  const key = q.toLowerCase().trim();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit.results;
  const results = await searchGames(key);
  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > 500) searchCache.clear();
  return results;
}

const STATUS_SUFFIX: Record<string, string> = {
  supported: " (supported)",
  in_progress: " (in progress)",
  watching: " (watching)",
  requested: " (requested)",
  declined: " (declined)",
};

async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const query = interaction.options.getFocused().trim();
  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }
  const results = await cachedSearch(query);
  await interaction.respond(
    results.slice(0, 25).map((r) => {
      const suffix = r.tracked ? (STATUS_SUFFIX[r.tracked.status] ?? "") : "";
      const name = `${r.name}${suffix}`;
      return {
        name: name.length > 100 ? name.slice(0, 99) + "…" : name,
        value: String(r.appId),
      };
    }),
  );
}

async function threadIdFor(gameId: string): Promise<string | null> {
  const game = (await fetchGames()).find((g) => g.id === gameId);
  return game?.discordThreadId ?? null;
}

async function threadLink(gameId: string): Promise<string | null> {
  const id = await threadIdFor(gameId);
  return id ? `<#${id}>` : null;
}

/** Post the optional /request details into the game's thread. */
async function postDetails(
  gameId: string,
  userId: string,
  details: string | null,
  created: boolean,
) {
  if (!details) return;
  const id = await threadIdFor(gameId);
  if (!id) return;
  await postInThread(
    id,
    `${created ? "📝 Requested by" : "💬"} <@${userId}>:\n${details}`,
  );
}

async function handleCommand(interaction: ChatInputCommandInteraction) {
  const input = interaction.options.getString("game", true).trim();
  const details = interaction.options.getString("details")?.trim() || null;
  // Autocomplete picks send the Steam app id; free text falls back to the
  // best search hit.
  let appId = /^\d+$/.test(input) ? Number(input) : null;
  let picked: SearchResult | undefined;
  if (appId === null) {
    picked = (await cachedSearch(input))[0];
    appId = picked?.appId ?? null;
  }
  if (appId === null) {
    await interaction.reply({
      content: `I couldn't find "${input.slice(0, 100)}" on Steam. Games that aren't on Steam can be requested with a link at ${SITE_URL}/requests`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const tracked =
    picked?.tracked ??
    (await cachedSearch(input)).find((r) => r.appId === appId)?.tracked ??
    null;
  if (tracked) {
    const link = await threadLink(tracked.id);
    if (tracked.status === "supported") {
      await interaction.editReply(
        `That game is already supported: ${SITE_URL}/stats/${tracked.id}`,
      );
    } else if (tracked.status === "declined") {
      await interaction.editReply(
        `That game was already reviewed and won't get support for now: ${SITE_URL}/stats/${tracked.id}`,
      );
    } else {
      await postDetails(tracked.id, interaction.user.id, details, false).catch(
        () => undefined,
      );
      await interaction.editReply(
        `That game is already requested. Vote with 👍 on ${link ?? "its post in #game-requests"} or at ${SITE_URL}/requests.` +
          (details ? " Your details were added to the post." : ""),
      );
    }
    return;
  }

  const result = await requestGame(appId, interaction.user.id);
  if (!result.created) {
    await postDetails(result.id, interaction.user.id, details, false).catch(
      () => undefined,
    );
    const link = await threadLink(result.id);
    await interaction.editReply(
      `**${result.title}** is already on the list. Vote with 👍 on ${link ?? "its post in #game-requests"}.`,
    );
    return;
  }
  // Create the thread now instead of waiting for the next scheduled run.
  await syncGameRequests(result.id).catch(() => undefined);
  await postDetails(result.id, interaction.user.id, details, true).catch(
    () => undefined,
  );
  const link = await threadLink(result.id);
  await interaction.editReply(
    `Thanks! **${result.title}** is now requested: ${link ?? `${SITE_URL}/stats/${result.id}`}. Your vote is counted; others can vote with 👍 on the post.` +
      (details ? "" : " Add what the map or app should cover as a reply there."),
  );
}

export function registerRequestCommand(client: Client) {
  if (!process.env.STATS_BOT_SECRET) {
    console.log("[request-command] STATS_BOT_SECRET not set, /request not registered");
    return;
  }
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.log("[request-command] no guild in cache, command not registered");
    return;
  }

  // Guild command (instant availability). Creating a command with an
  // existing name overwrites it, safe on reboots.
  void guild.commands
    .create({
      name: REQUEST_COMMAND,
      description: "Request support for a new game on TH.GL",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "game",
          description: "Search Steam for the game",
          required: true,
          autocomplete: true,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: "details",
          description:
            "What should the map or app cover? Features, locations, useful links",
          required: false,
          max_length: 1000,
        },
      ],
    })
    .then(() => console.log("[request-command] /request registered"))
    .catch((err) => console.error("[request-command] registration failed", err));

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (
        interaction.isAutocomplete() &&
        interaction.commandName === REQUEST_COMMAND
      ) {
        await handleAutocomplete(interaction);
      } else if (
        interaction.isChatInputCommand() &&
        interaction.commandName === REQUEST_COMMAND
      ) {
        await handleCommand(interaction);
      }
    } catch (err: any) {
      console.error("[request-command] interaction failed", err);
      if (!interaction.isChatInputCommand()) return;
      // Website errors (e.g. the daily request limit) are user-facing text.
      const message =
        typeof err?.message === "string" && err.message.length < 300
          ? err.message
          : "Something went wrong, please try again.";
      try {
        if (interaction.deferred) await interaction.editReply(message);
        else if (!interaction.replied) {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
      } catch {
        // Nothing sensible left to do.
      }
    }
  });
}
