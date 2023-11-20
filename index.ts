import { Client, Events, GatewayIntentBits, TextChannel } from "discord.js";

const MUTATION_CYCLE_CHANNEL_ID = "1062724443580936192";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

async function getLatestMutationCycle() {
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
        const expedition = message.content.split("**")[1];
        const mutations = message.content.split("`")[1].split(", ");
        return {
          expedition,
          mutations,
          imageSrc: message.attachments.at(0)?.url,
        };
      } catch (error) {
        console.error(error);
        return null;
      }
    })
    .filter(Boolean);
}
Bun.serve({
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/mutation-cycle") {
      const latestMutationCycle = await getLatestMutationCycle();
      return Response.json(latestMutationCycle);
    }
    return new Response("404!");
  },
});
