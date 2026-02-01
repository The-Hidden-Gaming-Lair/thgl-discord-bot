import { ClientResponse } from "../../lib/http";
import { getChannelMessages, getAllChannels, deleteMessage } from "../../lib/discord";
import { getForumPostsData, getSingleForumPost } from "../../lib/forum";
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
      size: att.size,
      description: att.description,
    })),
    embeds: message.embeds.map((embed) => ({
      title: embed.title,
      description: embed.description,
      url: embed.url,
      color: embed.color,
      timestamp: embed.timestamp,
      author: embed.author ? {
        name: embed.author.name,
        url: embed.author.url,
        iconURL: embed.author.iconURL,
      } : null,
      footer: embed.footer ? {
        text: embed.footer.text,
        iconURL: embed.footer.iconURL,
      } : null,
      thumbnail: embed.thumbnail ? {
        url: embed.thumbnail.url,
      } : null,
      image: embed.image ? {
        url: embed.image.url,
      } : null,
      fields: embed.fields.map((field) => ({
        name: field.name,
        value: field.value,
        inline: field.inline,
      })),
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

  const endpoint = pathParts[2]; // 'messages', 'search', 'reactions', or 'forum'

  if (endpoint === "messages") {
    // GET /api/mcp/messages?channel=announcements&limit=10&after=1698518400000
    // channel can be: ID, name, or "category/name"
    // after: optional timestamp in milliseconds - only return messages after this time
    if (req.method === "GET") {
      const channelIdentifier = url.searchParams.get("channel");
      const limit = parseInt(url.searchParams.get("limit") || "10", 10);
      const afterParam = url.searchParams.get("after");

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
        const messages = await getChannelMessages(
          channel.id,
          Math.min(limit, 100)
        );

        // Filter by timestamp if provided
        let filteredMessages = messages;
        if (afterParam) {
          const afterTimestamp = parseInt(afterParam, 10);
          if (isNaN(afterTimestamp)) {
            return ClientResponse.json(
              { error: "'after' parameter must be a valid timestamp in milliseconds" },
              { status: 400 }
            );
          }
          filteredMessages = messages.filter((msg) => msg.createdTimestamp > afterTimestamp);
        }

        const formattedMessages = filteredMessages.map(formatMessage);

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
        const messages = await getChannelMessages(
          channel.id,
          Math.min(limit, 100)
        );
        const lowerQuery = query.toLowerCase();
        const matchingMessages = messages
          .filter((msg) => {
            // Search in message content
            if (msg.cleanContent.toLowerCase().includes(lowerQuery)) return true;
            // Search in embed titles, descriptions, and field values
            for (const embed of msg.embeds) {
              if (embed.title?.toLowerCase().includes(lowerQuery)) return true;
              if (embed.description?.toLowerCase().includes(lowerQuery)) return true;
              for (const field of embed.fields) {
                if (field.name.toLowerCase().includes(lowerQuery)) return true;
                if (field.value.toLowerCase().includes(lowerQuery)) return true;
              }
            }
            return false;
          })
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
      const minReactions = parseInt(
        url.searchParams.get("min_reactions") || "5",
        10
      );
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
        const messages = await getChannelMessages(
          channel.id,
          Math.min(limit, 100)
        );
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

  if (endpoint === "forum") {
    // GET /api/mcp/forum?channel=FORUM_CHANNEL_ID&limit=50&after=1698518400000
    // Returns forum posts (threads) from a forum channel
    // after: optional timestamp in milliseconds - only return posts created/updated after this time
    if (req.method === "GET") {
      const channelIdentifier = url.searchParams.get("channel");
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const afterParam = url.searchParams.get("after");

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

      // Check if it's a forum channel (accept both "GuildForum" and "forum")
      if (channel.type !== "GuildForum" && channel.type !== "forum") {
        return ClientResponse.json(
          {
            error: `Channel '${channel.name}' is not a forum channel. Type: ${channel.type}`,
          },
          { status: 400 }
        );
      }

      try {
        const posts = await getForumPostsData(channel.id, Math.min(limit, 100));

        // Filter by timestamp if provided
        let filteredPosts = posts;
        if (afterParam) {
          const afterTimestamp = parseInt(afterParam, 10);
          if (isNaN(afterTimestamp)) {
            return ClientResponse.json(
              { error: "'after' parameter must be a valid timestamp in milliseconds" },
              { status: 400 }
            );
          }
          filteredPosts = posts.filter((post: any) => post.createdAt > afterTimestamp);
        }

        return ClientResponse.json({
          channel: channel.name,
          fullName: channel.fullName,
          category: channel.category,
          type: channel.type,
          count: filteredPosts.length,
          posts: filteredPosts,
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

  if (endpoint === "message") {
    // DELETE /api/mcp/message?channel=app-debug&message_id=123456789
    // Deletes a message from a channel
    if (req.method === "DELETE") {
      const channelIdentifier = url.searchParams.get("channel");
      const messageId = url.searchParams.get("message_id");

      if (!channelIdentifier || !messageId) {
        return ClientResponse.json(
          { error: "Missing 'channel' or 'message_id' parameter" },
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
        await deleteMessage(channel.id, messageId);

        return ClientResponse.json({
          success: true,
          channel: channel.name,
          fullName: channel.fullName,
          messageId,
          message: "Message deleted successfully",
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
