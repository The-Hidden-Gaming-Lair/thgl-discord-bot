import {
  ChannelType,
  GuildChannel,
  CategoryChannel,
  Routes,
  type Channel,
  type Guild,
  type Role,
  type TextChannel,
} from "discord.js";
import { getChannel } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID, getGameConfig } from "./game-roles";
import { getCanonicalGames } from "./games-feed";
import { resolveRoleId } from "./game-resolver";

let reconcileInFlight = false;

const APPS_AND_GAMES_CATEGORY = "Apps & Games";

const GAME_ONBOARDING_PROMPT_ID = "1100586372844228610";
const ONBOARDING_OPTION_SOFT_CAP = 50;

/** GuildText channels under "Apps & Games" that are NOT game discussion
 *  channels for one of the canonical games (companion apps, trackers, tools),
 *  so they are never treated as orphaned games. */
const NON_GAME_CHANNELS = new Set<string>([
  "other-games",
  "thgl-companion-app",
  "new-world-companion",
  "diablo-iv-companion",
  "palia-tracker",
  "skeleton",
]);

/**
 * Canonical `discordId` -> existing discussion-channel name, for the games
 * whose channel predates the discordId naming convention. The reconciler
 * treats these legacy channels as the game's channel (so it never creates a
 * duplicate); brand-new games still get a `#<discordId>` channel. Owner chose
 * this alias-map approach over renaming the live channels.
 */
const CHANNEL_ALIASES: Record<string, string> = {
  "aeternum-map": "new-world-map",
  "sons-of-the-forest-map": "sons-of-the-forest",
  "hogwarts-legacy-map": "hogwarts-legacy",
  "conan-exiles": "conan-exiles-enhanced",
  "rsdragonwilds": "runescape-dragonwilds",
  "diablo4": "diablo-iv-map",
  "palia": "palia-map",
};

// Discord stores channel names lowercased with spaces -> hyphens.
const channelKey = (name: string) => name.toLowerCase().replace(/\s+/g, "-");

/** The channel-name key a game's discussion channel is expected under: the
 *  legacy alias if one exists, otherwise the canonical discordId. */
const expectedChannelKey = (discordId: string) =>
  channelKey(CHANNEL_ALIASES[discordId] ?? discordId);

export interface ReconcileResult {
  rolesCreated: string[];
  rolesWouldCreate: string[];
  channelsCreated: string[];
  channelsWouldCreate: string[];
  orphanChannels: string[];
  onboardingWouldAdd: string[];
  onboardingAdded: string[];
  onboardingSkippedNoRole: string[];
  onboardingNearCap: boolean;
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
    onboardingWouldAdd: [], onboardingAdded: [], onboardingSkippedNoRole: [],
    onboardingNearCap: false,
  };

  for (const game of games) {
    // Role: exists if a guild role matches the canonical title, OR a hardcoded
    // roleId in game-roles.ts points to a live role. The latter covers games
    // whose canonical title differs from the existing role name (e.g.
    // "Heroes of Might & Magic: Olden Era" vs the role "HoMM: Olden Era"),
    // so apply mode never creates a duplicate role for them.
    const hardcodedRoleId = getGameConfig(game.discordId)?.roleIds?.[0];
    const hasRole =
      roleByTitle.has(game.title.toLowerCase()) ||
      (hardcodedRoleId ? guild.roles.cache.has(hardcodedRoleId) : false);
    if (!hasRole) {
      if (apply) {
        const role = await guild.roles.create({ name: game.title, mentionable: true });
        roleByTitle.set(game.title.toLowerCase(), role);
        result.rolesCreated.push(game.title);
        console.log(`[apply] created role: ${game.title}`);
      } else {
        result.rolesWouldCreate.push(game.title);
      }
    }
    // Discussion channel under Apps & Games. Existing channel may be under a
    // legacy alias name; only a game with NO channel (by alias or discordId)
    // gets a new #<discordId> channel.
    if (!textChannelByName.has(expectedChannelKey(game.discordId))) {
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
  const canonical = new Set(games.map((g) => expectedChannelKey(g.discordId)));
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

  await reconcileOnboarding(guild, games, roleByTitle, textChannelByName, apply, result);

  return result;
}

/**
 * Concurrency-guarded wrapper around reconcileGames. Returns
 * { alreadyRunning: true } if a run is in flight, else
 * { alreadyRunning: false, result }. Use this from the HTTP route and the
 * scheduler so a scheduled tick and a manual sync can't run concurrently
 * (which, in apply mode, could create duplicate roles/channels).
 */
export async function runReconcileGames(
  opts: { apply?: boolean } = {},
): Promise<{ alreadyRunning: boolean; result?: ReconcileResult }> {
  if (reconcileInFlight) return { alreadyRunning: true };
  reconcileInFlight = true;
  try {
    const result = await reconcileGames(opts);
    return { alreadyRunning: false, result };
  } finally {
    reconcileInFlight = false;
  }
}

async function reconcileOnboarding(
  guild: Guild,
  games: { discordId: string; title: string }[],
  roleByTitle: Map<string, Role>,
  textChannelByName: Map<string, any>,
  apply: boolean,
  result: ReconcileResult,
) {
  const onboarding: any = await guild.client.rest.get(Routes.guildOnboarding(guild.id));
  const prompt = (onboarding.prompts ?? []).find(
    (p: any) => p.id === GAME_ONBOARDING_PROMPT_ID,
  );
  if (!prompt) {
    throw new Error(`Onboarding prompt ${GAME_ONBOARDING_PROMPT_ID} not found`);
  }

  const coveredRoleIds = new Set<string>();
  for (const o of prompt.options ?? [])
    for (const rid of o.role_ids ?? []) coveredRoleIds.add(rid);

  // Resolve each game's role id, preferring the live in-run map (covers roles
  // created earlier in this same apply run, before resolveRoleId's cache sees
  // them), then the resolver. Games with no role at all are skipped: we cannot
  // build a meaningful onboarding option without a role.
  const missing: { title: string; roleId: string; discordId: string }[] = [];
  for (const game of games) {
    const roleId =
      roleByTitle.get(game.title.toLowerCase())?.id ?? (await resolveRoleId(game.discordId));
    if (!roleId) {
      result.onboardingSkippedNoRole.push(game.title);
      continue;
    }
    if (!coveredRoleIds.has(roleId)) {
      missing.push({ title: game.title, roleId, discordId: game.discordId });
    }
  }
  if (missing.length === 0) return;

  if (prompt.options.length + missing.length >= ONBOARDING_OPTION_SOFT_CAP) {
    result.onboardingNearCap = true;
    console.warn(
      `[provision] onboarding prompt nearing ${ONBOARDING_OPTION_SOFT_CAP}-option cap ` +
        `(${prompt.options.length} existing + ${missing.length} new)`,
    );
  }

  for (const m of missing) {
    if (!apply) {
      result.onboardingWouldAdd.push(m.title);
      continue;
    }
    const ch = textChannelByName.get(expectedChannelKey(m.discordId));
    prompt.options.push({
      title: m.title,
      role_ids: [m.roleId],
      channel_ids: ch ? [ch.id] : [],
      description: null,
      emoji_id: null,
      emoji_name: null,
      emoji_animated: false,
    });
    console.log(`[apply] added onboarding option: ${m.title}`);
    result.onboardingAdded.push(m.title);
  }

  if (apply && result.onboardingAdded.length > 0) {
    await guild.client.rest.put(Routes.guildOnboarding(guild.id), {
      body: {
        enabled: onboarding.enabled,
        default_channel_ids: onboarding.default_channel_ids,
        mode: onboarding.mode,
        prompts: onboarding.prompts,
      },
      reason: "games-provision: add onboarding options for new games",
    });
  }
}
