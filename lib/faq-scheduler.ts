import { syncFaq } from "./faq";

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

let running = false;

async function runOnce() {
  if (running) return; // never overlap runs
  running = true;
  try {
    const applyDeletes = process.env.FAQ_SYNC_APPLY_DELETES === "true";
    const report = await syncFaq({ applyDeletes });
    console.log(
      `[faq-sync] ${report.created} created, ${report.updated} updated, ` +
        `${report.skipped} unchanged, ${report.deleted} deleted, ` +
        `${report.pendingDeletions} pending deletion, ${report.errors} errors`,
    );
    if (report.pendingDeletions > 0) {
      console.log(
        "[faq-sync] pending deletions (run POST /api/faq/sync?apply=true to remove): " +
          report.actions
            .filter((a) => a.action === "delete" && !a.applied)
            .map((a) =>
              a.action === "delete"
                ? `${a.title}${a.hasWebEquivalent ? "" : " [NO WEB EQUIVALENT]"}`
                : "",
            )
            .join("; "),
      );
    }
  } catch (error: any) {
    console.error("[faq-sync] run failed:", error?.message ?? error);
  } finally {
    running = false;
  }
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
