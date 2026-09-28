import { runRebalance } from "./channel-rebalance";

/**
 * Periodic Apps & Games / More Games rebalance (lib/channel-rebalance.ts).
 * Defaults are non-destructive: the scheduled run is a DRY RUN that only logs
 * what it would move. Production sets CHANNEL_REBALANCE_APPLY=true in the
 * server's docker-compose (never in a local .env while production runs).
 *
 * Env:
 *   CHANNEL_REBALANCE_ENABLED     "false" to disable the scheduler (default on)
 *   CHANNEL_REBALANCE_INTERVAL_MS poll interval, default 86400000 (24 h)
 *   CHANNEL_REBALANCE_APPLY       "true" to actually move channels
 *   CHANNEL_REBALANCE_LOG_CHANNEL_ID  move report channel (default MOD_LOG_CHANNEL_ID)
 */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60 * 1000;

async function runOnce() {
  const apply = process.env.CHANNEL_REBALANCE_APPLY === "true";
  try {
    const { alreadyRunning, result: r } = await runRebalance({ apply });
    if (alreadyRunning) {
      console.log("[rebalance] previous run still in flight, skipping this tick");
      return;
    }
    if (!r) return;
    const fmt = (xs: { name: string }[]) => xs.map((x) => x.name).join(", ") || "-";
    console.log(
      `[rebalance] ${apply ? "applied" : "dry-run"}: ` +
        `to More Games: ${fmt(r.demoted)}; to Apps & Games: ${fmt(r.promoted)}` +
        (r.skippedFull.length ? `; skipped (full): ${fmt(r.skippedFull)}` : "") +
        ` (Apps & Games ${r.activeCount}, More Games ${r.quietCount})`,
    );
  } catch (err) {
    console.warn(`[rebalance] run failed: ${(err as Error).message}`);
  }
}

export function startChannelRebalanceScheduler() {
  if (process.env.CHANNEL_REBALANCE_ENABLED === "false") {
    console.log("[rebalance] scheduler disabled (CHANNEL_REBALANCE_ENABLED=false)");
    return;
  }
  const interval =
    Number(process.env.CHANNEL_REBALANCE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, interval);
  }, STARTUP_DELAY_MS);
  console.log(
    `[rebalance] scheduler armed (every ${Math.round(interval / 3600000)} h, ` +
      `apply ${process.env.CHANNEL_REBALANCE_APPLY === "true" ? "on" : "off"})`,
  );
}
