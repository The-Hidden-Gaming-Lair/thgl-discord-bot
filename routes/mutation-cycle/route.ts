import { getLatestMutationCycle } from "../../lib/mutation-cycle";

export async function handleMutationCycle(req: Request) {
  if (req.method === "GET") {
    const latestMutationCycle = await getLatestMutationCycle();
    return Response.json(latestMutationCycle);
  }
  if (req.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        Allow: "OPTIONS, GET",
      },
    });
  }
  return new Response("Method not allowed", {
    status: 405,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
