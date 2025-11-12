import type { Message } from "discord.js";
import { getChannelMessages } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID } from "./game-roles";

/**
 * Cache for the central app-updates channel messages
 *
 * Since the app-updates channel can have many messages between game-specific updates,
 * we cache all messages and refresh periodically to avoid fetching on every request.
 */

interface CachedMessages {
  messages: Message[];
  lastFetch: number;
}

let cache: CachedMessages | null = null;

/**
 * Cache TTL in milliseconds (5 minutes)
 */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Maximum number of messages to fetch and cache
 */
const MAX_MESSAGES = 100;

/**
 * Get messages from the app-updates channel
 * Returns cached messages if available and not expired, otherwise fetches fresh data
 */
export async function getAppUpdatesMessages(): Promise<Message[]> {
  const now = Date.now();

  // Return cached messages if they're still fresh
  if (cache && now - cache.lastFetch < CACHE_TTL) {
    return cache.messages;
  }

  // Fetch fresh messages
  console.log("[AppUpdatesCache] Fetching fresh messages from app-updates channel");
  const messagesCollection = await getChannelMessages(
    CENTRAL_UPDATES_CHANNEL_ID,
    MAX_MESSAGES
  );
  const messages = Array.from(messagesCollection.values());

  // Update cache
  cache = {
    messages,
    lastFetch: now,
  };

  return messages;
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
