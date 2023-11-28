import { INFO_CHANNELS } from "../../lib/channels";
import { ClientResponse } from "../../lib/http";
import { getMessages } from "../../lib/messages";

export async function handleInfo(req: Request, url: URL) {
  if (req.method === "GET") {
    const channelName = url.pathname.split("/")[3];
    if (!channelName) {
      const channels = INFO_CHANNELS.map((channel) => ({
        name: channel.name,
        link: `${url}/${channel.name}`,
      }));
      return ClientResponse.json(channels);
    }
    const channel = INFO_CHANNELS.find(
      (channel) => channel.name === channelName
    );
    if (!channel) {
      return new ClientResponse("Not found", { status: 404 });
    }
    const messages = await getMessages(channel.id);
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
