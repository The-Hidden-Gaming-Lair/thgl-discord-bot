import { startFaqSync } from "./faq";

/**
 * Periodic FAQ sync.
 *
 * Defaults are intentionally non-destructive: the scheduled run creates and
 * updates synced threads and only *reports* pending deletions. Enable
 * deletions explicitly once you've inspected the first run (e.g. via
 * `POST /api/faq/sync?apply=true`).
 *
 * Env:
 *   FAQ_SYNC_ENABLED       "false" to disable the scheduler (default on)
 *   FAQ_SYNC_INTERVAL_MS   poll interval, default 1800000 (30 min)
 *   FAQ_SYNC_APPLY_DELETES "true" to let the scheduler delete legacy/orphan
 *                          threads automatically (default false)
 */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
// Small delay after startup so the client cache is warm before the first run.
const STARTUP_DELAY_MS = 15 * 1000;

function runOnce() {
  // startFaqSync is non-blocking and no-ops if a run is already in flight
  // (e.g. a manual POST). Results are logged by the runner itself.
  const applyDeletes = process.env.FAQ_SYNC_APPLY_DELETES === "true";
  startFaqSync({ applyDeletes });
}

export function startFaqSyncScheduler() {
  if (process.env.FAQ_SYNC_ENABLED === "false") {
    console.log("[faq-sync] scheduler disabled (FAQ_SYNC_ENABLED=false)");
    return;
  }
  const interval = Number(process.env.FAQ_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  setTimeout(() => {
    runOnce();
    setInterval(runOnce, interval);
  }, STARTUP_DELAY_MS);
  console.log(
    `[faq-sync] scheduler armed (every ${Math.round(interval / 60000)} min, ` +
      `deletes ${process.env.FAQ_SYNC_APPLY_DELETES === "true" ? "on" : "off"})`,
  );
}
