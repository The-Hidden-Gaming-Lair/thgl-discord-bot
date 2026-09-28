import { initDiscord } from "../lib/discord";
import { runRebalance } from "../lib/channel-rebalance";

// Operator tool for lib/channel-rebalance.ts: dry-run report by default,
// `--apply --force` to actually move channels between Apps & Games / More Games.
async function main() {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  if (apply && !force) {
    console.error(
      "Refusing to mutate the live Discord server.\n" +
        "Re-run with BOTH flags to actually move channels: --apply --force",
    );
    process.exit(1);
  }
  await initDiscord();
  const { alreadyRunning, result } = await runRebalance({ apply });
  if (alreadyRunning) {
    console.error("A rebalance is already running; try again shortly.");
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(`[rebalance-channels] failed: ${(err as Error).message}`);
  process.exit(1);
});
