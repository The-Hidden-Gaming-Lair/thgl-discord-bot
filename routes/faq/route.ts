import { syncFaq } from "../../lib/faq";
import { ClientResponse } from "../../lib/http";

/**
 * FAQ sync endpoint — mirrors the web FAQ into the Discord FAQ forum.
 *
 *   POST /api/faq/sync            create/update synced threads; list (but do
 *                                 NOT perform) deletions as a dry run
 *   POST /api/faq/sync?apply=true also delete legacy/orphaned threads
 *
 * If FAQ_SYNC_SECRET is set, requests must pass it via the
 * `x-sync-secret` header or `?secret=` query param.
 */
export async function handleFaq(req: Request, url: URL) {
  if (req.method === "OPTIONS") {
    return new ClientResponse("", { status: 204 });
  }
  if (req.method !== "POST") {
    return new ClientResponse("Method not allowed", { status: 405 });
  }

  const secret = process.env.FAQ_SYNC_SECRET;
  if (secret) {
    const provided =
      req.headers.get("x-sync-secret") || url.searchParams.get("secret");
    if (provided !== secret) {
      return new ClientResponse("Unauthorized", { status: 401 });
    }
  }

  const applyDeletes = url.searchParams.get("apply") === "true";

  try {
    const report = await syncFaq({ applyDeletes });
    return ClientResponse.json(report);
  } catch (error: any) {
    console.error("FAQ sync failed:", error);
    return new ClientResponse(
      `FAQ sync failed: ${error?.message ?? String(error)}`,
      { status: 500 },
    );
  }
}
