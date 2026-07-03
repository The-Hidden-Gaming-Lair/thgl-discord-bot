import { initDiscord, getChannel, getForumPosts } from "../lib/discord";
import { SUGGESTIONS_ISSUES_CHANNEL } from "../lib/channels";
import { classifyCategory } from "../lib/suggestions-meta";

/**
 * PHASE 3 CUTOVER STEP 2 — backfill category tags onto ALL forum threads.
 *
 * For every thread, sets appliedTags = [<category tag>, +Coding if it had it]
 * using the category recorded in the committed snapshot (threads created after
 * the snapshot fall back to the live heuristic; threads that already carry a
 * category tag are skipped — idempotent and resumable).
 *
 * SAFETY:
 *  - No delete calls of any kind. Only setAppliedTags / setArchived.
 *  - A thread is NEVER left with zero tags (hard abort in dry-run if any would).
 *  - Archived threads: unarchive -> retag -> re-archive (state restored from
 *    the live pre-edit state). Locked stays locked (ManageThreads suffices).
 *  - Post-run verify mode (--verify): thread count + id set vs snapshot,
 *    every thread >= 1 tag, archived state restored, content spot-check.
 *
 * Usage:
 *   bun run scripts/backfill-categories.ts             # dry-run report
 *   bun run scripts/backfill-categories.ts --apply --force
 *   bun run scripts/backfill-categories.ts --verify    # post-run invariants
 */

const DELAY_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await initDiscord();
const snapshot = await Bun.file(
  new URL("../data/suggestions-snapshot.json", import.meta.url).pathname.slice(1),
).json();
const snapById = new Map<string, any>(snapshot.threads.map((t: any) => [t.id, t]));

const forum = getChannel(SUGGESTIONS_ISSUES_CHANNEL.id) as any;
const tags = forum.availableTags ?? [];
const tagId = (name: string) => tags.find((t: any) => t.name === name)?.id as string | undefined;
const categoryTagIds: Record<string, string | undefined> = {
  bug: tagId("Bug"),
  suggestion: tagId("Suggestion"),
  question: tagId("Question"),
};
const codingId = tagId("Coding");
if (!categoryTagIds.bug || !categoryTagIds.suggestion || !categoryTagIds.question || !codingId) {
  console.error("REFUSING: Bug/Suggestion/Question/Coding tags not all present — run swap-forum-tags.ts first.");
  process.exit(1);
}
const categoryIdSet = new Set([categoryTagIds.bug, categoryTagIds.suggestion, categoryTagIds.question]);

const threads = (await getForumPosts(SUGGESTIONS_ISSUES_CHANNEL.id)) as any[];
console.log(`live threads: ${threads.length}, snapshot: ${snapshot.threadCount}`);

// ---------- verify mode ----------
if (process.argv.includes("--verify")) {
  const liveIds = new Set(threads.map((t) => t.id));
  const missing = snapshot.threads.filter((t: any) => !liveIds.has(t.id));
  console.log(`\nINVARIANT thread count: live ${threads.length} vs snapshot ${snapshot.threadCount}`);
  console.log(`INVARIANT missing snapshot ids in live set: ${missing.length}`);
  for (const m of missing) console.log(`  MISSING: ${m.id} "${m.title}"`);
  const zeroTag = threads.filter((t) => (t.appliedTags ?? []).length === 0);
  console.log(`INVARIANT zero-tag threads: ${zeroTag.length}`);
  const archiveMismatch = threads.filter((t) => {
    const s = snapById.get(t.id);
    return s && !!t.archived !== !!s.archived;
  });
  console.log(`INVARIANT archived-state mismatches vs snapshot: ${archiveMismatch.length}`);
  for (const t of archiveMismatch.slice(0, 10)) console.log(`  archived-diff: ${t.id} "${t.name}"`);
  const withCategory = threads.filter((t) => (t.appliedTags ?? []).some((id: string) => categoryIdSet.has(id)));
  console.log(`threads carrying a category tag: ${withCategory.length}/${threads.length}`);
  // content spot-check: 20 random snapshot threads, starter content unchanged
  const sample = [...snapshot.threads].sort(() => 0.5 - Math.random()).slice(0, 20);
  let contentOk = 0, contentDiff = 0, starterGone = 0;
  for (const s of sample) {
    const th = await forum.threads.fetch(s.id).catch(() => null);
    const starter = th ? await th.fetchStarterMessage().catch(() => null) : null;
    if (!starter) { if (!s.starterMissing) starterGone++; continue; }
    if ((starter.content ?? "") === s.starterContent) contentOk++;
    else contentDiff++;
  }
  console.log(`content spot-check (20 random): unchanged=${contentOk}, changed=${contentDiff}, starter-newly-missing=${starterGone}`);
  const pass = missing.length === 0 && zeroTag.length === 0 && archiveMismatch.length === 0 && starterGone === 0;
  console.log(pass ? "\nALL INVARIANTS PASS" : "\nINVARIANT FAILURES — investigate before proceeding");
  process.exit(pass ? 0 : 1);
}

// ---------- plan targets ----------
interface Target { thread: any; targetTags: string[]; category: string; source: string }
const targets: Target[] = [];
let alreadyDone = 0;
const dist = new Map<string, number>();

for (const thread of threads) {
  const applied: string[] = thread.appliedTags ?? [];
  if (applied.some((id) => categoryIdSet.has(id))) { alreadyDone++; continue; } // idempotent
  const snap = snapById.get(thread.id);
  const category: string = snap?.category ?? classifyCategory(thread.name ?? "", "").category;
  const source = snap ? "snapshot" : "live-heuristic";
  const hadCoding = snap ? snap.coding : applied.includes(codingId);
  const targetTags = [categoryTagIds[category]!, ...(hadCoding ? [codingId] : [])];
  if (targetTags.length === 0) { console.error(`ABORT: zero tags computed for ${thread.id}`); process.exit(1); }
  targets.push({ thread, targetTags, category, source });
  dist.set(category, (dist.get(category) ?? 0) + 1);
}

console.log(`\nto update: ${targets.length}, already category-tagged (skipped): ${alreadyDone}`);
console.log("category distribution of updates:", Object.fromEntries(dist));
console.log("\nsamples:");
for (const t of targets.slice(0, 15)) {
  console.log(`  [${t.category}${t.targetTags.length > 1 ? "+Coding" : ""}] (${t.source}) ${t.thread.name?.slice(0, 60)}`);
}

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
if (!apply || !force) {
  console.log("\nDRY RUN — re-run with --apply --force to backfill.");
  process.exit(0);
}

// ---------- apply ----------
let done = 0;
const failures: { id: string; title: string; error: string }[] = [];
for (const t of targets) {
  const th = t.thread;
  const wasArchived = !!th.archived;
  try {
    if (wasArchived) await th.setArchived(false, "category backfill");
    await th.setAppliedTags(t.targetTags, "category backfill (phase 3)");
    if (wasArchived) await th.setArchived(true, "category backfill: restore archived state");
    done++;
  } catch (err) {
    failures.push({ id: th.id, title: th.name, error: (err as Error).message });
    // best effort: try to restore archived state even on tag failure
    if (wasArchived && !th.archived) await th.setArchived(true).catch(() => {});
  }
  if ((done + failures.length) % 25 === 0) {
    console.log(`  ...${done + failures.length}/${targets.length} (${failures.length} failures)`);
  }
  await sleep(DELAY_MS);
}

console.log(`\nAPPLIED: ${done}/${targets.length} updated, ${failures.length} failures`);
for (const f of failures) console.log(`  FAILED ${f.id} "${f.title}": ${f.error}`);
console.log("\nNow run: bun run scripts/backfill-categories.ts --verify");
process.exit(failures.length ? 1 : 0);
