import { syncGameRequests } from "./game-requests";

/**
 * Periodic #game-requests sync (see lib/game-requests.ts). Matches the
 * stats collector's 10-minute cadence on www.th.gl.
 *
 * Env:
 *   GAME_REQUESTS_SYNC_ENABLED      "false" to disable (default on when
 *                                   STATS_BOT_SECRET is set)
 *   GAME_REQUESTS_SYNC_INTERVAL_MS  poll interval, default 600000 (10 min)
 */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
// Small delay after startup so the client cache is warm before the first run.
const STARTUP_DELAY_MS = 20 * 1000;

export function startGameRequestsSyncScheduler() {
  if (
    process.env.GAME_REQUESTS_SYNC_ENABLED === "false" ||
    !process.env.STATS_BOT_SECRET
  ) {
    console.log(
      "[game-requests] scheduler disabled (GAME_REQUESTS_SYNC_ENABLED=false or no STATS_BOT_SECRET)",
    );
    return;
  }
  const interval =
    Number(process.env.GAME_REQUESTS_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const runOnce = () => void syncGameRequests().catch(() => undefined);
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, interval);
  }, STARTUP_DELAY_MS);
  console.log(
    `[game-requests] scheduler armed (every ${Math.round(interval / 60000)} min)`,
  );
}
