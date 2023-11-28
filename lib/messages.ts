import { Message } from "discord.js";
import { getChannelMessages } from "./discord";

export async function getMessages(id: string) {
  const messages = await getChannelMessages(id, 5);
  return messages.map(toMessage);
}

function toMessage(message: Message) {
  return {
    text: message.cleanContent,
    images: message.attachments
      .filter((attachement) => attachement.contentType?.startsWith("image"))
      .map((attachement) => attachement.url),
    timestamp: message.createdTimestamp,
  };
}
