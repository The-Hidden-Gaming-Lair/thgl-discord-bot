import { ForumChannel, ThreadChannel } from "discord.js";
import { getForumChannel, getForumPosts } from "./discord";

export async function getForumPostsData(id: string, limit?: number) {
  const forumChannel = getForumChannel(id) as ForumChannel;
  const threads = await getForumPosts(id, limit);

  // Get available tags from the forum channel
  const availableTags = forumChannel.availableTags;
  const postsData = await Promise.all(
    threads.map(async (thread: ThreadChannel) => {
      let starterMessage;
      try {
        // Fetch the starter message (first post in the thread)
        starterMessage = await thread.fetchStarterMessage();
      } catch (error: any) {
        // Continue with null starterMessage
        starterMessage = null;
      }

      // Convert tag IDs to tag names/labels
      const tags = thread.appliedTags
        .map((tagId) => {
          const tag = availableTags.find((t) => t.id === tagId);
          return tag
            ? {
                id: tag.id,
                name: tag.name,
                emoji: tag.emoji?.name || null,
                moderated: tag.moderated,
              }
            : null;
        })
        .filter((tag) => tag !== null);

      return {
        id: thread.id,
        title: thread.name,
        author: starterMessage?.author.username || "Unknown",
        createdAt: thread.createdTimestamp,
        tags,
        archived: thread.archived,
        locked: thread.locked,
        messageCount: thread.messageCount || 0,
        memberCount: thread.memberCount || 0,
        content: {
          text: starterMessage?.cleanContent || "",
          images:
            starterMessage?.attachments
              .filter((att) => att.contentType?.startsWith("image"))
              .map((att) => att.url) || [],
        },
      };
    })
  );

  return postsData;
}

export async function getSingleForumPost(channelId: string, threadId: string) {
  const forumChannel = getForumChannel(channelId) as ForumChannel;

  // Fetch the specific thread
  const thread =
    forumChannel.threads.cache.get(threadId) ??
    (await forumChannel.threads.fetch(threadId).catch(() => null));

  if (!thread) {
    return null;
  }

  // Get available tags from the forum channel
  const availableTags = forumChannel.availableTags;

  // Fetch the starter message
  const starterMessage = await thread.fetchStarterMessage().catch(() => null);

  // Fetch ALL messages from the thread (up to 100)
  const allMessages = await thread.messages.fetch({ limit: 100 });

  // Sort messages by timestamp (oldest first) and filter out starter message
  const replies = allMessages
    .filter((msg) => !starterMessage || msg.id !== starterMessage.id)
    .sort((a, b) => (a.createdTimestamp || 0) - (b.createdTimestamp || 0))
    .map((msg) => ({
      id: msg.id,
      author: {
        username: msg.author.username,
        avatar: msg.author.displayAvatarURL(),
        bot: msg.author.bot,
      },
      text: msg.cleanContent,
      timestamp: msg.createdTimestamp,
      images: msg.attachments
        .filter((att) => att.contentType?.startsWith("image"))
        .map((att) => att.url),
      reactions: msg.reactions.cache.map((reaction) => ({
        emoji: reaction.emoji.name,
        count: reaction.count,
      })),
    }));

  // Convert tag IDs to tag names/labels
  const tags = thread.appliedTags
    .map((tagId) => {
      const tag = availableTags.find((t) => t.id === tagId);
      return tag
        ? {
            id: tag.id,
            name: tag.name,
            emoji: tag.emoji?.name || null,
            moderated: tag.moderated,
          }
        : null;
    })
    .filter((tag) => tag !== null);

  return {
    id: thread.id,
    title: thread.name,
    author: {
      username: starterMessage?.author.username || "Unknown",
      avatar: starterMessage?.author.displayAvatarURL() || null,
      bot: starterMessage?.author.bot || false,
    },
    createdAt: thread.createdTimestamp,
    lastActivity:
      thread.lastMessage?.createdTimestamp || thread.createdTimestamp,
    tags,
    archived: thread.archived,
    locked: thread.locked,
    messageCount: thread.messageCount || 0,
    memberCount: thread.memberCount || 0,
    content: {
      text: starterMessage?.cleanContent || "",
      images:
        starterMessage?.attachments
          .filter((att) => att.contentType?.startsWith("image"))
          .map((att) => att.url) || [],
      reactions:
        starterMessage?.reactions.cache.map((reaction) => ({
          emoji: reaction.emoji.name,
          count: reaction.count,
        })) || [],
    },
    replies, // All replies in chronological order
  };
}
