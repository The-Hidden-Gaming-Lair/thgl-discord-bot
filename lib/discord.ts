import { Client, Events, GatewayIntentBits } from "discord.js";

let _client: Client<boolean>;

export function initDiscord() {
  return new Promise<void>((resolve) => {
    _client = new Client({ intents: [GatewayIntentBits.Guilds] });
    _client.login(process.env.DISCORD_TOKEN);

    _client.once(Events.ClientReady, (c) => {
      resolve();
    });
  });
}

export function getClient() {
  if (!_client?.isReady()) {
    throw new Error("Discord client not ready");
  }
  return _client;
}

export function getChannel(id: string) {
  const client = getClient();
  const channel = client.channels.cache.get(id);
  if (!channel) {
    throw new Error(`Channel ${id} not found`);
  }
  return channel;
}

export function getTextChannel(id: string) {
  const channel = getChannel(id);
  if (!channel.isTextBased()) {
    throw new Error(`Channel ${id} is not text based`);
  }
  return channel;
}

export function getVoiceChannel(id: string) {
  const channel = getChannel(id);
  if (!channel.isVoiceBased()) {
    throw new Error(`Channel ${id} is not text based`);
  }
  return channel;
}

export function getChannelMessages(id: string, limit: number) {
  const channel = getTextChannel(id);
  return channel.messages.fetch({ limit });
}

export async function setVoiceChannelName(id: string, name: string) {
  const channel = getVoiceChannel(id);
  await channel.setName(name);
}
