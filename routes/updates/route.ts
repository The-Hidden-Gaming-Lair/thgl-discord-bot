import { CHANNELS } from "../../lib/channels";
import { ClientResponse } from "../../lib/http";
import { getUpdates } from "../../lib/updates";

export async function handleUpdates(req: Request, url: URL) {
  if (req.method === "GET") {
    const channelName = url.pathname.split("/")[3];
    if (!channelName) {
      const channels = CHANNELS.map((channel) => ({
        name: channel.name,
        link: `${url}/${channel.name}`,
      }));
      return ClientResponse.json(channels);
    }
    const channel = CHANNELS.find((channel) => channel.name === channelName);
    if (!channel) {
      return new ClientResponse("Not found", { status: 404 });
    }
    const latestUpdates = await getUpdates(channel.id);
    return ClientResponse.json(latestUpdates);
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
