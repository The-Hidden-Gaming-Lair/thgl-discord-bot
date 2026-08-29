import type { Message } from "discord.js";
import { getAppUpdatesMessages } from "./app-updates-cache";
import { getGameConfig } from "./game-roles";
import { resolveRoleId } from "./game-resolver";

/**
 * Shared logic for finding a game's update messages in the central
 * app-updates channel. Used by the /api/updates route and the /updates
 * slash command.
 */

export type SimpleMessage = {
  text: string;
  images: string[];
  timestamp: number;
};

/** Check if a message matches a game by role mentions or title keywords. */
export function messageMatchesGame(
  message: Message,
  gameName: string,
  candidateRoleIds: string[],
): boolean {
  // Match by role mention (live-resolved role unioned with hardcoded ids)
  if (candidateRoleIds.length > 0) {
    const messageRoleIds = Array.from(message.mentions.roles.keys());
    if (candidateRoleIds.some((id) => messageRoleIds.includes(id))) return true;
  }
  // Fallback: title keywords (first line is usually the title)
  const gameConfig = getGameConfig(gameName);
  const content = message.content || message.cleanContent || "";
  const titleMatch = content.split("\n")[0];
  if (gameConfig?.titleKeywords) {
    const lowerTitle = titleMatch.toLowerCase();
    return gameConfig.titleKeywords.some((keyword) =>
      lowerTitle.includes(keyword),
    );
  }
  return false;
}

export function toSimpleMessage(message: Message): SimpleMessage {
  return {
    text: message.cleanContent,
    images: message.attachments
      .filter((attachment) => attachment.contentType?.startsWith("image"))
      .map((attachment) => attachment.url),
    timestamp: message.createdTimestamp,
  };
}

/** Latest update messages for a game from the central app-updates channel. */
export async function getMessagesFromCentralChannel(
  gameName: string,
  limit: number = 5,
): Promise<SimpleMessage[]> {
  const allMessages = await getAppUpdatesMessages();

  // Resolve the game's role once per request: live guild role (by title)
  // unioned with hardcoded roleIds; each is independently sufficient.
  const resolved = await resolveRoleId(gameName);
  const hardcoded = getGameConfig(gameName)?.roleIds ?? [];
  const candidateRoleIds = [
    ...new Set([...(resolved ? [resolved] : []), ...hardcoded]),
  ];

  const matchingMessages = allMessages.filter((message) =>
    messageMatchesGame(message, gameName, candidateRoleIds),
  );

  return matchingMessages.slice(0, limit).map(toSimpleMessage);
}
