import { getClient, initDiscord } from "./lib/discord";
import { handleMutationCycle } from "./routes/mutation-cycle/route";

await initDiscord();
const client = getClient();
console.log(`Ready! Logged in as ${client.user.tag}`);

Bun.serve({
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/mutation-cycle")) {
      return handleMutationCycle(req);
    }
    return new Response("404!");
  },
});
