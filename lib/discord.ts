import { Client, Events, GatewayIntentBits, ThreadChannel } from "discord.js";

let _client: Client<boolean>;

const DISCORD_EPOCH = 1420070400000n;

function timestampFromSnowflake(id: string) {
  try {
    const snowflake = BigInt(id);
    return Number((snowflake >> 22n) + DISCORD_EPOCH);
  } catch {
    return null;
  }
}

function toMillis(value?: number | Date | null) {
  if (!value) {
    return null;
  }

  if (typeof value === "number") {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return null;
}

export function initDiscord() {
  return new Promise<void>((resolve) => {
    _client = new Client({ intents: [GatewayIntentBits.Guilds] });
    _client.login(process.env.DISCORD_TOKEN);

    _client.once(Events.ClientReady, () => {
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

function getThreadActivityTimestamp(thread: ThreadChannel) {
  const lastMessageTimestamp =
    thread.lastMessage?.createdTimestamp ??
    (thread.lastMessageId ? timestampFromSnowflake(thread.lastMessageId) : null);

  const lastPinTimestamp = toMillis(thread.lastPinTimestamp);
  const archiveTimestamp = toMillis(thread.archiveTimestamp);

  return (
    lastMessageTimestamp ??
    lastPinTimestamp ??
    archiveTimestamp ??
    thread.createdTimestamp ??
    0
  );
}

export async function getForumPosts(id: string, limit?: number) {
  const channel = getForumChannel(id);

  // Fetch all active threads
  const activeThreads = await channel.threads.fetchActive();
  const activeThreadsList = [...activeThreads.threads.values()] as ThreadChannel[];

  // If limit is specified and we already have enough from active threads, return early
  if (limit && activeThreadsList.length >= limit) {
    return activeThreadsList
      .sort(
        (a, b) =>
          getThreadActivityTimestamp(b) - getThreadActivityTimestamp(a),
      )
      .slice(0, limit);
  }

  // Calculate how many archived threads we need
  const remainingNeeded = limit
    ? Math.max(limit - activeThreadsList.length, 0)
    : undefined;

  // Fetch archived threads - Discord API limits to 100 per request
  const archivedThreads: ThreadChannel[] = [];
  let hasMore = true;
  let before: string | undefined;

  while (hasMore) {
    // If we have a limit and already collected enough, break early
    if (remainingNeeded && archivedThreads.length >= remainingNeeded) {
      break;
    }

    const remaining =
      remainingNeeded !== undefined
        ? remainingNeeded - archivedThreads.length
        : undefined;

    if (remaining !== undefined && remaining <= 0) {
      break;
    }

    const batchLimit =
      remaining !== undefined ? Math.min(100, remaining) : 100;

    const batch = await channel.threads.fetchArchived({
      limit: Math.max(1, batchLimit),
      before,
    });
    const values = [...batch.threads.values()] as ThreadChannel[];
    archivedThreads.push(...values);

    // Check if there are more threads to fetch
    hasMore = batch.hasMore ?? false;
    if (hasMore && batch.threads.size > 0) {
      // Get the oldest thread's ID from this batch to use as 'before' for next fetch
      const oldestThread = [...values].sort((a, b) => {
        const aTime =
          typeof a.archiveTimestamp === "number"
            ? a.archiveTimestamp
            : a.archiveTimestamp?.getTime() ?? 0;
        const bTime =
          typeof b.archiveTimestamp === "number"
            ? b.archiveTimestamp
            : b.archiveTimestamp?.getTime() ?? 0;
        return aTime - bTime;
      })[0];
      before = oldestThread?.id;
    }
  }

  // Combine active and archived threads
  const allThreads: ThreadChannel[] = [
    ...activeThreadsList,
    ...archivedThreads,
  ];

  // Sort by latest activity (newest first)
  const sortedThreads = allThreads.sort(
    (a, b) => getThreadActivityTimestamp(b) - getThreadActivityTimestamp(a)
  );

  // Apply limit if specified, otherwise return all
  return limit ? sortedThreads.slice(0, limit) : sortedThreads;
}
