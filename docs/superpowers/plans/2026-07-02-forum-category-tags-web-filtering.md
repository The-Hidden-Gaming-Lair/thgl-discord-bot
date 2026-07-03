# Forum Category Tags + Web Game Filtering (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. **Every Discord-mutating task is gated on explicit owner sign-off and MUST obey the safety invariants below.**

**Goal:** Replace the maxed-out per-game tags (20/20) in the `suggestions-issues` forum with category tags (Bug / Suggestion / Question, keeping Coding), move per-game filtering to th.gl, and full-backfill all existing threads — **without losing a single post**.

**Architecture:** The bot snapshots the entire forum (full backup, committed to git) and derives each post's game(s) from its applied tags (live or stale) + canonical-title keyword detection, exposing `games` + `category` on `/api/suggestions-issues`. The web page filters on those fields instead of raw Discord tags. Only then is the Discord tag set swapped (one atomic `setAvailableTags` call) and threads backfilled with category tags (throttled, resumable, archive/lock state restored).

**Tech Stack:** Bun + discord.js (bot), Next.js App Router + `@repo/lib` (games-web). No test framework in the bot repo — validation = dry-run scripts against live Discord + `curl` (established pattern).

---

## ⛔ SAFETY INVARIANTS (owner directive: "REALLY make sure we are not losing any suggestion or issue post")

1. **No delete calls, ever.** No script in this plan may contain `.delete(`, thread deletion, or message deletion. The only Discord mutations are: `setAvailableTags` (forum), `setAppliedTags` / `setArchived` / edit guidelines (channel/thread metadata). None of these can remove a thread or message.
2. **Snapshot before any mutation.** Task 1 exports every thread — id, title, author, timestamps, applied tag ids (incl. stale), archived/locked state, starter-message content, reaction counts — to a JSON committed to the repo. This is a true backup: even a catastrophic surprise is recoverable from it.
3. **Invariant check after every mutating step:** total thread count and the full thread-id set must equal the snapshot baseline (plus any posts created since, minus none). A missing id aborts everything immediately.
4. **Dry-run by default.** Every mutating script requires `--apply --force` (same double-flag convention as `reconcile-games.ts`) and prints its full intended change set in dry-run.
5. **Idempotent + resumable backfill.** Re-running skips threads already carrying a category tag; a crash mid-run loses nothing and resumes cleanly.
6. **Archived/locked state restored exactly.** Editing an archived thread requires unarchive → edit → re-archive; the script restores `archived` and `locked` flags to their snapshot values and never touches `autoArchiveDuration` semantics beyond that.
7. **Owner sign-off gates** before Task 5 (tag swap), Task 6 (backfill), Task 7 (guidelines copy).

## Grounded facts (verified live, 2026-07-02)

- Forum `#❕・suggestions-issues` = `1021543411293106217` (`SUGGESTIONS_ISSUES_CHANNEL` in `lib/channels.ts`). `RequireTag` flag ON. 20/20 tags: 19 game tags + `Coding` (`1021961374231965787`).
- **854 threads** (15 active, 839 archived), 0 untagged, 47 multi-tag. Tag usage: Once Human 156, Palia Map 122, WuWa 102, Diablo 4 74, Coding 72, … plus **145 thread-tag references to 8 already-deleted tag ids** (`1021958341146202204` ×102 etc.) — proof that **threads retain stale tag ids after a tag is deleted from `availableTags`**; historical association survives deletion.
- Bot permissions: Manage Threads ✅, Manage Channels ✅ (tag edits), Manage Guild ✅.
- Web already ships the UI: `apps/games-web/src/app/www/suggestions-issues/page.tsx` (server fetch via `getSuggestionsAndIssues` in `packages/lib/src/discord.ts:237`, revalidate 60) + client tag-chip/text filtering in `[id]/suggestions-issues.tsx` (lines ~96–136). It filters on **live Discord tags** → will degrade at cutover unless the API exposes game association first. Games array (`@repo/lib`, with `discordId`+`title`) is importable in both server and client www code.
- Bot API code: `routes/suggestions-issues/route.ts` (list + detail), forum access via `getForumPosts` in `lib/discord.ts`.
- Owner decisions: tag set = **Bug / Suggestion / Question + keep Coding**; **full backfill** (all 854); **update post guidelines** (show wording first). Classification heuristic below; stored per-thread in the snapshot for review before apply.

## Classification heuristic (deterministic, reviewable)

Applied to title + first 500 chars of starter message, first match wins:
1. **Bug** — `/\b(bug|error|crash|crashe?s|broken|not working|doesn'?t work|won'?t (load|start|work)|can'?t|cannot|fails?|failed|wrong|glitch|freez|stuck|missing)\b/i`
2. **Question** — title ends in `?`, or starts with `/^(how|why|what|where|when|which|is |are |can |could |does |do |should )/i`
3. **Suggestion** — everything else (default; it's the forum's primary purpose).
Threads tagged `Coding` keep `Coding` **in addition to** their category. Multi-game tags → all games recorded. The dry-run prints the distribution + 20 random samples per category for owner spot-check.

---

## Task 1 — Full forum snapshot (backup + game/category derivation source)

**Files:** Create `scripts/snapshot-suggestions.ts` (kept — operator tool), output `data/suggestions-snapshot.json` (committed).

- [ ] Script: fetch ALL threads via `getForumPosts(SUGGESTIONS_ISSUES_CHANNEL.id)` (active + archived, no limit); for each: `{ id, title, authorId, authorTag, createdTimestamp, appliedTags, archived, locked, messageCount, starterContent (full), starterAttachmentUrls, reactions }`. Also embed the current `availableTags` (id → name → emoji) and the stale-id set. Read-only.
- [ ] Derive per thread: `games: string[]` (applied tag name → canonical `discordId` via a `TAG_TO_GAME` map written into the script; stale/unknown ids → keyword detection on title+content against canonical titles + `titleKeywords`), `category` + `categoryReason` per the heuristic.
- [ ] Run; verify count == 854 (or current), 0 threads skipped; print distribution (games, categories, undetectable count).
- [ ] Commit snapshot + script (this is the backup — must land in git before anything mutates).

## Task 2 — Bot: expose `games` + `category` on the API

**Files:** Create `lib/suggestions-meta.ts`; modify `routes/suggestions-issues/route.ts`.

- [ ] `lib/suggestions-meta.ts`: loads `data/suggestions-snapshot.json` once (id → {games, category}); exports `getPostMeta(thread)` = snapshot hit ?? live derivation (live category tag if present → category; game tags/keyword detection → games). Keyword detection reuses canonical titles from `getCanonicalGames()` + `titleKeywords` from `game-roles.ts`.
- [ ] Wire into both list and detail responses: add `games: string[]` (canonical discordIds) and `category: "bug"|"suggestion"|"question"|null` (+ keep existing raw `tags` untouched — backward compatible, nothing removed from the payload).
- [ ] Verify locally (`bun run` a check against live forum), then commit. Deploy (standard flow) and `curl` the live endpoint: every post carries `games`/`category`; existing fields unchanged.

## Task 3 — Web: game filter + category chips (SAFE, ships before any Discord change)

**Files (games-web repo):** modify `packages/lib/src/discord.ts` (add `games`/`category` to `ForumPost` types), `apps/games-web/src/app/www/suggestions-issues/[id]/suggestions-issues.tsx` (game dropdown from `@repo/lib` `games` + category chips using the new fields; keep text search), optionally `packages/ui/.../home-page.tsx` per-game section later.

- [ ] Implement + typecheck (`bun run typecheck` in games-web).
- [ ] Owner pushes/deploys frontend. Verify on www.th.gl/suggestions-issues: game filter works for old posts (tag-derived) — **while game tags still exist**, so behavior is provably equivalent before cutover.

## Task 4 — ✅ CHECKPOINT: filtering fully independent of Discord game tags

- [ ] Confirm with owner on the live site. Only proceed past this line with explicit go-ahead.

## Task 5 — Atomic tag swap (SIGN-OFF GATE — mutating, reversible*)

**Files:** Create `scripts/swap-forum-tags.ts` (dry-run default).

- [ ] One call: `forum.setAvailableTags([Coding (exact existing id/emoji preserved), {name:"Bug", emoji:🐛}, {name:"Suggestion", emoji:💡}, {name:"Question", emoji:❓}])`. Dry-run prints before/after tag lists.
- [ ] Pre-flight: re-run snapshot script to a second file (delta since Task 1); invariant check.
- [ ] Apply. Verify: `availableTags` = 4/20; sample 10 threads still show their (now stale) game tag ids in `appliedTags`; thread count + id set unchanged. (*Reversible: game tags could be re-created and re-applied from the snapshot if ever needed.)

## Task 6 — Full backfill (SIGN-OFF GATE — mutating, throttled, resumable)

**Files:** Create `scripts/backfill-categories.ts` (dry-run default; kept).

- [ ] Dry-run: for all threads compute target `appliedTags` = `[categoryTagId, +CodingId if snapshot had Coding]`; print distribution + samples; **abort if any thread would end up with zero tags**.
- [ ] Apply loop (~350ms delay/thread, progress every 25): skip if already category-tagged (idempotent); if archived: `setArchived(false)` → `setAppliedTags` → restore `archived`/`locked` from snapshot. Errors: log + continue; final report lists failures for retry.
- [ ] **Invariant check** (dedicated verify mode): thread count + id set vs snapshot(s); every thread has ≥1 tag; archived/locked states match snapshot; spot-check 20 random starter messages' content against snapshot (proof no content changed).
- [ ] Re-run until failure list is empty.

## Task 7 — Post guidelines update (SIGN-OFF GATE — outward-facing copy)

- [ ] Draft the added line (ask users to name the game in the title), show owner, apply via `forum.setTopic(...)` only after approval. Verify rendered guidelines in Discord.

## Task 8 — Wrap-up

- [ ] Final full verification (counts, ids, API, web filters incl. category chips now backed by live tags).
- [ ] Update this plan's status section + the bot README env/API docs (`games`/`category` fields). Commit (with owner permission), deploy bot if any bot-code changes remain undeployed.

## Self-review notes

- Post-loss risk audited per step: Tasks 1–4 read-only; Task 5 edits one forum-level array (thread-retention of stale ids **verified in production data**, 145 existing examples); Task 6 edits per-thread tag arrays + archived flag only — no code path can delete content, and the committed snapshot is a full-content backup regardless.
- The 47 multi-game threads keep all their games via the snapshot (`games` is an array).
- New-post flow after cutover: poster picks a category (RequireTag forces it); game comes from keyword detection (+ guidelines nudge). Undetectable posts show as "General" on the web — accepted.
- FAQ forum explicitly out of scope (10/20 topical tags, no cap pressure).
