import { Client, Events, GatewayIntentBits } from "discord.js";

let client: Client<boolean>;

export function initDiscord() {
  return new Promise<void>((resolve) => {
    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    client.login(process.env.DISCORD_TOKEN);

    client.once(Events.ClientReady, (c) => {
      resolve();
    });
  });
}

export function getClient() {
  if (!client?.isReady()) {
    throw new Error("Discord client not ready");
  }
  return client;
}
