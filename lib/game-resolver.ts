import { GuildChannel, Routes } from "discord.js";
import { getChannel } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID, GAME_CONFIGS, getGameConfig } from "./game-roles";
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

/**
 * Every Discord role id that stands for a game: the live guild role whose name
 * matches a canonical game title, plus every hardcoded fallback id. Deliberately
 * over-inclusive — it is used to decide whether an account looks like a real
 * member (spam-guard Rule 0), so a missed id must never cost someone a ban.
 */
export async function getGameRoleIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const config of GAME_CONFIGS) {
    for (const id of config.roleIds ?? []) ids.add(id);
  }
  const byTitle = await guildRoleIndex();
  for (const game of await getCanonicalGames()) {
    const live = byTitle.get(game.title.toLowerCase());
    if (live) ids.add(live);
  }
  return ids;
}

let onboardingRoleCache: { at: number; ids: Set<string> } | null = null;

/**
 * Every role id an onboarding option can grant — including non-game ones such as
 * Coding/Development, and games whose role name does not match the canonical
 * title. Cached for 5 minutes.
 */
export async function getOnboardingRoleIds(): Promise<Set<string>> {
  if (onboardingRoleCache && Date.now() - onboardingRoleCache.at < TTL_MS) {
    return onboardingRoleCache.ids;
  }
  const channel = getChannel(CENTRAL_UPDATES_CHANNEL_ID) as GuildChannel;
  const onboarding = (await channel.guild.client.rest.get(
    Routes.guildOnboarding(channel.guild.id),
  )) as { prompts?: { options?: { role_ids?: string[] }[] }[] };
  const ids = new Set<string>();
  for (const prompt of onboarding.prompts ?? []) {
    for (const option of prompt.options ?? []) {
      for (const id of option.role_ids ?? []) ids.add(id);
    }
  }
  onboardingRoleCache = { at: Date.now(), ids };
  return ids;
}

/**
 * Roles a real member can end up with by going through the server: every
 * onboarding-grantable role plus every game role. Used by spam-guard Rule 0 to
 * decide whether an account ever completed onboarding, so it is deliberately
 * over-inclusive — a role missing here would cost someone a ban.
 */
export async function getSelfAssignableRoleIds(): Promise<Set<string>> {
  const ids = await getGameRoleIds();
  try {
    for (const id of await getOnboardingRoleIds()) ids.add(id);
  } catch (err) {
    console.warn(
      `[game-resolver] onboarding roles fetch failed: ${(err as Error).message}`,
    );
  }
  return ids;
}
