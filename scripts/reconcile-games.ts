import { initDiscord } from "../lib/discord";
import { reconcileGames } from "../lib/games-provision";

await initDiscord();
const apply = process.argv.includes("--apply");
const result = await reconcileGames({ apply });
console.log(JSON.stringify(result, null, 2));
process.exit(0);
