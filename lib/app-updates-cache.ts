import type { Collection, Message } from "discord.js";
import { getTextChannel } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID } from "./game-roles";

/**
 * Cache for the central app-updates channel messages
 *
 * Holds the channel's FULL history (newest first): the per-game #updates-*
 * channels were deleted 2026-09-28, so the central channel is the only source
 * for a quiet game's last update, which can be hundreds of messages back.
 * The first call pages through the whole channel (~7 requests for 700
 * messages); later refreshes only fetch what is newer than the cached head.
 * Edits/deletes of cached messages are picked up by a full reload every
 * FULL_RELOAD_MS.
 */

interface CachedMessages {
  messages: Message[];
  lastFetch: number;
  lastFullLoad: number;
}

let cache: CachedMessages | null = null;
let inFlight: Promise<Message[]> | null = null;

/**
 * Cache TTL in milliseconds (5 minutes) — how often new messages are fetched
 */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Full reload interval (6 hours) — refreshes edits/deletions of older messages
 */
const FULL_RELOAD_MS = 6 * 60 * 60 * 1000;

const PAGE_SIZE = 100;

async function fetchPages(opts: { before?: string; after?: string }) {
  const channel = getTextChannel(CENTRAL_UPDATES_CHANNEL_ID);
  const out: Message[] = [];
  let before = opts.before;
  let after = opts.after;
  for (;;) {
    const page: Collection<string, Message> = await channel.messages.fetch({
      limit: PAGE_SIZE,
      ...(after ? { after } : before ? { before } : {}),
    });
    if (page.size === 0) break;
    // discord.js returns each page newest-first
    const msgs = [...page.values()].sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    );
    if (after) {
      out.unshift(...msgs);
      after = msgs[0].id;
    } else {
      out.push(...msgs);
      before = msgs[msgs.length - 1].id;
    }
    if (page.size < PAGE_SIZE) break;
  }
  return out;
}

async function load(): Promise<Message[]> {
  const now = Date.now();
  if (!cache || now - cache.lastFullLoad >= FULL_RELOAD_MS) {
    console.log("[AppUpdatesCache] Loading full app-updates history");
    const messages = await fetchPages({});
    cache = { messages, lastFetch: now, lastFullLoad: now };
    console.log(`[AppUpdatesCache] Cached ${messages.length} messages`);
    return messages;
  }
  const head = cache.messages[0]?.id;
  const newer = head ? await fetchPages({ after: head }) : await fetchPages({});
  cache = {
    messages: head ? [...newer, ...cache.messages] : newer,
    lastFetch: now,
    lastFullLoad: cache.lastFullLoad,
  };
  return cache.messages;
}

/**
 * Get messages from the app-updates channel (full history, newest first)
 * Returns cached messages if available and not expired, otherwise refreshes
 */
export async function getAppUpdatesMessages(): Promise<Message[]> {
  if (cache && Date.now() - cache.lastFetch < CACHE_TTL) {
    return cache.messages;
  }
  // Collapse concurrent refreshes into one
  inFlight ??= load().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Manually refresh the cache
 * Useful for forcing a cache update
 */
export async function refreshCache(): Promise<void> {
  console.log("[AppUpdatesCache] Manually refreshing cache");
  cache = null;
  await getAppUpdatesMessages();
}

/**
 * Get cache stats for debugging
 */
export function getCacheStats() {
  if (!cache) {
    return {
      cached: false,
      messageCount: 0,
      lastFetch: null,
      age: 0,
      ttl: CACHE_TTL,
    };
  }

  const age = Date.now() - cache.lastFetch;
  return {
    cached: true,
    messageCount: cache.messages.length,
    lastFetch: new Date(cache.lastFetch).toISOString(),
    lastFullLoad: new Date(cache.lastFullLoad).toISOString(),
    age,
    ttl: CACHE_TTL,
    expires: new Date(cache.lastFetch + CACHE_TTL).toISOString(),
  };
}

/**
 * Clear the cache
 */
export function clearCache(): void {
  console.log("[AppUpdatesCache] Clearing cache");
  cache = null;
}
