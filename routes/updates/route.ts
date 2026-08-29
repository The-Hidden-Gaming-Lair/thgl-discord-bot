import { UPDATES_CHANNELS } from "../../lib/channels";
import { ClientResponse } from "../../lib/http";
import { getMessages } from "../../lib/messages";
import { getChannel } from "../../lib/discord";
import { getMessagesFromCentralChannel } from "../../lib/game-updates";

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
