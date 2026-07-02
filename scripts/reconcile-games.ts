import { initDiscord } from "../lib/discord";
import { runReconcileGames } from "../lib/games-provision";

async function main() {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  if (apply && !force) {
    console.error(
      "Refusing to mutate the live Discord server.\n" +
        "Re-run with BOTH flags to actually create roles/channels: --apply --force",
    );
    process.exit(1);
  }
  await initDiscord();
  // Route through the concurrency guard so a manual apply can't collide with a
  // scheduler tick (which, in apply mode, could create duplicate roles/channels).
  const { alreadyRunning, result } = await runReconcileGames({ apply });
  if (alreadyRunning) {
    console.error("A games sync is already running; try again shortly.");
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(`[reconcile-games] failed: ${(err as Error).message}`);
  process.exit(1);
});
