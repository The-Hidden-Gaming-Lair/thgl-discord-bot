import { initDiscord } from "../lib/discord";
import { reconcileGames } from "../lib/games-provision";

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
  const result = await reconcileGames({ apply });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(`[reconcile-games] failed: ${(err as Error).message}`);
  process.exit(1);
});
