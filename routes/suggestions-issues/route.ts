import { SUGGESTIONS_ISSUES_CHANNEL } from "../../lib/channels";
import { getForumPostsData, getSingleForumPost } from "../../lib/forum";
import { ClientResponse } from "../../lib/http";

export async function handleSuggestionsIssues(req: Request, url: URL) {
  if (req.method === "GET") {
    try {
      // Check if a specific post ID is requested
      const pathParts = url.pathname.split("/");
      const postId = pathParts[4]; // /api/suggestions-issues/{postId}

      if (postId) {
        // Fetch single post with all replies
        const post = await getSingleForumPost(SUGGESTIONS_ISSUES_CHANNEL.id, postId);
        return ClientResponse.json(post);
      } else {
        // Get limit from query parameter, default to all posts (no limit)
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;

        const posts = await getForumPostsData(SUGGESTIONS_ISSUES_CHANNEL.id, limit);
        return ClientResponse.json(posts);
      }
    } catch (error) {
      console.error("Error fetching forum posts:", error);
      return new ClientResponse("Error fetching forum posts", { status: 500 });
    }
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