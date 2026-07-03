import { writeFileSync, mkdirSync } from "node:fs";
import { initDiscord, getChannel, getForumPosts } from "../lib/discord";
import { SUGGESTIONS_ISSUES_CHANNEL } from "../lib/channels";
import { TAG_TO_GAME, classifyCategory, detectGames } from "../lib/suggestions-meta";

/**
 * Full read-only snapshot of the suggestions-issues forum: every thread with
 * its applied tag ids (including stale ids of already-deleted tags), archived/
 * locked state, and full starter-message content. This is the BACKUP and the
 * source of truth for game/category association before the tag cutover —
 * nothing in the migration may run before this file is committed.
 *
 * Tag->game mapping and the category heuristic live in lib/suggestions-meta.ts
 * (shared with the API) so the snapshot and live derivation can't drift.
 *
 * Usage: bun run scripts/snapshot-suggestions.ts [outfile]
 */

await initDiscord();
const forum = getChannel(SUGGESTIONS_ISSUES_CHANNEL.id) as any;
const availableTags = (forum.availableTags ?? []).map((t: any) => ({
  id: t.id,
  name: t.name,
  moderated: t.moderated,
  emojiId: t.emoji?.id ?? null,
  emojiName: t.emoji?.name ?? null,
}));
const tagNameById = new Map<string, string>(availableTags.map((t: any) => [t.id, t.name]));
const codingTagId = availableTags.find((t: any) => t.name === "Coding")?.id ?? null;

console.log(`Fetching all threads from #${forum.name}...`);
const threads = (await getForumPosts(SUGGESTIONS_ISSUES_CHANNEL.id)) as any[];
console.log(`Found ${threads.length} threads; fetching starter messages...`);

const entries: any[] = [];
let missingStarter = 0;
let staleTagRefs = 0;
let processed = 0;

for (const thread of threads) {
  let starter: any = null;
  try {
    starter = await thread.fetchStarterMessage();
  } catch {
    missingStarter++;
  }
  const content: string = starter?.content ?? "";
  const appliedTags: string[] = thread.appliedTags ?? [];

  const games = new Set<string>();
  let hasStale = false;
  for (const tagId of appliedTags) {
    const name = tagNameById.get(tagId);
    if (!name) {
      hasStale = true;
      staleTagRefs++;
      continue;
    }
    const game = TAG_TO_GAME[name];
    if (game) games.add(game);
  }
  // Threads with only stale/unknown tags (or none mapping to a game): keyword fallback.
  if (games.size === 0) {
    for (const g of detectGames(thread.name ?? "", content)) games.add(g);
  }

  const { category, reason } = classifyCategory(thread.name ?? "", content);

  entries.push({
    id: thread.id,
    title: thread.name,
    authorId: thread.ownerId ?? null,
    createdTimestamp: thread.createdTimestamp ?? null,
    archived: !!thread.archived,
    locked: !!thread.locked,
    messageCount: thread.messageCount ?? null,
    appliedTags,
    appliedTagNames: appliedTags.map((id: string) => tagNameById.get(id) ?? `stale:${id}`),
    hasStaleTags: hasStale,
    coding: codingTagId ? appliedTags.includes(codingTagId) : false,
    games: [...games],
    category,
    categoryReason: reason,
    starterContent: content,
    starterAttachments: starter
      ? [...starter.attachments.values()].map((a: any) => a.url)
      : [],
    starterReactions: starter
      ? [...starter.reactions.cache.values()].map((r: any) => ({
          emoji: r.emoji.name,
          count: r.count,
        }))
      : [],
    starterMissing: !starter,
  });

  processed++;
  if (processed % 50 === 0) console.log(`  ...${processed}/${threads.length}`);
}

const snapshot = {
  takenAt: new Date().toISOString(),
  forumId: SUGGESTIONS_ISSUES_CHANNEL.id,
  threadCount: entries.length,
  availableTags,
  threads: entries,
};

const outfile = process.argv[2] ?? "data/suggestions-snapshot.json";
mkdirSync("data", { recursive: true });
writeFileSync(outfile, JSON.stringify(snapshot, null, 1));

// Summary
const catDist = new Map<string, number>();
const gameDist = new Map<string, number>();
let noGame = 0;
for (const e of entries) {
  catDist.set(e.category, (catDist.get(e.category) ?? 0) + 1);
  if (e.games.length === 0) noGame++;
  for (const g of e.games) gameDist.set(g, (gameDist.get(g) ?? 0) + 1);
}
console.log(`\nWrote ${outfile}: ${entries.length} threads`);
console.log(`starter message missing (deleted): ${missingStarter}`);
console.log(`stale tag references: ${staleTagRefs}`);
console.log(`no game association: ${noGame}`);
console.log("categories:", Object.fromEntries(catDist));
console.log("games:", Object.fromEntries([...gameDist.entries()].sort((a, b) => b[1] - a[1])));
process.exit(0);
