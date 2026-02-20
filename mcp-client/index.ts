#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Configuration
const DISCORD_API_URL =
  process.env.DISCORD_API_URL || "https://discord-bot.th.gl";
const API_KEY = process.env.DISCORD_MCP_API_KEY;

if (!API_KEY) {
  console.error(
    "[Discord MCP] Error: DISCORD_MCP_API_KEY environment variable is required"
  );
  process.exit(1);
}

// Helper to make authenticated API requests
async function apiRequest(
  endpoint: string,
  options?: {
    method?: string;
    params?: Record<string, string | number>;
  }
): Promise<any> {
  const url = new URL(`${DISCORD_API_URL}/api/mcp${endpoint}`);
  const method = options?.method || "GET";

  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error (${response.status}): ${text}`);
  }

  return response.json();
}

// Fetch an image from a URL and return as base64
async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    const data = Buffer.from(buffer).toString("base64");
    const mimeType = response.headers.get("content-type") || "image/png";
    return { data, mimeType };
  } catch {
    return null;
  }
}

// Extract image attachment URLs from messages and fetch them as base64
async function fetchMessageImages(messages: any[]): Promise<Array<{ type: string; data: string; mimeType: string }>> {
  const imageUrls: string[] = [];
  for (const msg of messages) {
    if (msg.attachments) {
      for (const att of msg.attachments) {
        if (att.contentType?.startsWith("image/")) {
          imageUrls.push(att.url);
        }
      }
    }
  }
  if (imageUrls.length === 0) return [];

  const results = await Promise.all(imageUrls.map(fetchImageAsBase64));
  return results
    .filter((r) => r !== null)
    .map((r) => ({ type: "image", data: r.data, mimeType: r.mimeType }));
}

// Create MCP server
const server = new Server(
  {
    name: "discord-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_channel_list",
        description:
          "Get a list of all available Discord channels. Returns channel names, IDs, categories, and types (text, forum, announcement, etc.).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_recent_messages",
        description:
          "Get recent messages from a Discord channel. Channel can be specified by name, ID, or 'category/name' format (e.g., 'Community/chat').",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description:
                "Channel identifier: name (e.g., 'chat'), ID, or 'category/name' (e.g., 'Community/chat')",
            },
            limit: {
              type: "number",
              description:
                "Maximum number of messages to retrieve (1-100, default: 10)",
              minimum: 1,
              maximum: 100,
            },
            after: {
              type: "number",
              description:
                "Timestamp in milliseconds - only return messages after this time",
            },
            include_images: {
              type: "boolean",
              description:
                "Fetch and return image attachments as viewable content (default: false). Adds latency.",
            },
          },
          required: ["channel"],
        },
      },
      {
        name: "search_messages",
        description:
          "Search for messages in a channel containing specific keywords. Returns messages matching the search query.",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel identifier: name, ID, or 'category/name'",
            },
            query: {
              type: "string",
              description: "Search query (keywords to find in message content)",
            },
            limit: {
              type: "number",
              description:
                "Maximum number of messages to search through (default: 50)",
              minimum: 1,
              maximum: 100,
            },
            include_images: {
              type: "boolean",
              description:
                "Fetch and return image attachments as viewable content (default: false). Adds latency.",
            },
          },
          required: ["channel", "query"],
        },
      },
      {
        name: "get_messages_with_reactions",
        description:
          "Get messages with significant reactions. Useful for finding important or popular discussions.",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel identifier: name, ID, or 'category/name'",
            },
            min_reactions: {
              type: "number",
              description: "Minimum number of reactions (default: 5)",
              minimum: 1,
            },
            limit: {
              type: "number",
              description:
                "Maximum number of messages to check (default: 50)",
              minimum: 1,
              maximum: 100,
            },
            include_images: {
              type: "boolean",
              description:
                "Fetch and return image attachments as viewable content (default: false). Adds latency.",
            },
          },
          required: ["channel"],
        },
      },
      {
        name: "get_forum_posts",
        description:
          "Get posts (threads) from a Discord forum channel. Only works on forum-type channels.",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description:
                "Forum channel identifier: name, ID, or 'category/name'",
            },
            limit: {
              type: "number",
              description: "Maximum number of posts to retrieve (default: 50)",
              minimum: 1,
              maximum: 100,
            },
            after: {
              type: "number",
              description:
                "Timestamp in milliseconds - only return posts created after this time",
            },
          },
          required: ["channel"],
        },
      },
      {
        name: "get_all_recent_messages",
        description:
          "Get all messages across ALL Discord channels since a given timestamp. Returns only channels with activity, sorted by message count. Useful for catching up on everything that happened since a point in time.",
        inputSchema: {
          type: "object",
          properties: {
            after: {
              type: "number",
              description:
                "Timestamp in milliseconds - return all messages after this time (required)",
            },
            per_channel_limit: {
              type: "number",
              description:
                "Maximum messages to fetch per channel (1-100, default: 50)",
              minimum: 1,
              maximum: 100,
            },
          },
          required: ["after"],
        },
      },
      {
        name: "delete_message",
        description:
          "Delete a message from a Discord channel. Useful for cleaning up resolved crash logs or outdated messages.",
        inputSchema: {
          type: "object",
          properties: {
            channel: {
              type: "string",
              description: "Channel identifier: name, ID, or 'category/name'",
            },
            message_id: {
              type: "string",
              description: "The ID of the message to delete",
            },
          },
          required: ["channel", "message_id"],
        },
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_channel_list": {
        const result = await apiRequest("");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_recent_messages": {
        const channel = args?.channel as string;
        const limit = (args?.limit as number) || 10;
        const after = args?.after as number | undefined;
        const includeImages = args?.include_images as boolean;

        const params: Record<string, string | number> = { channel, limit };
        if (after !== undefined) params.after = after;

        const result = await apiRequest("/messages", { params });

        const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ];
        if (includeImages && result.messages) {
          const images = await fetchMessageImages(result.messages);
          content.push(...images);
        }

        return { content };
      }

      case "search_messages": {
        const channel = args?.channel as string;
        const query = args?.query as string;
        const limit = (args?.limit as number) || 50;
        const includeImages = args?.include_images as boolean;

        const result = await apiRequest("/search", {
          params: { channel, query, limit },
        });

        const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ];
        if (includeImages && result.messages) {
          const images = await fetchMessageImages(result.messages);
          content.push(...images);
        }

        return { content };
      }

      case "get_messages_with_reactions": {
        const channel = args?.channel as string;
        const min_reactions = (args?.min_reactions as number) || 5;
        const limit = (args?.limit as number) || 50;
        const includeImages = args?.include_images as boolean;

        const result = await apiRequest("/reactions", {
          params: { channel, min_reactions, limit },
        });

        const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ];
        if (includeImages && result.messages) {
          const images = await fetchMessageImages(result.messages);
          content.push(...images);
        }

        return { content };
      }

      case "get_forum_posts": {
        const channel = args?.channel as string;
        const limit = (args?.limit as number) || 50;
        const after = args?.after as number | undefined;

        const params: Record<string, string | number> = { channel, limit };
        if (after !== undefined) params.after = after;

        const result = await apiRequest("/forum", { params });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_all_recent_messages": {
        const after = args?.after as number;
        const per_channel_limit = args?.per_channel_limit as
          | number
          | undefined;

        const params: Record<string, string | number> = { after };
        if (per_channel_limit !== undefined)
          params.per_channel_limit = per_channel_limit;

        const result = await apiRequest("/all-messages", { params });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "delete_message": {
        const channel = args?.channel as string;
        const message_id = args?.message_id as string;

        const result = await apiRequest("/message", {
          method: "DELETE",
          params: { channel, message_id },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Discord MCP] Server started on stdio");
}

main().catch((error) => {
  console.error("[Discord MCP] Fatal error:", error);
  process.exit(1);
});
