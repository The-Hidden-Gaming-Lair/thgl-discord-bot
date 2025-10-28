import { initDiscord, getClient } from "./lib/discord";
import { startMCPServer } from "./lib/mcp-server";

/**
 * MCP Server Entry Point
 *
 * This script initializes the Discord client and starts the MCP server
 * for Mia to access Discord messages via Model Context Protocol.
 *
 * Usage:
 *   MCP_API_KEY=your_secret_key bun run mcp.ts
 */

async function main() {
  try {
    // Initialize Discord client
    console.error("[MCP] Initializing Discord client...");
    await initDiscord();
    const client = getClient();
    console.error(`[MCP] Discord ready! Logged in as ${client.user.tag}`);

    // Start MCP server (with authorization check)
    console.error("[MCP] Starting MCP server...");
    await startMCPServer();

    console.error("[MCP] Server is ready and listening on stdio");
  } catch (error) {
    console.error("[MCP] Fatal error:", error);
    process.exit(1);
  }
}

main();
