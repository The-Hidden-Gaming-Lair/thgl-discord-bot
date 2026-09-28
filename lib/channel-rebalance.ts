import {
  ChannelType,
  type CategoryChannel,
  type Guild,
  type GuildChannel,
  type Message,
  type TextChannel,
} from "discord.js";
import { getChannel } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID } from "./game-roles";
import {
  APPS_AND_GAMES_CATEGORY,
  CATEGORY_CHANNEL_LIMIT,
  CHANNEL_PIN_BOTTOM,
  CHANNEL_PIN_TOP,
  MORE_GAMES_CATEGORY,
  channelKey,
  sortAppsAndGamesChannels,
} from "./games-provision";

/**
 * Keeps "Apps & Games" to the game chats people actually use: quiet game
 * channels move to "More Games", and move back once they pick up again.
 * A move only changes the parent category — channel id, history, permission
 * overwrites and the onboarding option (which references the channel id)
 * all stay intact.
 *
 * Rules (human, non-system messages; bots don't count):
 *   - channels younger than GRACE_DAYS always stay in Apps & Games
 *     (new games are quiet at first, but should be visible at launch)
 *   - demote: fewer than DEMOTE_BELOW messages in the last WINDOW_DAYS
 *   - promote: at least PROMOTE_AT messages in the last WINDOW_DAYS
 *   The gap between the two thresholds stops channels flapping.
 *   - #thgl-companion-app, #other-games and non-text channels (info forum,
 *     app-updates) are never moved.
 *   - Apps & Games is kept at <= ACTIVE_MAX children; the most active
 *     candidates are promoted first.
 */
export const WINDOW_DAYS = 30;
export const GRACE_DAYS = 60;
export const DEMOTE_BELOW = 2;
export const PROMOTE_AT = 5;
const ACTIVE_MAX = CATEGORY_CHANNEL_LIMIT - 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 10;

/** Staff log channel for move reports; defaults to the spam-guard mod log
 *  (#bot-log in production). Empty = no Discord log, console only. */
const LOG_CHANNEL_ID =
  process.env.CHANNEL_REBALANCE_LOG_CHANNEL_ID ?? process.env.MOD_LOG_CHANNEL_ID ?? "";

export type ChannelActivity = {
  id: string;
  name: string;
  ageDays: number;
  /** Human messages in the window, counted up to PROMOTE_AT (a floor, not exact). */
  recent: number;
};

export type RebalanceResult = {
  apply: boolean;
  categoryCreated: boolean;
  demoted: ChannelActivity[];
  promoted: ChannelActivity[];
  /** Candidates that were not moved because the target category is full. */
  skippedFull: ChannelActivity[];
  activeCount: number;
  quietCount: number;
};

let rebalanceInFlight = false;

/** Count human messages in the window, stopping early at `cap`. */
async function countRecent(channel: TextChannel, cap: number): Promise<number> {
  const since = Date.now() - WINDOW_DAYS * DAY_MS;
  let count = 0;
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const msgs = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (msgs.size === 0) return count;
    const sorted: Message[] = [...msgs.values()].sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    );
    for (const m of sorted) {
      if (m.createdTimestamp < since) return count;
      if (m.author.bot || m.system) continue;
      if (++count >= cap) return count;
    }
    before = sorted[sorted.length - 1].id;
  }
  return count;
}

function findCategory(guild: Guild, name: string) {
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name === name,
  ) as CategoryChannel | undefined;
}

const childCount = (guild: Guild, categoryId?: string) =>
  categoryId ? guild.channels.cache.filter((c) => c.parentId === categoryId).size : 0;

async function logToDiscord(result: RebalanceResult) {
  if (!LOG_CHANNEL_ID || (!result.demoted.length && !result.promoted.length && !result.skippedFull.length)) return;
  try {
    const channel = getChannel(LOG_CHANNEL_ID) as TextChannel;
    const line = (a: ChannelActivity) =>
      `<#${a.id}> (${a.recent >= PROMOTE_AT ? `${PROMOTE_AT}+` : a.recent} msgs/${WINDOW_DAYS}d)`;
    const parts = [`**Channel rebalance** (Apps & Games ${result.activeCount}, More Games ${result.quietCount})`];
    if (result.categoryCreated) parts.push(`Created category **${MORE_GAMES_CATEGORY}**`);
    if (result.promoted.length)
      parts.push(`Moved to **${APPS_AND_GAMES_CATEGORY}**: ${result.promoted.map(line).join(", ")}`);
    if (result.demoted.length)
      parts.push(`Moved to **${MORE_GAMES_CATEGORY}**: ${result.demoted.map(line).join(", ")}`);
    if (result.skippedFull.length)
      parts.push(`Not moved (category full): ${result.skippedFull.map(line).join(", ")}`);
    let content = parts.join("\n");
    if (content.length > 2000) content = content.slice(0, 1997) + "...";
    await channel.send({ content, allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn(`[rebalance] log post failed: ${(err as Error).message}`);
  }
}

async function rebalance(apply: boolean): Promise<RebalanceResult> {
  const guild = (getChannel(CENTRAL_UPDATES_CHANNEL_ID) as GuildChannel).guild;
  await guild.channels.fetch();

  const active = findCategory(guild, APPS_AND_GAMES_CATEGORY);
  if (!active) throw new Error(`category "${APPS_AND_GAMES_CATEGORY}" not found`);
  let quiet = findCategory(guild, MORE_GAMES_CATEGORY);

  const result: RebalanceResult = {
    apply,
    categoryCreated: false,
    demoted: [],
    promoted: [],
    skippedFull: [],
    activeCount: childCount(guild, active.id),
    quietCount: childCount(guild, quiet?.id),
  };

  const candidates = guild.channels.cache.filter(
    (c): c is TextChannel =>
      c.type === ChannelType.GuildText &&
      (c.parentId === active.id || (!!quiet && c.parentId === quiet.id)) &&
      channelKey(c.name) !== CHANNEL_PIN_TOP &&
      channelKey(c.name) !== CHANNEL_PIN_BOTTOM,
  );

  const demote: ChannelActivity[] = [];
  const promote: ChannelActivity[] = [];
  for (const ch of candidates.values()) {
    const ageDays = Math.floor((Date.now() - ch.createdTimestamp) / DAY_MS);
    const inActive = ch.parentId === active.id;
    // New channels stay/return visible regardless of activity.
    if (ageDays < GRACE_DAYS) {
      if (!inActive) promote.push({ id: ch.id, name: ch.name, ageDays, recent: 0 });
      continue;
    }
    const recent = await countRecent(ch, PROMOTE_AT);
    const a = { id: ch.id, name: ch.name, ageDays, recent };
    if (inActive && recent < DEMOTE_BELOW) demote.push(a);
    else if (!inActive && recent >= PROMOTE_AT) promote.push(a);
  }

  // Capacity: demotes free room in Apps & Games; promote the busiest first
  // (new channels in their grace period rank first).
  const rank = (a: ChannelActivity) => (a.ageDays < GRACE_DAYS ? Infinity : a.recent);
  promote.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
  demote.sort((a, b) => a.recent - b.recent || a.name.localeCompare(b.name));
  let activeCount = result.activeCount;
  let quietCount = result.quietCount;
  for (const d of demote) {
    if (quietCount >= CATEGORY_CHANNEL_LIMIT) {
      result.skippedFull.push(d);
      continue;
    }
    result.demoted.push(d);
    activeCount--;
    quietCount++;
  }
  for (const p of promote) {
    if (activeCount >= ACTIVE_MAX) {
      result.skippedFull.push(p);
      continue;
    }
    result.promoted.push(p);
    activeCount++;
    quietCount--;
  }
  result.activeCount = activeCount;
  result.quietCount = quietCount;

  if (!apply) return result;

  if (!quiet && result.demoted.length) {
    quiet = await guild.channels.create({
      name: MORE_GAMES_CATEGORY,
      type: ChannelType.GuildCategory,
      position: active.position + 1,
      // Same visibility as Apps & Games so moved channels look identical.
      permissionOverwrites: active.permissionOverwrites.cache.map((o) => ({
        id: o.id,
        type: o.type,
        allow: o.allow.bitfield,
        deny: o.deny.bitfield,
      })),
      reason: "channel-rebalance: category for quiet game channels",
    });
    result.categoryCreated = true;
    console.log(`[rebalance] created category ${MORE_GAMES_CATEGORY}`);
  }

  const move = async (a: ChannelActivity, to: CategoryChannel) => {
    const ch = guild.channels.cache.get(a.id) as TextChannel;
    // lockPermissions:false keeps the channel's own overwrites untouched.
    await ch.setParent(to, {
      lockPermissions: false,
      reason: `channel-rebalance: ${a.recent} human msgs in ${WINDOW_DAYS}d`,
    });
    console.log(`[rebalance] #${a.name} -> ${to.name} (${a.recent} msgs/${WINDOW_DAYS}d)`);
  };
  for (const d of result.demoted) await move(d, quiet!);
  for (const p of result.promoted) await move(p, active);

  if (result.demoted.length || result.promoted.length) {
    await sortAppsAndGamesChannels(guild, active);
    if (quiet) await sortAppsAndGamesChannels(guild, quiet);
  }
  await logToDiscord(result);
  return result;
}

/** Concurrency-guarded entry point for the scheduler and the operator script. */
export async function runRebalance(
  opts: { apply?: boolean } = {},
): Promise<{ alreadyRunning: boolean; result?: RebalanceResult }> {
  if (rebalanceInFlight) return { alreadyRunning: true };
  rebalanceInFlight = true;
  try {
    return { alreadyRunning: false, result: await rebalance(!!opts.apply) };
  } finally {
    rebalanceInFlight = false;
  }
}
