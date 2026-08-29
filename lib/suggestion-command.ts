import {
  ApplicationCommandOptionType,
  EmbedBuilder,
  Events,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { SUGGESTIONS_ISSUES_CHANNEL } from "./channels";
import { getForumPosts } from "./discord";

/**
 * `/suggestion` slash command: autocomplete search over suggestions-issues
 * forum post titles, posts a link — for "this was already suggested, vote
 * here" without hunting through the forum.
 *
 * Search covers active posts + the most recent archived ones (the forum has
 * 850+ historical posts; fetching all starter contents would be too slow for
 * autocomplete, and old posts are rarely link targets).
 */

const SUGGESTION_COMMAND = "suggestion";
const CACHE_TTL_MS = 5 * 60 * 1000;
const POST_FETCH_LIMIT = 200;

type PostInfo = { id: string; title: string; archived: boolean };

let postCache: { at: number; posts: PostInfo[] } | null = null;

async function getPosts(): Promise<PostInfo[]> {
  if (postCache && Date.now() - postCache.at < CACHE_TTL_MS) {
    return postCache.posts;
  }
  const threads = await getForumPosts(
    SUGGESTIONS_ISSUES_CHANNEL.id,
    POST_FETCH_LIMIT,
  );
  const posts = threads.map((thread) => ({
    id: thread.id,
    title: thread.name,
    archived: thread.archived ?? false,
  }));
  postCache = { at: Date.now(), posts };
  return posts;
}

export function searchPosts(posts: PostInfo[], query: string): PostInfo[] {
  const q = query.toLowerCase().trim();
  if (!q) {
    return posts.slice(0, 25);
  }
  const words = q.split(/\s+/).filter(Boolean);
  return posts
    .map((post) => {
      const title = post.title.toLowerCase();
      const hits = words.filter((word) => title.includes(word)).length;
      return { post, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 25)
    .map((s) => s.post);
}

function choiceName(title: string): string {
  return title.length > 100 ? title.slice(0, 99) + "…" : title;
}

async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const query = interaction.options.getFocused();
  const results = searchPosts(await getPosts(), query);
  await interaction.respond(
    results.map((post) => ({ name: choiceName(post.title), value: post.id })),
  );
}

async function handleCommand(interaction: ChatInputCommandInteraction) {
  const postId = interaction.options.getString("post", true);
  const user = interaction.options.getUser("user");

  await interaction.deferReply();

  const posts = await getPosts();
  const post =
    posts.find((p) => p.id === postId) ?? searchPosts(posts, postId)[0];

  if (!post) {
    await interaction.editReply({
      content: `No suggestion post found for "${postId.slice(0, 100)}".`,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(post.title.slice(0, 256))
    .setDescription(
      `💡 <#${post.id}>\n\nVote and discuss there instead of opening a duplicate.`,
    )
    .setColor(0xfee75c);

  await interaction.editReply({
    content: user
      ? `<@${user.id}> this was already suggested — have a look:`
      : undefined,
    embeds: [embed],
  });
}

export function registerSuggestionCommand(client: Client) {
  const guild = client.guilds.cache.first();
  if (!guild) {
    return;
  }

  void guild.commands
    .create({
      name: SUGGESTION_COMMAND,
      description: "Link an existing suggestions-issues forum post",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "post",
          description: "Search suggestion titles",
          required: true,
          autocomplete: true,
        },
        {
          type: ApplicationCommandOptionType.User,
          name: "user",
          description: "Mention this user with the link",
          required: false,
        },
      ],
    })
    .then(() => console.log("[suggestion-command] /suggestion registered"))
    .catch((err) =>
      console.error("[suggestion-command] registration failed", err),
    );

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (
        interaction.isAutocomplete() &&
        interaction.commandName === SUGGESTION_COMMAND
      ) {
        await handleAutocomplete(interaction);
      } else if (
        interaction.isChatInputCommand() &&
        interaction.commandName === SUGGESTION_COMMAND
      ) {
        await handleCommand(interaction);
      }
    } catch (err) {
      console.error("[suggestion-command] interaction failed", err);
      if (interaction.isChatInputCommand() && interaction.isRepliable()) {
        try {
          if (interaction.deferred) {
            await interaction.editReply({
              content: "Something went wrong — please try again.",
            });
          } else if (!interaction.replied) {
            await interaction.reply({
              content: "Something went wrong — please try again.",
              flags: MessageFlags.Ephemeral,
            });
          }
        } catch {
          // Nothing sensible left to do.
        }
      }
    }
  });
}
