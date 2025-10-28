import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getChannelMessages, getAllChannels } from "./discord";
import type { Message } from "discord.js";

/**
 * MCP Server for Discord Bot
 *
 * Provides tools for Mia to read Discord messages and make AI-powered decisions
 * about creating tasks based on Discord activity.
 */

// Helper to find channel by ID, name, or fullName (category/name)
function findChannel(identifier: string) {
  const allChannels = getAllChannels();

  // Try exact ID match first
  let channel = allChannels.find((ch) => ch.id === identifier);
  if (channel) return channel;

  // Try fullName match (category/name)
  channel = allChannels.find((ch) => ch.fullName === identifier);
  if (channel) return channel;

  // Try name match (case-insensitive)
  channel = allChannels.find(
    (ch) => ch.name.toLowerCase() === identifier.toLowerCase()
  );
  if (channel) return channel;

  return null;
}

// Helper function to format Discord messages
function formatMessage(message: Message) {
  return {
    id: message.id,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      bot: message.author.bot,
    },
    content: message.cleanContent,
    timestamp: message.createdTimestamp,
    attachments: message.attachments.map((att) => ({
      url: att.url,
      contentType: att.contentType,
      name: att.name,
    })),
    embeds: message.embeds.map((embed) => ({
      title: embed.title,
      description: embed.description,
      url: embed.url,
    })),
    reactions: message.reactions.cache.map((reaction) => ({
      emoji: reaction.emoji.name,
      count: reaction.count,
    })),
  };
}

export async function startMCPServer() {
  // Authorization check - require MCP_API_KEY environment variable
  const apiKey = process.env.MCP_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MCP_API_KEY environment variable is required for authorization"
    );
  }

  console.error("[MCP] Authorization: API key validated");

  const server = new Server(
    {
      name: "discord-bot-mcp",
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
          name: "get_recent_messages",
          description:
            "Get recent messages from a Discord channel. Useful for checking latest updates and discussions. Channel can be specified by name, ID, or 'category/name' format.",
          inputSchema: {
            type: "object",
            properties: {
              channel: {
                type: "string",
                description: "Channel identifier: name (e.g., 'chat'), ID, or 'category/name' (e.g., 'Community/chat')",
              },
              limit: {
                type: "number",
                description: "Maximum number of messages to retrieve (1-100, default: 10)",
                minimum: 1,
                maximum: 100,
              },
            },
            required: ["channel"],
          },
        },
        {
          name: "search_messages",
          description:
            "Search for messages in a channel containing specific keywords. Useful for finding discussions about specific topics.",
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
                description: "Maximum number of messages to search through (default: 50)",
                minimum: 1,
                maximum: 100,
              },
            },
            required: ["channel", "query"],
          },
        },
        {
          name: "get_channel_list",
          description:
            "Get a list of all available Discord channels that can be monitored. Returns channels with their categories and types.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "get_messages_with_reactions",
          description:
            "Get messages with significant reactions (5+ reactions). Useful for finding important or trending discussions.",
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
                description: "Maximum number of messages to check (default: 50)",
                minimum: 1,
                maximum: 100,
              },
            },
            required: ["channel"],
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
        case "get_recent_messages": {
          const channelIdentifier = args.channel as string;
          const limit = (args.limit as number) || 10;

          const channel = findChannel(channelIdentifier);
          if (!channel) {
            return {
              content: [
                {
                  type: "text",
                  text: `Channel '${channelIdentifier}' not found. Use get_channel_list to see available channels.`,
                },
              ],
            };
          }

          const messages = await getChannelMessages(channel.id, limit);
          const formattedMessages = messages.map(formatMessage);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    channel: channel.name,
                    fullName: channel.fullName,
                    category: channel.category,
                    type: channel.type,
                    count: formattedMessages.length,
                    messages: formattedMessages,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "search_messages": {
          const channelIdentifier = args.channel as string;
          const query = (args.query as string).toLowerCase();
          const limit = (args.limit as number) || 50;

          const channel = findChannel(channelIdentifier);
          if (!channel) {
            return {
              content: [
                {
                  type: "text",
                  text: `Channel '${channelIdentifier}' not found. Use get_channel_list to see available channels.`,
                },
              ],
            };
          }

          const messages = await getChannelMessages(channel.id, limit);
          const matchingMessages = messages
            .filter((msg) => msg.cleanContent.toLowerCase().includes(query))
            .map(formatMessage);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    channel: channel.name,
                    fullName: channel.fullName,
                    category: channel.category,
                    query,
                    count: matchingMessages.length,
                    messages: matchingMessages,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "get_channel_list": {
          const channels = getAllChannels();

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    count: channels.length,
                    channels,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "get_messages_with_reactions": {
          const channelIdentifier = args.channel as string;
          const minReactions = (args.min_reactions as number) || 5;
          const limit = (args.limit as number) || 50;

          const channel = findChannel(channelIdentifier);
          if (!channel) {
            return {
              content: [
                {
                  type: "text",
                  text: `Channel '${channelIdentifier}' not found. Use get_channel_list to see available channels.`,
                },
              ],
            };
          }

          const messages = await getChannelMessages(channel.id, limit);
          const messagesWithReactions = messages
            .filter((msg) => {
              const totalReactions = msg.reactions.cache.reduce(
                (sum, reaction) => sum + reaction.count,
                0
              );
              return totalReactions >= minReactions;
            })
            .map(formatMessage);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    channel: channel.name,
                    fullName: channel.fullName,
                    category: channel.category,
                    min_reactions: minReactions,
                    count: messagesWithReactions.length,
                    messages: messagesWithReactions,
                  },
                  null,
                  2
                ),
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

  // Start the server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP] Server started on stdio");
}
