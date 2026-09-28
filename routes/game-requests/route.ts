import {
  getGameRequestsSyncStatus,
  syncGameRequests,
} from "../../lib/game-requests";
import { ClientResponse } from "../../lib/http";

/**
 * #game-requests sync endpoint (web → Discord, see lib/game-requests.ts).
 *
 *   GET  /api/game-requests/sync   status of the last/current run
 *   POST /api/game-requests/sync   start a run in the background
 *
 * POST requires STATS_BOT_SECRET via the `x-sync-secret` header.
 */
export async function handleGameRequests(req: Request) {
  if (req.method === "OPTIONS") {
    return new ClientResponse("", { status: 204 });
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
