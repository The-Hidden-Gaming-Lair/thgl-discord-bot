import { startFaqSync, getFaqSyncStatus } from "../../lib/faq";
import { ClientResponse } from "../../lib/http";

/**
 * FAQ sync endpoint — mirrors the web FAQ into the Discord FAQ forum.
 *
 *   GET  /api/faq/sync            status of the last/current run (report included)
 *   POST /api/faq/sync            start a run in the background (dry-run deletions)
 *   POST /api/faq/sync?apply=true also delete legacy/orphaned threads
 *
 * The sync runs in the background and is reported via GET, because it makes
 * many sequential Discord writes that exceed the HTTP request timeout.
 *
 * If FAQ_SYNC_SECRET is set, POST requests must pass it via the
 * `x-sync-secret` header or `?secret=` query param.
 */
export async function handleFaq(req: Request, url: URL) {
  if (req.method === "OPTIONS") {
    return new ClientResponse("", { status: 204 });
  }

  if (req.method === "GET") {
    return ClientResponse.json(getFaqSyncStatus());
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
  const { started, alreadyRunning } = startFaqSync({ applyDeletes });

  if (!started && alreadyRunning) {
    return ClientResponse.json(
      { started: false, message: "A sync is already running." },
      { status: 409 },
    );
  }

  return ClientResponse.json(
    {
      started: true,
      applyDeletes,
      message: "Sync started. Poll GET /api/faq/sync for the result.",
    },
    { status: 202 },
  );
}
