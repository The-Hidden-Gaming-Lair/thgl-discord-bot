import { ClientResponse } from "../../lib/http";
import { getLatestMutationCycle } from "../../lib/mutation-cycle";

export async function handleMutationCycle(req: Request, _url: URL) {
  if (req.method === "GET") {
    const latestMutationCycle = await getLatestMutationCycle();
    return ClientResponse.json(latestMutationCycle);
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
