import { runReconcileGames } from "../../lib/games-provision";
import { ClientResponse } from "../../lib/http";

/**
 * Games sync endpoint — reconciles Discord (role + discussion channel +
 * onboarding option) against the canonical games feed. Mirrors the FAQ sync.
 *
 *   GET  /api/games/sync             dry-run report (read-only)
 *   POST /api/games/sync             dry-run report (read-only)
 *   POST /api/games/sync?apply=true  actually create missing objects
 *
 * apply=true requires the bot to have Manage Roles/Channels/Guild; if
 * GAMES_SYNC_SECRET is set, apply requests must pass it via the
 * `x-sync-secret` header or `?secret=` query param.
 *
 * NOTE: apply runs synchronously within the request. Before enabling apply
 * (after the bot is granted Manage Roles/Channels/Guild), convert this to a
 * background task with GET status polling like routes/faq/route.ts — a large
 * apply makes many sequential Discord writes that can exceed Bun.serve's
 * idleTimeout. Dry-run (GET / POST without ?apply=true) is read-only and fast.
 */
export async function handleGamesSync(req: Request, url: URL) {
  if (req.method === "OPTIONS") {
    return new ClientResponse("", { status: 204 });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return new ClientResponse("Method not allowed", { status: 405 });
  }

  const wantApply =
    req.method === "POST" && url.searchParams.get("apply") === "true";

  if (wantApply) {
    const secret = process.env.GAMES_SYNC_SECRET;
    if (secret) {
      const provided =
        req.headers.get("x-sync-secret") || url.searchParams.get("secret");
      if (provided !== secret) {
        return new ClientResponse("Unauthorized", { status: 401 });
      }
    }
  }

  try {
    const { alreadyRunning, result } = await runReconcileGames({ apply: wantApply });
    if (alreadyRunning) {
      return ClientResponse.json(
        { started: false, message: "A games sync is already running." },
        { status: 409 },
      );
    }
    return ClientResponse.json({ apply: wantApply, ...result });
  } catch (err) {
    return ClientResponse.json(
      { apply: wantApply, error: (err as Error).message },
      { status: 500 },
    );
  }
}
