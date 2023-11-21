import { TextChannel } from "discord.js";
import { getClient } from "./discord";

const MUTATION_CYCLE_CHANNEL_ID = "1062724443580936192";

export async function getLatestMutationCycle() {
  const client = getClient();
  const channel = client.channels.cache.get(
    MUTATION_CYCLE_CHANNEL_ID
  ) as TextChannel;
  if (!channel) {
    throw new Error(`Channel ${MUTATION_CYCLE_CHANNEL_ID} not found`);
  }
  const messages = await channel.messages.fetch({ limit: 3 });
  return messages
    .map((message) => {
      try {
        const content = message.content.split("\n").map((line) => {
          const expedition = line.split("**")[1];
          const mutations = line.split("`")[1].split(", ");
          return {
            expedition,
            mutations,
          };
        });
        return {
          content,
          imageSrc: message.attachments.at(0)?.url,
          timestamp: message.createdTimestamp,
        };
      } catch (error) {
        // Ignore invalid messages
        return null;
      }
    })
    .filter(Boolean)
    .at(0);
}
