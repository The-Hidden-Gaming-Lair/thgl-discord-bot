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

export function getForumChannel(id: string) {
  const channel = getChannel(id);
  if (!channel.isThreadOnly()) {
    throw new Error(`Channel ${id} is not a forum channel`);
  }
  return channel;
}

export async function getForumPosts(id: string, limit?: number) {
  const channel = getForumChannel(id);

  // Fetch all active threads
  const activeThreads = await channel.threads.fetchActive();

  // Fetch archived threads - Discord API limits to 100 per request
  // We'll fetch multiple times if needed to get all archived threads
  const archivedThreads: any[] = [];
  let hasMore = true;
  let before: string | undefined = undefined;

  while (hasMore) {
    const batch = await channel.threads.fetchArchived({
      limit: 100,
      before
    });

    archivedThreads.push(...batch.threads.values());

    // Check if there are more threads to fetch
    hasMore = batch.hasMore || false;
    if (hasMore && batch.threads.size > 0) {
      // Get the oldest thread's ID from this batch to use as 'before' for next fetch
      const oldestThread = [...batch.threads.values()].sort((a, b) => {
        const aTime = a.archiveTimestamp ?
          (typeof a.archiveTimestamp === 'number' ? a.archiveTimestamp : a.archiveTimestamp.getTime()) : 0;
        const bTime = b.archiveTimestamp ?
          (typeof b.archiveTimestamp === 'number' ? b.archiveTimestamp : b.archiveTimestamp.getTime()) : 0;
        return aTime - bTime;
      })[0];
      before = oldestThread?.id;
    }
  }

  // Combine active and archived threads
  const allThreads = [...activeThreads.threads.values(), ...archivedThreads];

  // Sort by creation time (newest first)
  const sortedThreads = allThreads
    .sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0));

  // Apply limit if specified, otherwise return all
  return limit ? sortedThreads.slice(0, limit) : sortedThreads;
}
