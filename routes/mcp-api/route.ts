import { ClientResponse } from "../../lib/http";
import { getChannelMessages, getAllChannels } from "../../lib/discord";
import type { Message } from "discord.js";

/**
 * HTTP API for Mia's OpenAI function calling
 *
 * These endpoints allow Mia to read Discord messages and make decisions
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

// Authorization middleware
function checkAuth(req: Request): boolean {
  const authHeader = req.headers.get("Authorization");
  const expectedKey = process.env.MCP_API_KEY;

  if (!expectedKey) {
    console.error("[MCP-API] MCP_API_KEY not configured");
    return false;
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const providedKey = authHeader.substring(7); // Remove "Bearer "
  return providedKey === expectedKey;
}

// Format Discord message for API response
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
    reactions: message.reactions.cache.map((reaction) => ({
      emoji: reaction.emoji.name,
      count: reaction.count,
    })),
  };
}

export async function handleMcpApi(req: Request, url: URL) {
  // Handle OPTIONS preflight
  if (req.method === "OPTIONS") {
    return new ClientResponse("", { status: 204 });
  }

  // Check authorization
  if (!checkAuth(req)) {
    return new ClientResponse("Unauthorized", {
      status: 401,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Parse route
  const pathParts = url.pathname.split("/").filter(Boolean);
  // pathParts: ['api', 'mcp', ...rest]

  if (pathParts.length === 2) {
    // GET /api/mcp - List all available channels
    if (req.method === "GET") {
      const allChannels = getAllChannels();
      return ClientResponse.json({
        count: allChannels.length,
        channels: allChannels,
      });
    }
    return new ClientResponse("Method not allowed", { status: 405 });
  }

  const endpoint = pathParts[2]; // 'messages' or 'search'

  if (endpoint === "messages") {
    // GET /api/mcp/messages?channel=announcements&limit=10
    // channel can be: ID, name, or "category/name"
    if (req.method === "GET") {
      const channelIdentifier = url.searchParams.get("channel");
      const limit = parseInt(url.searchParams.get("limit") || "10", 10);

      if (!channelIdentifier) {
        return ClientResponse.json(
          { error: "Missing 'channel' parameter" },
          { status: 400 }
        );
      }

      const channel = findChannel(channelIdentifier);
      if (!channel) {
        return ClientResponse.json(
          {
            error: `Channel '${channelIdentifier}' not found. Use GET /api/mcp to list all channels.`,
          },
          { status: 404 }
        );
      }

      try {
        const messages = await getChannelMessages(channel.id, Math.min(limit, 100));
        const formattedMessages = messages.map(formatMessage);

        return ClientResponse.json({
          channel: channel.name,
          fullName: channel.fullName,
          category: channel.category,
          type: channel.type,
          count: formattedMessages.length,
          messages: formattedMessages,
        });
      } catch (error) {
        return ClientResponse.json(
          { error: error instanceof Error ? error.message : "Unknown error" },
          { status: 500 }
        );
      }
    }
    return new ClientResponse("Method not allowed", { status: 405 });
  }

  if (endpoint === "search") {
    // GET /api/mcp/search?channel=announcements&query=update&limit=50
    if (req.method === "GET") {
      const channelIdentifier = url.searchParams.get("channel");
      const query = url.searchParams.get("query");
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);

      if (!channelIdentifier || !query) {
        return ClientResponse.json(
          { error: "Missing 'channel' or 'query' parameter" },
          { status: 400 }
        );
      }

      const channel = findChannel(channelIdentifier);
      if (!channel) {
        return ClientResponse.json(
          {
            error: `Channel '${channelIdentifier}' not found. Use GET /api/mcp to list all channels.`,
          },
          { status: 404 }
        );
      }

      try {
        const messages = await getChannelMessages(channel.id, Math.min(limit, 100));
        const matchingMessages = messages
          .filter((msg) => msg.cleanContent.toLowerCase().includes(query.toLowerCase()))
          .map(formatMessage);

        return ClientResponse.json({
          channel: channel.name,
          fullName: channel.fullName,
          category: channel.category,
          query,
          count: matchingMessages.length,
          messages: matchingMessages,
        });
      } catch (error) {
        return ClientResponse.json(
          { error: error instanceof Error ? error.message : "Unknown error" },
          { status: 500 }
        );
      }
    }
    return new ClientResponse("Method not allowed", { status: 405 });
  }

  if (endpoint === "reactions") {
    // GET /api/mcp/reactions?channel=announcements&min_reactions=5&limit=50
    if (req.method === "GET") {
      const channelIdentifier = url.searchParams.get("channel");
      const minReactions = parseInt(url.searchParams.get("min_reactions") || "5", 10);
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);

      if (!channelIdentifier) {
        return ClientResponse.json(
          { error: "Missing 'channel' parameter" },
          { status: 400 }
        );
      }

      const channel = findChannel(channelIdentifier);
      if (!channel) {
        return ClientResponse.json(
          {
            error: `Channel '${channelIdentifier}' not found. Use GET /api/mcp to list all channels.`,
          },
          { status: 404 }
        );
      }

      try {
        const messages = await getChannelMessages(channel.id, Math.min(limit, 100));
        const messagesWithReactions = messages
          .filter((msg) => {
            const totalReactions = msg.reactions.cache.reduce(
              (sum, reaction) => sum + reaction.count,
              0
            );
            return totalReactions >= minReactions;
          })
          .map(formatMessage);

        return ClientResponse.json({
          channel: channel.name,
          fullName: channel.fullName,
          category: channel.category,
          min_reactions: minReactions,
          count: messagesWithReactions.length,
          messages: messagesWithReactions,
        });
      } catch (error) {
        return ClientResponse.json(
          { error: error instanceof Error ? error.message : "Unknown error" },
          { status: 500 }
        );
      }
    }
    return new ClientResponse("Method not allowed", { status: 405 });
  }

  return new ClientResponse("Not found", { status: 404 });
}
