import { UPDATES_CHANNELS } from "../../lib/channels";
import { ClientResponse } from "../../lib/http";
import { getMessages } from "../../lib/messages";
import { getAppUpdatesMessages } from "../../lib/app-updates-cache";
import { getGameConfig, findGameByTitle } from "../../lib/game-roles";
import { getChannel } from "../../lib/discord";
import type { Message } from "discord.js";

/**
 * Check if a message matches a game by role mentions or title keywords
 */
function messageMatchesGame(message: Message, gameName: string): boolean {
  const gameConfig = getGameConfig(gameName);
  if (!gameConfig) return false;

  // Check if message mentions any of the game's roles
  if (gameConfig.roleIds && gameConfig.roleIds.length > 0) {
    const messageRoleIds = Array.from(message.mentions.roles.keys());
    const hasRoleMention = gameConfig.roleIds.some((roleId) =>
      messageRoleIds.includes(roleId)
    );
    if (hasRoleMention) return true;
  }

  // Fallback: Check if message title contains game keywords
  const content = message.content || message.cleanContent || "";
  const titleMatch = content.split("\n")[0]; // First line is usually the title

  if (gameConfig.titleKeywords) {
    const lowerTitle = titleMatch.toLowerCase();
    return gameConfig.titleKeywords.some((keyword) =>
      lowerTitle.includes(keyword)
    );
  }

  return false;
}

/**
 * Convert Discord message to simple message format
 */
function toMessage(message: Message) {
  return {
    text: message.cleanContent,
    images: message.attachments
      .filter((attachment) => attachment.contentType?.startsWith("image"))
      .map((attachment) => attachment.url),
    timestamp: message.createdTimestamp,
  };
}

/**
 * Get messages for a game from the app-updates channel by filtering
 */
async function getMessagesFromCentralChannel(gameName: string, limit: number = 5) {
  const allMessages = await getAppUpdatesMessages();

  const matchingMessages = allMessages.filter((message) =>
    messageMatchesGame(message, gameName)
  );

  // Return up to `limit` messages
  return matchingMessages.slice(0, limit).map(toMessage);
}

export async function handleUpdates(req: Request, url: URL) {
  if (req.method === "GET") {
    const channelName = url.pathname.split("/")[3];
    if (!channelName) {
      const channels = UPDATES_CHANNELS.map((channel) => ({
        name: channel.name,
        link: `${url}/${channel.name}`,
      }));
      return ClientResponse.json(channels);
    }

    const channel = UPDATES_CHANNELS.find(
      (channel) => channel.name === channelName
    );
    if (!channel) {
      return new ClientResponse("Not found", { status: 404 });
    }

    // Strategy: Always check central channel, and also check dedicated channel if it exists
    let dedicatedMessages: any[] = [];
    let centralMessages: any[] = [];

    // Try to get messages from dedicated channel if it exists
    try {
      getChannel(channel.id);
      dedicatedMessages = await getMessages(channel.id);
      console.log(
        `[Updates] Found ${dedicatedMessages.length} messages in dedicated channel for ${channel.name}`
      );
    } catch (error) {
      console.log(
        `[Updates] Dedicated channel ${channel.name} not accessible`
      );
    }

    // Always check central app-updates channel for latest updates with role mentions
    centralMessages = await getMessagesFromCentralChannel(channel.name, 5);
    console.log(
      `[Updates] Found ${centralMessages.length} messages in central channel for ${channel.name}`
    );

    // Combine messages from both sources, removing duplicates by timestamp
    const combinedMessages = [...dedicatedMessages, ...centralMessages];
    const seenTimestamps = new Set<number>();
    const uniqueMessages = [];

    for (const msg of combinedMessages) {
      if (!seenTimestamps.has(msg.timestamp)) {
        seenTimestamps.add(msg.timestamp);
        uniqueMessages.push(msg);
      }
    }

    // Sort by newest first and take the 5 most recent
    const messages = uniqueMessages
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5);

    return ClientResponse.json(messages);
  }
  if (req.method === "OPTIONS") {
    return new ClientResponse("", {
      status: 204,
    });
  }
  return new ClientResponse("Method not allowed", {
    status: 405,
  });
}
