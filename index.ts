import { getClient, initDiscord } from "./lib/discord";
import { ClientResponse } from "./lib/http";
import { handleInfo } from "./routes/info/route";
import { handleSuggestionsIssues } from "./routes/suggestions-issues/route";
import { handleUpdates } from "./routes/updates/route";
import { handleMcpApi } from "./routes/mcp-api/route";
import { setupSpamGuard } from "./lib/spam-guard";

await initDiscord();
const client = getClient();
console.log(`Ready! Logged in as ${client.user.tag}`);
setupSpamGuard(client);

const server = Bun.serve({
  port: process.env.PORT || 3000,
  idleTimeout: 20,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/updates")) {
      return handleUpdates(req, url);
    }
    if (url.pathname.startsWith("/api/info")) {
      return handleInfo(req, url);
    }
    if (url.pathname.startsWith("/api/suggestions-issues")) {
      return handleSuggestionsIssues(req, url);
    }
    if (url.pathname.startsWith("/api/mcp")) {
      return handleMcpApi(req, url);
    }
    return new ClientResponse("404!", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${server.port}`);
