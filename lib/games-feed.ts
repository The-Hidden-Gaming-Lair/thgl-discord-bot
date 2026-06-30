import { GAME_CONFIGS } from "./game-roles";

export interface CanonicalGame {
  /** Stable web id/slug for the game (e.g. "soulframe"). */
  id: string;
  /**
   * Canonical slug used to match Discord objects (channel name == this,
   * role resolved by title). NOT a Discord snowflake — it mirrors the
   * website Game.discordId field (e.g. "aeternum-map").
   */
  discordId: string;
  title: string;
  web: string | null;
  logo?: string;
}

const GAMES_API_URL = process.env.GAMES_API_URL ?? "https://www.th.gl/api/games";
const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; games: CanonicalGame[] } | null = null;

/** Fallback derived from the bundled lists so the bot still works offline. */
function bundledGames(): CanonicalGame[] {
  return GAME_CONFIGS.map((c) => ({
    id: c.name,
    discordId: c.name,
    title: c.titleKeywords?.[0] ?? c.name,
    web: null,
  }));
}

export async function getCanonicalGames(force = false): Promise<CanonicalGame[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return cache.games;
  }
  try {
    const res = await fetch(GAMES_API_URL, {
      headers: { accept: "application/json", "user-agent": "thgl-discord-bot/games-sync" },
    });
    if (!res.ok) throw new Error(`games feed ${res.status}`);
    const body = (await res.json()) as { games: CanonicalGame[] };
    if (!Array.isArray(body.games) || body.games.length === 0) {
      throw new Error("games feed empty");
    }
    cache = { at: Date.now(), games: body.games };
    return cache.games;
  } catch (err) {
    console.warn(`[games-feed] falling back to bundled list: ${(err as Error).message}`);
    return cache?.games ?? bundledGames();
  }
}
