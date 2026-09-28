import { GAME_REQUESTS_CHANNEL } from "../../lib/channels";
import { getClient } from "../../lib/discord";
import { getSingleForumPost } from "../../lib/forum";
import {
  getGameRequestsSyncStatus,
  syncGameRequests,
} from "../../lib/game-requests";
import { ClientResponse } from "../../lib/http";

/**
 * #game-requests sync endpoint (web → Discord, see lib/game-requests.ts).
 *
 *   GET  /api/game-requests/sync        status of the last/current run
 *   POST /api/game-requests/sync        start a run in the background
 *   GET  /api/game-requests/{threadId}  one game's thread with its replies
 *                                       (read by www.th.gl/stats/<id>, like
 *                                       /api/suggestions-issues/{postId})
 *
 * POST requires STATS_BOT_SECRET via the `x-sync-secret` header.
 */
const userNames = new Map<string, string>();

async function userName(id: string): Promise<string> {
  const cached = userNames.get(id);
  if (cached) return cached;
  const user = await getClient().users.fetch(id).catch(() => null);
  const name = user?.globalName ?? user?.username ?? "unknown";
  userNames.set(id, name);
  return name;
}

/**
 * Website-friendly text: the bot's own posts in these threads (quoted
 * #other-games history, mirrored comments) use mentions with pings
 * disabled, so cleanContent leaves raw `<@id>`. Resolve those, Discord
 * timestamps and channel links, and drop the quote/bold markdown the site
 * renders as plain text.
 */
async function toPlainText(text: string): Promise<string> {
  const ids = [...new Set([...text.matchAll(/<@!?(\d{15,21})>/g)].map((m) => m[1]))];
  const names = new Map(await Promise.all(ids.map(async (id) => [id, await userName(id)] as const)));
  return text
    .replace(/<@!?(\d{15,21})>/g, (_, id) => `@${names.get(id) ?? "unknown"}`)
    .replace(/<t:(\d+)(?::[a-zA-Z])?>/g, (_, ts) =>
      new Date(Number(ts) * 1000).toISOString().slice(0, 10),
    )
    .replace(/<#(\d{15,21})>/g, (_, id) => {
      const channel = getClient().channels.cache.get(id);
      return channel && "name" in channel && channel.name ? `#${channel.name}` : "#channel";
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1: $2")
    .replace(/^> ?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1");
}

export async function handleGameRequests(req: Request, url: URL) {
  if (req.method === "OPTIONS") {
    return new ClientResponse("", { status: 204 });
  }
  const segment = url.pathname.split("/")[3]; // /api/game-requests/{segment}
  if (segment && segment !== "sync") {
    if (req.method !== "GET" || !/^\d{15,21}$/.test(segment)) {
      return new ClientResponse("Not found", { status: 404 });
    }
    try {
      const post = await getSingleForumPost(GAME_REQUESTS_CHANNEL.id, segment);
      if (!post) return new ClientResponse("Not found", { status: 404 });
      for (const reply of post.replies) reply.text = await toPlainText(reply.text);
      return ClientResponse.json(post);
    } catch (error) {
      console.error("[game-requests] thread fetch failed", error);
      return new ClientResponse("Error fetching thread", { status: 500 });
    }
  }
  if (req.method === "GET") {
    return ClientResponse.json(getGameRequestsSyncStatus());
  }
  if (req.method !== "POST") {
    return new ClientResponse("Method not allowed", { status: 405 });
  }
  const secret = process.env.STATS_BOT_SECRET;
  if (!secret || req.headers.get("x-sync-secret") !== secret) {
    return new ClientResponse("Unauthorized", { status: 401 });
  }
  void syncGameRequests().catch(() => undefined);
  return ClientResponse.json(
    {
      started: true,
      message: "Sync started. Poll GET /api/game-requests/sync for the result.",
    },
    { status: 202 },
  );
}
