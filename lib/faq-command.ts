import {
  ApplicationCommandOptionType,
  EmbedBuilder,
  Events,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { FAQ_CHANNEL } from "./channels";
import { getForumPosts } from "./discord";
import { absolutizeLinks, fetchFaqFeed, parseFaqId, type FaqEntry } from "./faq";

/**
 * `/faq` slash command: search the canonical web FAQ (th.gl/api/faq) via
 * autocomplete and post an answer embed with both links — the Discord forum
 * post and the full th.gl page. Optionally mentions a user.
 *
 * The native `#`-mention picker only searches post titles (poorly, and not
 * archived posts) — this searches question, headline, answer, and labels.
 */

const FAQ_COMMAND = "faq";
const CACHE_TTL_MS = 5 * 60 * 1000;
const EXCERPT_LENGTH = 400;

let feedCache: {
  at: number;
  entries: FaqEntry[];
  baseUrl: string;
} | null = null;

async function getFaqData() {
  if (feedCache && Date.now() - feedCache.at < CACHE_TTL_MS) {
    return feedCache;
  }
  const feed = await fetchFaqFeed();
  feedCache = { at: Date.now(), entries: feed.entries, baseUrl: feed.baseUrl };
  return feedCache;
}

// faqId -> forum thread id, from the canonical link in each starter message
// (same identity marker the FAQ sync uses).
let threadCache: { at: number; byId: Map<string, string> } | null = null;

async function getFaqThreadMap(): Promise<Map<string, string>> {
  if (threadCache && Date.now() - threadCache.at < CACHE_TTL_MS) {
    return threadCache.byId;
  }
  const byId = new Map<string, string>();
  const threads = await getForumPosts(FAQ_CHANNEL.id);
  await Promise.all(
    threads.map(async (thread) => {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      const faqId = starter ? parseFaqId(starter.content) : null;
      if (faqId && !byId.has(faqId)) {
        byId.set(faqId, thread.id);
      }
    }),
  );
  threadCache = { at: Date.now(), byId };
  return byId;
}

/** Rank entries for a query: question/headline hits outrank answer/label hits. */
export function searchFaqEntries(entries: FaqEntry[], query: string): FaqEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) {
    return entries.slice(0, 25);
  }
  const scored = entries
    .map((entry) => {
      let score = 0;
      if (entry.question?.toLowerCase().includes(q)) score += 4;
      if (entry.headline?.toLowerCase().includes(q)) score += 3;
      if (entry.labels?.some((label) => label.toLowerCase().includes(q))) score += 2;
      if (entry.answer?.toLowerCase().includes(q)) score += 1;
      return { entry, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 25).map((s) => s.entry);
}

function choiceName(entry: FaqEntry): string {
  const name = entry.question?.trim() || entry.headline.trim();
  return name.length > 100 ? name.slice(0, 99) + "…" : name;
}

function excerpt(answer: string): string {
  const text = absolutizeLinks(answer.trim());
  if (text.length <= EXCERPT_LENGTH) {
    return text;
  }
  const cut = text.lastIndexOf("\n", EXCERPT_LENGTH);
  return text.slice(0, cut > EXCERPT_LENGTH * 0.5 ? cut : EXCERPT_LENGTH).trimEnd() + "\n…";
}

async function handleAutocomplete(interaction: AutocompleteInteraction) {
  const query = interaction.options.getFocused();
  const { entries } = await getFaqData();
  const results = searchFaqEntries(entries, query);
  await interaction.respond(
    results.map((entry) => ({ name: choiceName(entry), value: entry.id })),
  );
}

async function handleCommand(interaction: ChatInputCommandInteraction) {
  const entryId = interaction.options.getString("entry", true);
  const user = interaction.options.getUser("user");

  // Public reply — the point is showing the answer to whoever asked.
  await interaction.deferReply();

  const { entries, baseUrl } = await getFaqData();
  const entry =
    entries.find((e) => e.id === entryId) ??
    // Free-typed text instead of an autocomplete pick: best search hit.
    searchFaqEntries(entries, entryId)[0];

  if (!entry) {
    await interaction.editReply({
      content: `No FAQ entry found for "${entryId.slice(0, 100)}".`,
    });
    return;
  }

  const webLink = `${baseUrl.replace(/\/$/, "")}/${entry.id}`;
  const threadId = (await getFaqThreadMap().catch(() => new Map())).get(entry.id);
  const links = [
    `📖 [Full answer on th.gl](${webLink})`,
    threadId ? `💬 Discord post: <#${threadId}>` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle((entry.question?.trim() || entry.headline).slice(0, 256))
    .setDescription(`${excerpt(entry.answer)}\n\n${links}`)
    .setColor(0x5865f2)
    .setFooter({ text: `FAQ · ${entry.id}` });

  await interaction.editReply({
    content: user ? `<@${user.id}> this should answer your question:` : undefined,
    embeds: [embed],
  });
}

export function registerFaqCommand(client: Client) {
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.log("[faq-command] no guild in cache, command not registered");
    return;
  }

  // Guild command (instant availability; global takes up to an hour).
  // Creating a command with an existing name overwrites it — safe on reboots.
  void guild.commands
    .create({
      name: FAQ_COMMAND,
      description: "Look up a FAQ entry and post the answer with links",
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: "entry",
          description: "Search the FAQ (question, keywords, …)",
          required: true,
          autocomplete: true,
        },
        {
          type: ApplicationCommandOptionType.User,
          name: "user",
          description: "Mention this user with the answer",
          required: false,
        },
      ],
    })
    .then(() => console.log("[faq-command] /faq registered"))
    .catch((err) => console.error("[faq-command] registration failed", err));

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (
        interaction.isAutocomplete() &&
        interaction.commandName === FAQ_COMMAND
      ) {
        await handleAutocomplete(interaction);
      } else if (
        interaction.isChatInputCommand() &&
        interaction.commandName === FAQ_COMMAND
      ) {
        await handleCommand(interaction);
      }
    } catch (err) {
      console.error("[faq-command] interaction failed", err);
      if (interaction.isRepliable()) {
        const payload = {
          content: "Something went wrong — please try again.",
          flags: MessageFlags.Ephemeral,
        } as const;
        try {
          if (interaction.isChatInputCommand() && interaction.deferred) {
            await interaction.editReply({ content: payload.content });
          } else if (
            interaction.isChatInputCommand() &&
            !interaction.replied
          ) {
            await interaction.reply(payload);
          }
        } catch {
          // Nothing sensible left to do.
        }
      }
    }
  });
}
