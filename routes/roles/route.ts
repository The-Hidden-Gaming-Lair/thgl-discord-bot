import { ClientResponse } from "../../lib/http";
import { getAllGameRoles } from "../../lib/game-resolver";

/**
 * GET /api/roles
 *
 * Exposes the game -> Discord role-ID mapping so other tools (e.g. data-forge's
 * scripts/post-release-notes.ts) can build the `<@&ROLE_ID>` ping mention without
 * hardcoding a copy of the IDs.
 *
 * Returns only games that actually have a role to ping:
 *   [{ name, roleId, channelId }]
 * Every canonical game resolves its LIVE guild role by title (lib/game-resolver.ts), so a role
 * the games-sync reconciler just created appears here without a code change; GAME_CONFIGS stays
 * the fallback for legacy names.
 */
export async function handleRoles(req: Request, _url: URL) {
  if (req.method === "OPTIONS") {
    return new ClientResponse("", { status: 204 });
  }
  if (req.method !== "GET") {
    return new ClientResponse("Method not allowed", { status: 405 });
  }

  return ClientResponse.json(await getAllGameRoles());
}
