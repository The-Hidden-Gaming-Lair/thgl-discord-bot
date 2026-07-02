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
import { getCanonicalGames, type CanonicalGame } from "./games-feed";
import { resolveRoleId } from "./game-resolver";

let reconcileInFlight = false;

const APPS_AND_GAMES_CATEGORY = "Apps & Games";

const GAME_ONBOARDING_PROMPT_ID = "1100586372844228610";
const ONBOARDING_OPTION_SOFT_CAP = 50;

// Onboarding options pinned to the top of the game prompt, in this order; the
// remaining (game) options sort alphabetically by title below them.
const ONBOARDING_PIN_TOP_TITLES = ["Coding/Development", "THGL Companion App"];

// Channels pinned to the top/bottom of "Apps & Games" when sorting (the rest
// of the game channels sort alphabetically between them).
const CHANNEL_PIN_TOP = "thgl-companion-app";
const CHANNEL_PIN_BOTTOM = "other-games";

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
  /** Guild emojis uploaded (apply) / needed (dry-run) from the games feed's logo. */
  emojisCreated: string[];
  emojisWouldCreate: string[];
  /** Existing onboarding options whose missing emoji was (would be) filled in. */
  onboardingEmojisSet: string[];
  onboardingEmojisWouldSet: string[];
  /** Whether the onboarding option order was (would be) re-sorted. */
  onboardingSorted: boolean;
  onboardingWouldSort: boolean;
  /** Set if the onboarding update was attempted but failed (e.g. the bot lacks
   *  Manage Guild). Roles/channels are unaffected; onboarding is left untouched. */
  onboardingError?: string;
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
    emojisCreated: [], emojisWouldCreate: [],
    onboardingEmojisSet: [], onboardingEmojisWouldSet: [],
    onboardingSorted: false, onboardingWouldSort: false,
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

  // Keep the category tidy: if we created channels, re-sort so new ones land
  // in alphabetical position instead of at the end.
  if (apply && result.channelsCreated.length > 0) {
    await sortAppsAndGamesChannels(guild, category);
  }

  return result;
}

/**
 * Reorder the "Apps & Games" category: pinned specials first
 * (#thgl-companion-app plus the non-text info/updates channels), then the game
 * discussion channels A-Z, then #other-games last. Positions only — never
 * adds/removes a channel (aborts if the child count wouldn't be preserved).
 */
async function sortAppsAndGamesChannels(guild: Guild, category: CategoryChannel) {
  await guild.channels.fetch();
  const kids = [...guild.channels.cache.values()].filter(
    (c) => c.parentId === category.id,
  );
  const nonText = kids
    .filter((c) => c.type !== ChannelType.GuildText)
    .sort((a: any, b: any) => a.rawPosition - b.rawPosition);
  const pinTop = kids.find((c) => channelKey(c.name) === CHANNEL_PIN_TOP);
  const pinBottom = kids.find((c) => channelKey(c.name) === CHANNEL_PIN_BOTTOM);
  const gameChannels = kids
    .filter(
      (c) =>
        c.type === ChannelType.GuildText &&
        channelKey(c.name) !== CHANNEL_PIN_TOP &&
        channelKey(c.name) !== CHANNEL_PIN_BOTTOM,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const ordered = [
    ...nonText,
    ...(pinTop ? [pinTop] : []),
    ...gameChannels,
    ...(pinBottom ? [pinBottom] : []),
  ];
  // Safety: only reposition if every child is accounted for exactly once.
  if (ordered.length !== kids.length) {
    console.warn(
      `[provision] skipping channel sort: ordered ${ordered.length} != ${kids.length} children`,
    );
    return;
  }
  await guild.channels.setPositions(
    ordered.map((c, i) => ({ channel: c.id, position: i })),
  );
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

/** Loose key for matching guild emoji names to game slugs/titles/logo names
 *  (":AeternumMap:" ~ "aeternum-map", ":starresonance:" ~ "starresonance.webp"). */
const emojiKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function findGameEmoji(guild: Guild, game: CanonicalGame) {
  const logoBase = game.logo?.split("/").pop()?.replace(/\.\w+$/, "") ?? "";
  const wanted = new Set(
    [game.discordId, game.id, game.title, logoBase].filter(Boolean).map(emojiKey),
  );
  return guild.emojis.cache.find((e) => wanted.has(emojiKey(e.name ?? ""))) ?? null;
}

/**
 * Get the guild emoji id for a game, uploading it from the games feed's `logo`
 * URL when absent (apply mode; additive only — never deletes/renames emojis).
 * Dry-run reports the would-be upload instead. Returns null if unresolvable.
 */
async function ensureGameEmoji(
  guild: Guild,
  game: CanonicalGame,
  apply: boolean,
  result: ReconcileResult,
): Promise<string | null> {
  const existing = findGameEmoji(guild, game);
  if (existing) return existing.id;
  if (!game.logo) return null;
  const name = emojiKey(game.discordId).slice(0, 32);
  if (!apply) {
    if (!result.emojisWouldCreate.includes(name)) result.emojisWouldCreate.push(name);
    return null;
  }
  try {
    const res = await fetch(game.logo);
    if (!res.ok) throw new Error(`logo fetch ${res.status}`);
    const created = await guild.emojis.create({
      attachment: Buffer.from(await res.arrayBuffer()),
      name,
    });
    console.log(`[apply] created emoji :${name}: from ${game.logo}`);
    result.emojisCreated.push(name);
    return created.id;
  } catch (err) {
    console.warn(
      `[provision] emoji create failed for ${game.discordId}: ${(err as Error).message}`,
    );
    return null;
  }
}

async function reconcileOnboarding(
  guild: Guild,
  games: CanonicalGame[],
  roleByTitle: Map<string, Role>,
  textChannelByName: Map<string, any>,
  apply: boolean,
  result: ReconcileResult,
) {
  await guild.emojis.fetch();
  const onboarding: any = await guild.client.rest.get(Routes.guildOnboarding(guild.id));
  const prompt = (onboarding.prompts ?? []).find(
    (p: any) => p.id === GAME_ONBOARDING_PROMPT_ID,
  );
  if (!prompt) {
    throw new Error(`Onboarding prompt ${GAME_ONBOARDING_PROMPT_ID} not found`);
  }

  // Snapshot the existing options so we can prove, before the full-replace PUT,
  // that we only ever ADD — never drop an existing option or an emoji.
  const originalOptionIds = new Set<string>(
    (prompt.options ?? []).map((o: any) => o.id).filter(Boolean),
  );
  const originalOptionCount = (prompt.options ?? []).length;
  const originalEmojiCount = (prompt.options ?? []).filter(
    (o: any) => o.emoji?.id || o.emoji?.name || o.emoji_id || o.emoji_name,
  ).length;

  const coveredRoleIds = new Set<string>();
  for (const o of prompt.options ?? [])
    for (const rid of o.role_ids ?? []) coveredRoleIds.add(rid);

  // Resolve each game's role id, preferring the live in-run map (covers roles
  // created earlier in this same apply run, before resolveRoleId's cache sees
  // them), then the resolver. Games with no role at all are skipped: we cannot
  // build a meaningful onboarding option without a role.
  const missing: { game: CanonicalGame; roleId: string }[] = [];
  for (const game of games) {
    const roleId =
      roleByTitle.get(game.title.toLowerCase())?.id ?? (await resolveRoleId(game.discordId));
    if (!roleId) {
      result.onboardingSkippedNoRole.push(game.title);
      continue;
    }
    if (!coveredRoleIds.has(roleId)) {
      missing.push({ game, roleId });
    }
  }

  if (missing.length > 0 && prompt.options.length + missing.length >= ONBOARDING_OPTION_SOFT_CAP) {
    result.onboardingNearCap = true;
    console.warn(
      `[provision] onboarding prompt nearing ${ONBOARDING_OPTION_SOFT_CAP}-option cap ` +
        `(${prompt.options.length} existing + ${missing.length} new)`,
    );
  }

  // Fill in missing emojis on EXISTING options (self-healing; matches the
  // option to its game by title, then to a guild emoji, uploading from the
  // feed's logo if the guild has none).
  const gameByTitle = new Map(games.map((g) => [g.title.toLowerCase(), g]));
  for (const o of prompt.options ?? []) {
    if (o.emoji?.id || o.emoji?.name || o.emoji_id || o.emoji_name) continue;
    const game = gameByTitle.get(o.title?.toLowerCase?.() ?? "");
    if (!game) continue; // non-game option (pinned specials) — leave alone
    const emojiId = await ensureGameEmoji(guild, game, apply, result);
    if (!emojiId) continue;
    if (apply) {
      o.emoji_id = emojiId;
      result.onboardingEmojisSet.push(o.title);
    } else {
      result.onboardingEmojisWouldSet.push(o.title);
    }
  }

  const addedTitles: string[] = [];
  for (const m of missing) {
    const emojiId = await ensureGameEmoji(guild, m.game, apply, result);
    if (!apply) {
      result.onboardingWouldAdd.push(m.game.title);
      continue;
    }
    const ch = textChannelByName.get(expectedChannelKey(m.game.discordId));
    prompt.options.push({
      title: m.game.title,
      role_ids: [m.roleId],
      channel_ids: ch ? [ch.id] : [],
      description: null,
      emoji_id: emojiId,
      emoji_name: null,
      emoji_animated: false,
    });
    addedTitles.push(m.game.title);
  }

  // Sort: pinned specials first (in ONBOARDING_PIN_TOP_TITLES order), then all
  // game options A-Z by title. Pure reorder of the same option objects.
  const pinned = ONBOARDING_PIN_TOP_TITLES
    .map((t) => prompt.options.find((o: any) => o.title === t))
    .filter(Boolean);
  const rest = prompt.options
    .filter((o: any) => !ONBOARDING_PIN_TOP_TITLES.includes(o.title))
    .sort((a: any, b: any) => a.title.localeCompare(b.title));
  const sortedOptions = [...pinned, ...rest];
  const orderChanged =
    sortedOptions.length === prompt.options.length &&
    sortedOptions.some((o: any, i: number) => o !== prompt.options[i]);
  if (orderChanged && !apply) result.onboardingWouldSort = true;

  const emojisFilled = result.onboardingEmojisSet.length > 0;
  if (apply && (addedTitles.length > 0 || orderChanged || emojisFilled)) {
    if (orderChanged) prompt.options = sortedOptions;
    // SAFETY: the onboarding PUT is a full replace. Guarantee we only ADD —
    // if any pre-existing option would be dropped, abort WITHOUT writing.
    const stillPresent = new Set(
      prompt.options.map((o: any) => o.id).filter(Boolean),
    );
    const dropped = [...originalOptionIds].filter((id) => !stillPresent.has(id));
    if (dropped.length > 0 || prompt.options.length < originalOptionCount) {
      throw new Error(
        `onboarding safety check failed: would drop ${dropped.length} existing ` +
          `option(s) (count ${originalOptionCount} -> ${prompt.options.length}); ` +
          `aborting PUT, no changes made`,
      );
    }

    // Discord's GET returns each option's emoji as a nested { id, name, animated }
    // object, but the Modify-Onboarding PUT expects FLAT emoji_id/emoji_name/
    // emoji_animated and IGNORES the nested object. Map every option to the flat
    // form so existing emojis survive the full-replace PUT (otherwise it clears
    // them). New options we pushed already carry flat null emoji fields.
    const normalizedPrompts = (onboarding.prompts as any[]).map((p) => ({
      ...p,
      options: (p.options ?? []).map((o: any) => ({
        ...o,
        emoji_id: o.emoji?.id ?? o.emoji_id ?? null,
        emoji_name: o.emoji?.name ?? o.emoji_name ?? null,
        emoji_animated: o.emoji?.animated ?? o.emoji_animated ?? false,
      })),
    }));

    // SAFETY 2: never reduce the number of options that carry an emoji
    // (compared against the snapshot taken before any of our mutations).
    const emojiAfter = normalizedPrompts
      .flatMap((p) => p.options)
      .filter((o: any) => o.emoji_id || o.emoji_name).length;
    if (emojiAfter < originalEmojiCount) {
      throw new Error(
        `onboarding safety check failed: would drop emojis ` +
          `(${originalEmojiCount} -> ${emojiAfter}); aborting PUT, no changes made`,
      );
    }

    try {
      await guild.client.rest.put(Routes.guildOnboarding(guild.id), {
        body: {
          enabled: onboarding.enabled,
          default_channel_ids: onboarding.default_channel_ids,
          mode: onboarding.mode,
          prompts: normalizedPrompts,
        },
        reason: "games-provision: update onboarding (add games / fill emojis / sort)",
      });
      for (const t of addedTitles) console.log(`[apply] added onboarding option: ${t}`);
      for (const t of result.onboardingEmojisSet)
        console.log(`[apply] set emoji on onboarding option: ${t}`);
      if (orderChanged) {
        result.onboardingSorted = true;
        console.log("[apply] re-sorted onboarding options (pinned specials + A-Z)");
      }
      result.onboardingAdded.push(...addedTitles);
    } catch (err) {
      // Roles/channels already created are unaffected; onboarding is left as-is
      // (a rejected PUT changes nothing). Report instead of crashing the run.
      result.onboardingEmojisSet = [];
      result.onboardingError = (err as Error).message;
      console.warn(
        `[provision] onboarding update failed, options NOT changed ` +
          `(bot needs Manage Guild?): ${(err as Error).message}`,
      );
    }
  }
}
