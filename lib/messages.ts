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
  };
}
