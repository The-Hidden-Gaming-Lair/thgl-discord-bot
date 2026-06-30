import { reconcileGames } from "./games-provision";

/**
 * Periodic games sync. Defaults are non-destructive: the scheduled run is a
 * DRY RUN that only reports what it would create. Enable applying explicitly
 * (and only after the bot has Manage Roles/Channels/Guild) via GAMES_SYNC_APPLY.
 *
 * Env:
 *   GAMES_SYNC_ENABLED    "false" to disable the scheduler (default on)
 *   GAMES_SYNC_INTERVAL_MS poll interval, default 1800000 (30 min)
 *   GAMES_SYNC_APPLY      "true" to let the scheduler create missing objects
 *                         (default false = dry-run report only)
 */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;

async function runOnce() {
  const apply = process.env.GAMES_SYNC_APPLY === "true";
  try {
    const r = await reconcileGames({ apply });
    const verb = apply ? "applied" : "dry-run";
    console.log(
      `[games-sync] ${verb}: roles +${apply ? r.rolesCreated.length : r.rolesWouldCreate.length}, ` +
        `channels +${apply ? r.channelsCreated.length : r.channelsWouldCreate.length}, ` +
        `onboarding +${apply ? r.onboardingAdded.length : r.onboardingWouldAdd.length}` +
        (r.orphanChannels.length ? `, ${r.orphanChannels.length} orphan channels` : "") +
        (r.onboardingSkippedNoRole.length ? `, ${r.onboardingSkippedNoRole.length} skipped (no role)` : "") +
        (r.onboardingNearCap ? " [ONBOARDING NEAR CAP]" : ""),
    );
  } catch (err) {
    console.warn(`[games-sync] run failed: ${(err as Error).message}`);
  }
}

export function startGamesSyncScheduler() {
  if (process.env.GAMES_SYNC_ENABLED === "false") {
    console.log("[games-sync] scheduler disabled (GAMES_SYNC_ENABLED=false)");
    return;
  }
  const interval =
    Number(process.env.GAMES_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, interval);
  }, STARTUP_DELAY_MS);
  console.log(
    `[games-sync] scheduler armed (every ${Math.round(interval / 60000)} min, ` +
      `apply ${process.env.GAMES_SYNC_APPLY === "true" ? "on" : "off"})`,
  );
}
