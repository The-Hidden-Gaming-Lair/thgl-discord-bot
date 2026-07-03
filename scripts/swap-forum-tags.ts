import { existsSync } from "node:fs";
import { initDiscord, getChannel, getForumPosts } from "../lib/discord";
import { SUGGESTIONS_ISSUES_CHANNEL } from "../lib/channels";

/**
 * PHASE 3 CUTOVER STEP 1 — atomic forum tag swap for #suggestions-issues.
 *
 * Replaces the 20 per-game tags with: Coding (kept, exact same tag id),
 * Bug, Suggestion, Question. ONE setAvailableTags call — nothing else.
 *
 * SAFETY: this cannot delete a thread or message. Threads RETAIN their now-
 * stale tag ids (verified: 149 stale tag references from previously deleted
 * tags exist in production). Game association is preserved in the committed
 * snapshot (data/suggestions-snapshot.json) and served by the API from it.
 * Refuses to run if the snapshot is missing or stale vs the live count.
 *
 * Dry-run by default. Mutate with: --apply --force
 */

await initDiscord();

if (!existsSync(new URL("../data/suggestions-snapshot.json", import.meta.url))) {
  console.error("REFUSING: data/suggestions-snapshot.json missing. Run snapshot-suggestions.ts first.");
  process.exit(1);
}
const snapshot = await Bun.file(
  new URL("../data/suggestions-snapshot.json", import.meta.url).pathname.slice(1),
).json();

const forum = getChannel(SUGGESTIONS_ISSUES_CHANNEL.id) as any;
const current = forum.availableTags ?? [];

// Pre-flight: live thread count must not exceed the snapshot (new posts since
// the snapshot mean the snapshot is stale — re-run it first).
const liveThreads = await getForumPosts(SUGGESTIONS_ISSUES_CHANNEL.id);
console.log(`live threads: ${liveThreads.length}, snapshot: ${snapshot.threadCount} (${snapshot.takenAt})`);
if (liveThreads.length !== snapshot.threadCount) {
  console.error(
    "REFUSING: live thread count differs from snapshot — re-run snapshot-suggestions.ts " +
      "and commit it before swapping tags.",
  );
  process.exit(1);
}

const coding = current.find((t: any) => t.name === "Coding");
if (!coding) {
  console.error("REFUSING: existing 'Coding' tag not found in availableTags.");
  process.exit(1);
}

const target = [
  // keep Coding with its exact id/emoji/moderated so existing Coding threads are unaffected
  { id: coding.id, name: coding.name, moderated: coding.moderated, emoji: coding.emoji },
  { name: "Bug", moderated: false, emoji: { id: null, name: "🐛" } },
  { name: "Suggestion", moderated: false, emoji: { id: null, name: "💡" } },
  { name: "Question", moderated: false, emoji: { id: null, name: "❓" } },
];

console.log("\n=== CURRENT tags ===");
for (const t of current) console.log(`  - ${t.name} (${t.id})`);
console.log("\n=== TARGET tags ===");
for (const t of target) console.log(`  - ${t.name}${"id" in t && t.id ? ` (kept id ${t.id})` : " (new)"}`);
console.log(
  `\nRemoving ${current.length - 1} game tags (threads keep the stale ids; ` +
    "game association lives in the committed snapshot + API).",
);

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
if (!apply || !force) {
  console.log("\nDRY RUN — re-run with --apply --force to swap the tags.");
  process.exit(0);
}

await forum.setAvailableTags(target);
const after = (getChannel(SUGGESTIONS_ISSUES_CHANNEL.id) as any).availableTags;
console.log(`\nAPPLIED. availableTags now (${after.length}/20):`);
for (const t of after) console.log(`  - ${t.name} (${t.id})`);

// Verify stale-id retention on a sample of threads that had game tags.
const gameTagIds = new Set(current.filter((t: any) => t.name !== "Coding").map((t: any) => t.id));
const sample = (liveThreads as any[])
  .filter((th) => (th.appliedTags ?? []).some((id: string) => gameTagIds.has(id)))
  .slice(0, 10);
let retained = 0;
for (const th of sample) {
  const fresh = await forum.threads.fetch(th.id);
  if ((fresh?.appliedTags ?? []).some((id: string) => gameTagIds.has(id))) retained++;
}
console.log(`stale-id retention check: ${retained}/${sample.length} sampled threads still carry their old game tag id`);
console.log(`thread count after swap: ${(await getForumPosts(SUGGESTIONS_ISSUES_CHANNEL.id)).length} (must equal ${snapshot.threadCount})`);
process.exit(0);
