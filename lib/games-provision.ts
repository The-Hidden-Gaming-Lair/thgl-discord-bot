import {
  ChannelType,
  GuildChannel,
  CategoryChannel,
  type Channel,
  type Role,
  type TextChannel,
} from "discord.js";
import { getChannel } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID } from "./game-roles";
import { getCanonicalGames } from "./games-feed";

const APPS_AND_GAMES_CATEGORY = "Apps & Games";

/** GuildText channels under "Apps & Games" that are NOT game discussion
 *  channels (so they are never treated as orphaned games). */
const NON_GAME_CHANNELS = new Set<string>(["other-games"]);

// Discord stores channel names lowercased with spaces -> hyphens.
const channelKey = (name: string) => name.toLowerCase().replace(/\s+/g, "-");

export interface ReconcileResult {
  rolesCreated: string[];
  rolesWouldCreate: string[];
  channelsCreated: string[];
  channelsWouldCreate: string[];
  orphanChannels: string[];
}

export async function reconcileGames(
  opts: { apply?: boolean } = {},
): Promise<ReconcileResult> {
  const apply = opts.apply ?? false;
  const games = await getCanonicalGames(true);

  const central = getChannel(CENTRAL_UPDATES_CHANNEL_ID) as GuildChannel;
  const guild = central.guild;
  await guild.roles.fetch();
  await guild.channels.fetch();

  const roleByTitle = new Map<string, Role>();
  for (const r of guild.roles.cache.values()) roleByTitle.set(r.name.toLowerCase(), r);

  const category = [...guild.channels.cache.values()].find(
    (c: Channel) => c.type === ChannelType.GuildCategory && c.name === APPS_AND_GAMES_CATEGORY,
  ) as CategoryChannel;
  if (!category) throw new Error(`Category "${APPS_AND_GAMES_CATEGORY}" not found`);

  const textChannelByName = new Map<string, TextChannel>();
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildText)
      textChannelByName.set(channelKey(c.name), c as TextChannel);
  }

  const result: ReconcileResult = {
    rolesCreated: [], rolesWouldCreate: [],
    channelsCreated: [], channelsWouldCreate: [], orphanChannels: [],
  };

  for (const game of games) {
    // Role (named by title)
    if (!roleByTitle.has(game.title.toLowerCase())) {
      if (apply) {
        const role = await guild.roles.create({ name: game.title, mentionable: true });
        roleByTitle.set(game.title.toLowerCase(), role);
        result.rolesCreated.push(game.title);
        console.log(`[apply] created role: ${game.title}`);
      } else {
        result.rolesWouldCreate.push(game.title);
      }
    }
    // Discussion channel #<discordId> under Apps & Games
    if (!textChannelByName.has(channelKey(game.discordId))) {
      if (apply) {
        const ch = await guild.channels.create({
          name: channelKey(game.discordId),
          type: ChannelType.GuildText,
          parent: category.id,
        });
        textChannelByName.set(channelKey(game.discordId), ch);
        result.channelsCreated.push(game.discordId);
        console.log(`[apply] created channel: #${game.discordId}`);
      } else {
        result.channelsWouldCreate.push(game.discordId);
      }
    }
  }

  // Orphans (report only): GuildText channels under the category whose name is
  // not a canonical discordId and not in the non-game allow-list.
  // Asymmetry: roles are intentionally NOT orphan-reported or deleted (they
  // have non-game uses and deletes are out of scope); only channels are
  // orphan-reported here.
  const canonical = new Set(games.map((g) => channelKey(g.discordId)));
  for (const c of guild.channels.cache.values()) {
    if (
      c.parentId === category.id &&
      c.type === ChannelType.GuildText &&
      !canonical.has(channelKey(c.name)) &&
      !NON_GAME_CHANNELS.has(channelKey(c.name))
    ) {
      result.orphanChannels.push(c.name);
    }
  }
  return result;
}
