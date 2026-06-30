import { GuildChannel } from "discord.js";
import { getChannel } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID, getGameConfig } from "./game-roles";
import { getCanonicalGames } from "./games-feed";

const TTL_MS = 5 * 60 * 1000;
let roleCache: { at: number; byTitle: Map<string, string> } | null = null;

/** name(lowercased) -> roleId, from the live guild. Cached for 5 minutes. */
async function guildRoleIndex(): Promise<Map<string, string>> {
  if (roleCache && Date.now() - roleCache.at < TTL_MS) return roleCache.byTitle;
  try {
    const channel = getChannel(CENTRAL_UPDATES_CHANNEL_ID) as GuildChannel;
    console.log("[game-resolver] Fetching guild roles...");
    const roles = await channel.guild.roles.fetch();
    const byTitle = new Map<string, string>();
    for (const role of roles.values()) byTitle.set(role.name.toLowerCase(), role.id);
    roleCache = { at: Date.now(), byTitle };
    return byTitle;
  } catch (err) {
    console.warn(
      `[game-resolver] guild roles fetch failed, using hardcoded fallback: ${(err as Error).message}`,
    );
    return new Map();
  }
}

/**
 * Resolve a game's Discord role id: prefer the live guild role whose NAME
 * matches the canonical game title; fall back to the first hardcoded roleId
 * in game-roles.ts. Returns null if neither resolves.
 */
export async function resolveRoleId(discordId: string): Promise<string | null> {
  const games = await getCanonicalGames();
  const title = games.find((g) => g.discordId === discordId)?.title;
  if (title) {
    const live = (await guildRoleIndex()).get(title.toLowerCase());
    if (live) return live;
  }
  return getGameConfig(discordId)?.roleIds?.[0] ?? null;
}
