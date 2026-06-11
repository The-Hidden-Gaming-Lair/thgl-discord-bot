import { ClientResponse } from "../../lib/http";
import { GAME_CONFIGS } from "../../lib/game-roles";

/**
 * GET /api/roles
 *
 * Exposes the game -> Discord role-ID mapping from lib/game-roles.ts so other
 * tools (e.g. data-forge's scripts/draft-release-notes.ts) can build the
 * `<@&ROLE_ID>` ping mention without hardcoding a copy of the IDs.
 *
 * Returns only games that actually have a role to ping:
 *   [{ name, roleId, channelId }]
 * `roleId` is the first entry of GAME_CONFIGS[].roleIds (the primary role).
 */
export async function handleRoles(req: Request, _url: URL) {
  if (req.method === "OPTIONS") {
    return new ClientResponse("", { status: 204 });
  }
  if (req.method !== "GET") {
    return new ClientResponse("Method not allowed", { status: 405 });
  }

  const roles = GAME_CONFIGS.filter(
    (config) => config.roleIds && config.roleIds.length > 0,
  ).map((config) => ({
    name: config.name,
    roleId: config.roleIds![0],
    channelId: config.channelId || null,
  }));

  return ClientResponse.json(roles);
}
