import { ChannelType, GuildChannel } from "discord.js";
import { getChannel } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID } from "./game-roles";
import { getCanonicalGames } from "./games-feed";

const APPS_AND_GAMES_CATEGORY = "Apps & Games";

/** GuildText channels under "Apps & Games" that are NOT game discussion
 *  channels (so they are never treated as orphaned games). */
const NON_GAME_CHANNELS = new Set<string>(["other-games"]);

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

  const roleByTitle = new Map<string, any>();
  for (const r of guild.roles.cache.values()) roleByTitle.set(r.name.toLowerCase(), r);

  const category = [...guild.channels.cache.values()].find(
    (c: any) => c.type === ChannelType.GuildCategory && c.name === APPS_AND_GAMES_CATEGORY,
  ) as any;
  if (!category) throw new Error(`Category "${APPS_AND_GAMES_CATEGORY}" not found`);

  const textChannelByName = new Map<string, any>();
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildText) textChannelByName.set(c.name.toLowerCase(), c);
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
      } else {
        result.rolesWouldCreate.push(game.title);
      }
    }
    // Discussion channel #<discordId> under Apps & Games
    if (!textChannelByName.has(game.discordId.toLowerCase())) {
      if (apply) {
        const ch = await guild.channels.create({
          name: game.discordId,
          type: ChannelType.GuildText,
          parent: category.id,
        });
        textChannelByName.set(game.discordId.toLowerCase(), ch);
        result.channelsCreated.push(game.discordId);
      } else {
        result.channelsWouldCreate.push(game.discordId);
      }
    }
  }

  // Orphans (report only): GuildText channels under the category whose name is
  // not a canonical discordId and not in the non-game allow-list.
  const canonical = new Set(games.map((g) => g.discordId.toLowerCase()));
  for (const c of guild.channels.cache.values()) {
    if (
      (c as any).parentId === category.id &&
      c.type === ChannelType.GuildText &&
      !canonical.has(c.name.toLowerCase()) &&
      !NON_GAME_CHANNELS.has(c.name.toLowerCase())
    ) {
      result.orphanChannels.push(c.name);
    }
  }
  return result;
}
