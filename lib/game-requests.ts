import {
  EmbedBuilder,
  ThreadAutoArchiveDuration,
  type ForumChannel,
  type GuildForumTag,
  type Message,
  type ThreadChannel,
} from "discord.js";
import { GAME_REQUESTS_CHANNEL } from "./channels";
import { getClient, getForumChannel, getForumPosts } from "./discord";

/**
 * Web → Discord game-requests sync (www.th.gl/requests ↔ #game-requests).
 *
 * The website (Bunny DB behind /api/stats/*) is the single source of truth
 * for requested games, their status and votes. This module mirrors it into
 * the #game-requests forum, the same way lib/faq.ts mirrors the FAQ:
 *
 * - one bot-authored thread per requested / watching / in-progress game,
 *   matched by the canonical `th.gl/stats/<id>` link in its starter post;
 *   the thread id is reported back so the website can link to it
 * - the status is the thread's (moderated) forum tag; a status change posts
 *   a short message in the thread so its followers get notified
 * - 👍 reactors on the starter post are reported as the game's Discord votes
 *   (read via REST on every run, so no reaction intent is needed and votes
 *   made while the bot was down are picked up on the next run)
 *
 * Env: STATS_BOT_SECRET (required), STATS_API_URL (default
 * https://www.th.gl/api/stats).
 */

const STATS_API_URL = (
  process.env.STATS_API_URL || "https://www.th.gl/api/stats"
).replace(/\/$/, "");
const SITE_URL = "https://www.th.gl";
const VOTE_EMOJI = "👍";
const MAX_THREAD_NAME_LENGTH = 100;

export type RequestStatus =
  | "supported"
  | "in_progress"
  | "watching"
  | "requested"
  | "declined";

export type StatsGame = {
  id: string;
  title: string;
  status: RequestStatus;
  thglId: string | null;
  steamAppId: number | null;
  platforms: { client: string; url?: string; status?: string }[];
  imageUrl: string | null;
  releaseDate: string | null;
  url: string | null;
  note: string | null;
  voteCount: number;
  discordThreadId: string | null;
};

/** Statuses that get a thread; supported/declined keep an existing one. */
const THREAD_STATUSES: RequestStatus[] = ["requested", "watching", "in_progress"];

const STATUS_TAG: Record<RequestStatus, string> = {
  requested: "Requested",
  watching: "Watching",
  in_progress: "In progress",
  supported: "Supported",
  declined: "Declined",
};

const STATUS_EMOJI: Record<RequestStatus, string> = {
  requested: "🗳️",
  watching: "👀",
  in_progress: "🛠️",
  supported: "✅",
  declined: "❌",
};

const PLATFORM_LABELS: Record<string, string> = {
  steam: "Steam",
  epic: "Epic Games Store",
  gog: "GOG",
  microsoft: "Microsoft Store / Game Pass",
  xbox: "Xbox",
  playstation: "PlayStation",
  switch: "Nintendo Switch",
  battlenet: "Battle.net",
  ea: "EA app",
  ubisoft: "Ubisoft Connect",
  launcher: "Official launcher",
  ios: "iOS",
  android: "Android",
  macos: "Mac App Store",
};

// ── Website API ───────────────────────────────────────────────────────

function botHeaders() {
  const secret = process.env.STATS_BOT_SECRET;
  if (!secret) throw new Error("STATS_BOT_SECRET is not set");
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
    "user-agent": "thgl-discord-bot/game-requests",
  };
}

async function statsApi<T>(method: "GET" | "POST", body?: unknown): Promise<T> {
  const res = await fetch(`${STATS_API_URL}/discord`, {
    method,
    headers: botHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(json.error ?? `stats API responded ${res.status}`);
  }
  return json;
}

export async function fetchGames(): Promise<StatsGame[]> {
  return (await statsApi<{ games: StatsGame[] }>("GET")).games;
}

type WebComment = {
  id: string;
  gameId: string;
  authorName: string;
  body: string;
};

async function fetchUnpostedComments(): Promise<WebComment[]> {
  const res = await fetch(`${STATS_API_URL}/discord?comments=unposted`, {
    headers: botHeaders(),
  });
  if (!res.ok) throw new Error(`stats API responded ${res.status}`);
  return ((await res.json()) as { comments: WebComment[] }).comments;
}

function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

/**
 * Post in a game's thread on behalf of someone (web comment or /request
 * details). Mentions render as names but never ping.
 */
export async function postInThread(threadId: string, content: string) {
  const thread = await getClient().channels.fetch(threadId);
  if (!thread?.isThread()) throw new Error(`thread ${threadId} not found`);
  if (thread.archived) {
    await thread.setArchived(false, "Game requests: new comment");
  }
  return thread.send({
    content: clip(content, 2000),
    allowedMentions: { parse: [] },
  });
}

export type RequestResult = {
  id: string;
  title: string;
  status: RequestStatus | "pending";
  created: boolean;
  voteCount: number;
};

/** Create a request for a Steam game on behalf of a Discord user. */
export function requestGame(steamAppId: number, discordUserId: string) {
  return statsApi<RequestResult>("POST", {
    action: "request",
    steamAppId,
    discordUserId,
  });
}

export type SearchResult = {
  appId: number;
  name: string;
  tracked: { id: string; status: RequestStatus } | null;
};

/** Public Steam search, annotated with games the website already tracks. */
export async function searchGames(q: string): Promise<SearchResult[]> {
  const res = await fetch(
    `${STATS_API_URL}/search?q=${encodeURIComponent(q)}`,
    { headers: { "user-agent": "thgl-discord-bot/game-requests" } },
  );
  if (!res.ok) return [];
  return ((await res.json()) as { results?: SearchResult[] }).results ?? [];
}

// ── Thread content ────────────────────────────────────────────────────

const statsUrl = (id: string) => `${SITE_URL}/stats/${id}`;

export function parseGameId(content: string): string | null {
  const m = content.match(/th\.gl\/stats\/([a-z0-9-]+)/i);
  return m ? m[1] : null;
}

function threadName(game: StatsGame) {
  return game.title.length > MAX_THREAD_NAME_LENGTH
    ? game.title.slice(0, MAX_THREAD_NAME_LENGTH - 1).trimEnd() + "…"
    : game.title;
}

/** Starter post. The stats link doubles as the identity marker. */
function buildContent(game: StatsGame): string {
  const votes = `${game.voteCount} vote${game.voteCount === 1 ? "" : "s"}`;
  const lines = [
    `${STATUS_EMOJI[game.status]} **${STATUS_TAG[game.status]}** · ${votes}`,
  ];
  if (game.status === "supported" && game.thglId) {
    lines.push(`Maps and tools: ${SITE_URL}/apps/${game.thglId}`);
  } else if (game.status !== "declined") {
    lines.push(
      `Vote with ${VOTE_EMOJI} on this post or on ${SITE_URL}/requests`,
    );
  }
  lines.push(`Player numbers, platforms and patches: ${statsUrl(game.id)}`);
  if (game.note) lines.push("", game.note);
  return lines.join("\n");
}

function buildEmbed(game: StatsGame) {
  const embed = new EmbedBuilder()
    .setTitle(game.title.slice(0, 256))
    .setURL(statsUrl(game.id))
    .setColor(0x5865f2);
  if (game.imageUrl) embed.setImage(game.imageUrl);
  const platforms = game.platforms
    .map((p) => PLATFORM_LABELS[p.client] ?? p.client)
    .join(", ");
  if (platforms) embed.addFields({ name: "Platforms", value: platforms });
  if (game.releaseDate) {
    embed.addFields({ name: "Release", value: game.releaseDate, inline: true });
  }
  if (!game.steamAppId && game.url) {
    embed.addFields({ name: "Official page", value: game.url, inline: true });
  }
  return embed;
}

/** Posted in the thread when the status changes (notifies its followers). */
function statusMessage(game: StatsGame): string | null {
  switch (game.status) {
    case "watching":
      return `👀 I'm now watching **${game.title}** and following its player numbers and news.`;
    case "in_progress":
      return `🛠️ **${game.title}** is in progress: maps and tools are being built.`;
    case "supported":
      return (
        `✅ **${game.title}** is now supported!` +
        (game.thglId ? ` Maps and tools: ${SITE_URL}/apps/${game.thglId}` : "")
      );
    case "declined":
      return (
        `❌ **${game.title}** won't get support for now.` +
        (game.note ? ` ${game.note}` : "")
      );
    default:
      return null;
  }
}

// ── Sync ──────────────────────────────────────────────────────────────

export type GameRequestsSyncReport = {
  games: number;
  comments: number;
  created: number;
  updated: number;
  statusPosts: number;
  voteUpdates: number;
  errors: { gameId: string; error: string }[];
};

type ManagedThread = { thread: ThreadChannel; starter: Message };

async function loadManagedThreads(): Promise<Map<string, ManagedThread>> {
  const botId = getClient().user?.id;
  const threads = await getForumPosts(GAME_REQUESTS_CHANNEL.id);
  const byGame = new Map<string, ManagedThread>();
  await Promise.all(
    threads.map(async (thread) => {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (!starter || starter.author.id !== botId) return;
      const gameId = parseGameId(starter.content);
      if (gameId && !byGame.has(gameId)) byGame.set(gameId, { thread, starter });
    }),
  );
  return byGame;
}

function tagIdFor(status: RequestStatus, tags: GuildForumTag[]) {
  const name = STATUS_TAG[status].toLowerCase();
  return tags.find((t) => t.name.toLowerCase() === name)?.id ?? null;
}

async function reactorIds(starter: Message): Promise<string[]> {
  const reaction = starter.reactions.cache.find(
    (r) => r.emoji.name === VOTE_EMOJI,
  );
  if (!reaction) return [];
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const users = await reaction.users.fetch({ limit: 100, after });
    for (const user of users.values()) if (!user.bot) ids.push(user.id);
    if (users.size < 100) break;
    after = users.lastKey();
  }
  return ids;
}

async function syncOne(
  game: StatsGame,
  forum: ForumChannel,
  managed: Map<string, ManagedThread>,
  report: GameRequestsSyncReport,
) {
  const existing = managed.get(game.id);
  // Supported / declined games only keep a thread they already have.
  if (!existing && !THREAD_STATUSES.includes(game.status)) return;
  const tagId = tagIdFor(game.status, forum.availableTags);
  const appliedTags = tagId ? [tagId] : [];

  if (!existing) {
    const thread = await forum.threads.create({
      name: threadName(game),
      message: { content: buildContent(game), embeds: [buildEmbed(game)] },
      appliedTags,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `Game requests sync: create ${game.id}`,
    });
    await statsApi("POST", { action: "thread", gameId: game.id, threadId: thread.id });
    report.created++;
    return;
  }

  const { thread } = existing;
  // Fresh fetch: reaction counts on the cached starter can be stale.
  const starter = await existing.starter.fetch(true);

  // Votes first, so the starter post shows the new total.
  const voters = await reactorIds(starter);
  const { voteCount } = await statsApi<{ voteCount: number }>("POST", {
    action: "votes",
    gameId: game.id,
    discordUserIds: voters,
  });
  if (voteCount !== game.voteCount) report.voteUpdates++;
  const current = { ...game, voteCount };

  if (game.discordThreadId !== thread.id) {
    await statsApi("POST", { action: "thread", gameId: game.id, threadId: thread.id });
  }

  const statusChanged =
    tagId !== null && !(thread.appliedTags.length === 1 && thread.appliedTags[0] === tagId);
  const content = buildContent(current);
  const embed = buildEmbed(current).toJSON();
  const oldEmbed = starter.embeds[0]?.toJSON();
  // Discord echoes `inline: false` where we leave it unset; compare normalized.
  const embedKey = (e?: typeof embed) =>
    JSON.stringify({
      t: e?.title,
      i: e?.image?.url,
      f: (e?.fields ?? []).map((f) => [f.name, f.value, Boolean(f.inline)]),
    });
  const needsBody = starter.content !== content || embedKey(oldEmbed) !== embedKey(embed);
  const needsName = thread.name !== threadName(game);
  if (!needsBody && !needsName && !statusChanged) return;

  if (thread.archived) await thread.setArchived(false, "Game requests sync: update");
  if (thread.locked && game.status !== "declined") {
    await thread.setLocked(false, "Game requests sync: reopened");
  }
  if (needsBody) await starter.edit({ content, embeds: [embed] });
  if (needsName) await thread.setName(threadName(game), "Game requests sync");
  if (statusChanged) {
    await thread.setAppliedTags(appliedTags, "Game requests sync: status");
    const message = statusMessage(game);
    if (message) {
      await thread.send({ content: message, allowedMentions: { parse: [] } });
      report.statusPosts++;
    }
    if (game.status === "declined") {
      await thread.setLocked(true, "Game requests sync: declined");
      await thread.setArchived(true, "Game requests sync: declined");
    }
  }
  report.updated++;
}

/** Mirror comments written on th.gl into their game's thread. */
async function mirrorWebComments(
  games: StatsGame[],
  report: GameRequestsSyncReport,
) {
  const threadByGame = new Map(
    games
      .filter((g) => g.discordThreadId)
      .map((g) => [g.id, g.discordThreadId!] as const),
  );
  for (const comment of await fetchUnpostedComments()) {
    const threadId = threadByGame.get(comment.gameId);
    if (!threadId) continue; // thread not created yet; next run
    try {
      const message = await postInThread(
        threadId,
        `💬 **${comment.authorName}** on th.gl:\n${clip(comment.body, 1900)}`,
      );
      await statsApi("POST", {
        action: "comment-posted",
        commentId: comment.id,
        messageId: message.id,
      });
      report.comments++;
    } catch (error: any) {
      report.errors.push({
        gameId: comment.gameId,
        error: error?.message ?? String(error),
      });
    }
  }
}

async function runSync(onlyGameId?: string): Promise<GameRequestsSyncReport> {
  const [games, managed] = await Promise.all([fetchGames(), loadManagedThreads()]);
  const forum = getForumChannel(GAME_REQUESTS_CHANNEL.id) as ForumChannel;
  const report: GameRequestsSyncReport = {
    games: games.length,
    comments: 0,
    created: 0,
    updated: 0,
    statusPosts: 0,
    voteUpdates: 0,
    errors: [],
  };
  for (const game of games) {
    if (onlyGameId && game.id !== onlyGameId) continue;
    try {
      await syncOne(game, forum, managed, report);
    } catch (error: any) {
      report.errors.push({ gameId: game.id, error: error?.message ?? String(error) });
    }
  }
  if (!onlyGameId) await mirrorWebComments(games, report);
  return report;
}

// ── Run management ───────────────────────────────────────────────────
// Runs are serialized (a full run and a /request-triggered single-game run
// must never both create a thread for the same game).

let queue: Promise<unknown> = Promise.resolve();
let running = false;
let lastStartedAt: number | null = null;
let lastFinishedAt: number | null = null;
let lastReport: GameRequestsSyncReport | null = null;
let lastError: string | null = null;

export function getGameRequestsSyncStatus() {
  return { running, lastStartedAt, lastFinishedAt, lastError, lastReport };
}

export function syncGameRequests(onlyGameId?: string): Promise<GameRequestsSyncReport> {
  const run = queue.then(async () => {
    running = true;
    lastStartedAt = Date.now();
    try {
      const report = await runSync(onlyGameId);
      if (!onlyGameId) lastReport = report;
      lastError = null;
      console.log(
        `[game-requests] ${onlyGameId ?? "all"}: ${report.created} created, ` +
          `${report.comments} web comments, ` +
          `${report.updated} updated, ${report.statusPosts} status posts, ` +
          `${report.voteUpdates} vote changes, ${report.errors.length} errors`,
      );
      for (const e of report.errors) {
        console.error(`[game-requests] ${e.gameId}: ${e.error}`);
      }
      return report;
    } catch (error: any) {
      lastError = error?.message ?? String(error);
      console.error("[game-requests] run failed:", lastError);
      throw error;
    } finally {
      running = false;
      lastFinishedAt = Date.now();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
