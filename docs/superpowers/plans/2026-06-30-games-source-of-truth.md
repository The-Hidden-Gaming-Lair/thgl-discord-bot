# Games Source-of-Truth + Auto-Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Implementation status — 2026-07-02: LIVE, apply enabled in production

**Phases 1–2 are fully shipped and running.** The feed (`https://www.th.gl/api/games`)
is live; the bot (`main`, through commit `81a8c3f`) reconciles against it every
30 min **in apply mode** on the production server. A new game added to th.gl is
provisioned automatically within one scheduler tick: role, discussion channel
(alphabetically placed), guild emoji (matched by name or uploaded from the
feed's `logo` URL — Discord accepts the webp directly), and a sorted onboarding
option with the emoji attached. Everything is additive-only with never-remove
guards (aborts any write that would drop an option/emoji; failed onboarding PUT
degrades gracefully via `onboardingError`).

**Resolved along the way (beyond the original plan):**
- Legacy channel names ≠ `discordId` → owner chose an **alias map**
  (`CHANNEL_ALIASES` in `lib/games-provision.ts`) over renaming live channels.
- Duplicate-role false positive (canonical title vs role name, e.g. HoMM) →
  role check also accepts a hardcoded roleId resolving to a live role.
- **Onboarding emoji loss incident:** Discord's GET returns nested `emoji`
  objects but the full-replace PUT reads only flat `emoji_id`/`emoji_name` —
  the first apply cleared all option emojis. Fixed (flat mapping + emoji-count
  guard), all 34 restored, and options now self-heal missing emojis.
- Apply hardening: `?apply=true` returns 403 unless `GAMES_SYNC_SECRET` is set
  (secret lives in the server's `docker-compose.yml`, backup at
  `~/docker-compose.yml.bak-games-sync`); operator script goes through the
  concurrency guard; scheduler runs apply via `GAMES_SYNC_APPLY=true`.
- Bot permissions granted: Manage Roles, Manage Channels, Manage Server
  (= `MANAGE_GUILD`; needed for onboarding), Create Expressions (emoji upload).

**Known accepted caveat:** HTTP apply still runs synchronously in the request
(the FAQ-style background-task refactor was skipped). With the server fully
reconciled, an incremental apply is a handful of REST calls — well inside
`Bun.serve`'s 20s idleTimeout. Revisit only if a mass backfill is ever needed.

**STILL TODO (intentionally deferred):**
- Phase 3 (forum tags → categories + web filtering) — irreversible, needs per-step sign-off.

**Goal:** Make the th.gl canonical games list the single source of truth for the Discord bot, so new games are provisioned (role + discussion channel) and matched automatically instead of by hand-editing two files and creating Discord objects manually.

**Architecture:** Mirror the existing FAQ web→Discord pattern. games-web exposes `GET /api/games` (1:1 with the existing `/api/faq` route). The bot fetches it, caches it, resolves each game's Discord role by title and discussion channel by `#<discordId>` at runtime, and reconciles missing objects (additive by default; deletes gated off, exactly like `syncFaq`). The hardcoded `channels.ts` / `game-roles.ts` lists degrade to a fallback cache.

**Tech Stack:** Bun + TypeScript + discord.js (bot); Next.js App Router + `@repo/lib` (games-web). No test framework exists in the bot repo — validation is done the way the rest of the repo is validated: a `scripts/*.ts` utility run against live Discord in **dry-run** mode, plus live `curl` against the deployed endpoint. Steps reflect that, not unit tests.

**Join key:** `discordId` (slug, e.g. `aeternum-map`, `subnautica-2`). Role name == game `title`. Discussion channel name == `discordId`, parented to the **"Apps & Games"** category. Onboarding option title == `title`, assigning the game role and linking the discussion channel.

**Per-game footprint = THREE Discord objects:** (1) a role named by `title`, (2) a text channel `#<discordId>` under "Apps & Games", (3) an **onboarding option** in the single prompt *"Join the respective Game/App chats by selecting the roles."* (`1100586372844228610`) that assigns the role + links the channel. All three must be provisioned together; #3 was the surface the owner flagged as easy to forget.

**Permission prerequisite (Phase 2 apply mode only):** the bot's Discord application needs **Manage Roles + Manage Channels + Manage Guild** (the last specifically to edit onboarding), and its integration role must sit **above** the game roles in the hierarchy. Until granted, Phase 2 runs in dry-run and only *reports* what it would create — no grant needed to build or verify.

---

## Grounded facts (verified this session)

- Canonical list: `C:\dev\the-hidden-gaming-lair\packages\lib\src\games.ts` → `export const games` (30 games), re-exported from `@repo/lib` root.
- `Game` fields the bot needs: `id`, `discordId`, `title`, `web`, `logo`. (Numeric Discord role/channel IDs are NOT on the web side — the bot resolves them.)
- API precedent to copy verbatim: `apps/games-web/src/app/www/api/faq/route.ts` (served at `https://www.th.gl/api/faq`).
- Per-game Discord footprint today: 1 role (by title) + 1 text channel `#<discordId>` under category **"Apps & Games"** (resolved at runtime by name) + 1 onboarding option. All per-game `#updates-*` channels are in the **Deprecated** category; updates now flow through central `#app-updates` (`1166078913756270702`).
- Onboarding: a single prompt `1100586372844228610` (`single_select: false`, `required: true`, type 1) with 32 game options; each option = `{ title, role_ids: [roleId], channel_ids: [channelId] }`. Edited via `PUT /guilds/{id}/onboarding` (discord.js `guild.editOnboarding()`), which **replaces the whole config** — must read-merge-write, never overwrite blind. Soft cap ~50 options/prompt (currently 32) — the next scaling ceiling after the 20 forum-tag cap.
- Slug drift to fix (decision C): bot uses `subnautica2`; canonical `discordId` is `subnautica-2`. Realign bot → `discordId`.

---

## Phase 1 — `GET /api/games` on th.gl (games-web repo)

**Files:**
- Create: `C:\dev\the-hidden-gaming-lair\apps\games-web\src\app\www\api\games\route.ts`

Mirrors the FAQ route. Returns a **slim projection** (only the fields external consumers need) so the bot never couples to internal `@repo/lib` config fields.

- [ ] **Step 1: Create the route handler**

```ts
/**
 * Canonical games feed. `packages/lib/src/games.ts` (`@repo/lib` `games`) is
 * the single source of truth for which games THGL supports; this endpoint
 * exposes a slim projection as JSON so external consumers (the THGL Discord
 * bot's games sync) can provision/match without importing the web codebase.
 * Served at https://www.th.gl/api/games.
 */
import { games } from "@repo/lib";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "public, max-age=300, s-maxage=3600",
};

export function GET() {
  const entries = games.map((g) => ({
    id: g.id,
    discordId: g.discordId,
    title: g.title,
    web: g.web ?? null,
    logo: g.logo,
  }));
  return Response.json(
    { baseUrl: "https://www.th.gl", count: entries.length, games: entries },
    { headers },
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
```

- [ ] **Step 2: Typecheck the games-web app**

Run (from `C:\dev\the-hidden-gaming-lair`): the repo's typecheck for games-web (e.g. `pnpm --filter games-web typecheck` or `turbo run typecheck --filter=games-web` — match whatever the repo uses).
Expected: passes, no errors referencing `route.ts`.

- [ ] **Step 3: Verify locally if a dev server is available**

Run the games-web dev server, then `curl http://localhost:<port>/api/games`.
Expected: JSON `{ baseUrl, count: 30, games: [{ id, discordId, title, web, logo }, ...] }`.

- [ ] **Step 4: Commit (games-web repo)**

```bash
git add apps/games-web/src/app/www/api/games/route.ts
git commit -m "Add /api/games canonical feed for the Discord bot games sync"
```

> Deploy of games-web is via its normal pipeline (owner-driven). The bot phases below default `GAMES_API_URL` to `https://www.th.gl/api/games`; until it's live, the bot's feed falls back to the bundled list (Phase 2, Task 2).

---

## Phase 2 — Bot games feed, runtime resolution, and provisioning

### Task 1: Canonical games feed with cache + bundled fallback

**Files:**
- Create: `C:\dev\thgl-discord-bot\lib\games-feed.ts`
- Reference pattern: `C:\dev\thgl-discord-bot\lib\app-updates-cache.ts` (TTL cache), `C:\dev\thgl-discord-bot\lib\faq.ts` (web fetch).

- [ ] **Step 1: Define the feed type and fetch-with-cache**

```ts
import { GAME_CONFIGS } from "./game-roles";

export interface CanonicalGame {
  id: string;
  discordId: string;
  title: string;
  web: string | null;
  logo?: string;
}

const GAMES_API_URL = process.env.GAMES_API_URL ?? "https://www.th.gl/api/games";
const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; games: CanonicalGame[] } | null = null;

/** Fallback derived from the bundled lists so the bot still works offline. */
function bundledGames(): CanonicalGame[] {
  return GAME_CONFIGS.map((c) => ({
    id: c.name,
    discordId: c.name,
    title: c.titleKeywords?.[0] ?? c.name,
    web: null,
  }));
}

export async function getCanonicalGames(force = false): Promise<CanonicalGame[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return cache.games;
  }
  try {
    const res = await fetch(GAMES_API_URL, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`games feed ${res.status}`);
    const body = (await res.json()) as { games: CanonicalGame[] };
    if (!Array.isArray(body.games) || body.games.length === 0) {
      throw new Error("games feed empty");
    }
    cache = { at: Date.now(), games: body.games };
    return cache.games;
  } catch (err) {
    console.warn(`[games-feed] falling back to bundled list: ${(err as Error).message}`);
    return cache?.games ?? bundledGames();
  }
}
```

- [ ] **Step 2: Verify the feed loads (dry, read-only)**

Create a throwaway check or reuse `scripts/inspect-server.ts` style: a `scripts/check-games-feed.ts` that calls `getCanonicalGames(true)` and prints `count` + first 3 entries. Run `bun run scripts/check-games-feed.ts`.
Expected: 30 games from the live API (or, if not deployed yet, the warning line + bundled count). Delete the throwaway script after.

- [ ] **Step 3: Commit**

```bash
git add lib/games-feed.ts
git commit -m "Add canonical games feed (th.gl /api/games) with TTL cache and bundled fallback"
```

### Task 2: Resolve roles by title at runtime (kills the recurring role-ID bug)

**Files:**
- Create: `C:\dev\thgl-discord-bot\lib\game-resolver.ts`
- Modify: the updates route that currently filters central-channel messages by `roleIds` (the handler in `index.ts` / wherever `findGameByRoleId` is consumed).
- Reference: `lib/game-roles.ts` (`findGameByRoleId`, `roleIds`), the earlier guild-role scan (role names map cleanly to titles).

- [ ] **Step 1: Build a role-name → roleId index from the live guild, cached**

```ts
import { getChannel } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID, getGameConfig } from "./game-roles";
import { getCanonicalGames } from "./games-feed";

const TTL_MS = 5 * 60 * 1000;
let roleCache: { at: number; byTitle: Map<string, string> } | null = null;

async function guildRoleIndex(): Promise<Map<string, string>> {
  if (roleCache && Date.now() - roleCache.at < TTL_MS) return roleCache.byTitle;
  const channel = getChannel(CENTRAL_UPDATES_CHANNEL_ID) as any;
  const roles = await channel.guild.roles.fetch();
  const byTitle = new Map<string, string>();
  for (const role of roles.values()) byTitle.set(role.name.toLowerCase(), role.id);
  roleCache = { at: Date.now(), byTitle };
  return byTitle;
}

/** discordId → resolved roleId. Prefers live guild role (by title), falls back
 *  to the hardcoded roleIds in game-roles.ts. Returns null if neither resolves. */
export async function resolveRoleId(discordId: string): Promise<string | null> {
  const games = await getCanonicalGames();
  const game = games.find((g) => g.discordId === discordId);
  const title = game?.title;
  if (title) {
    const idx = await guildRoleIndex();
    const live = idx.get(title.toLowerCase());
    if (live) return live;
  }
  return getGameConfig(discordId)?.roleIds?.[0] ?? null;
}

/** roleId → discordId, for filtering central-channel messages by their pings. */
export async function discordIdForRole(roleId: string): Promise<string | null> {
  const games = await getCanonicalGames();
  const idx = await guildRoleIndex();
  for (const g of games) {
    const live = idx.get(g.title.toLowerCase());
    if (live === roleId) return g.discordId;
  }
  // fallback to hardcoded mapping
  return (getGameConfig as any) && null;
}
```

- [ ] **Step 2: Verify resolution against the live guild (read-only)**

`scripts/check-resolver.ts`: for each canonical game, print `discordId → resolveRoleId()`; flag any that resolve to `null`. Run `bun run scripts/check-resolver.ts`.
Expected: every game with a server role resolves to a numeric ID; unmapped ones print `null` (these are the future provisioning targets). Confirms the bug class (forgotten `roleIds`) is gone because resolution is now by title. Delete the script after.

- [ ] **Step 3: Route the central-channel filter through the resolver**

In the updates handler, where central-channel messages are matched to a game by role mention, use `discordIdForRole(roleId)` instead of `findGameByRoleId`. Keep `titleKeywords` as the secondary match. (Show the exact edit at execution time against the current handler.)

- [ ] **Step 4: Verify the updates endpoint still resolves all four recently-fixed games**

Run (deployed) `curl https://discord-bot.th.gl/api/updates/<game>` for `night-crows`, `grounded2`, `songs-of-conquest`, `chrono-odyssey`.
Expected: each returns its update post — now via runtime resolution, not the hardcoded `roleIds`.

- [ ] **Step 5: Commit**

```bash
git add lib/game-resolver.ts index.ts
git commit -m "Resolve game roles by title from the live guild, with hardcoded fallback"
```

### Task 3: Reconciler — provision missing role + discussion channel (dry-run first)

**Files:**
- Create: `C:\dev\thgl-discord-bot\lib\games-provision.ts`
- Reference: `lib/faq.ts` `syncFaq({ applyDeletes })` (additive default, gated deletes), `lib/discord.ts` (`getChannel`, guild access).

- [ ] **Step 1: Implement `reconcileGames`**

```ts
import { ChannelType } from "discord.js";
import { getChannel } from "./discord";
import { CENTRAL_UPDATES_CHANNEL_ID } from "./game-roles";
import { getCanonicalGames } from "./games-feed";

const APPS_AND_GAMES_CATEGORY = "Apps & Games";

export interface ReconcileResult {
  rolesCreated: string[];
  rolesWouldCreate: string[];
  channelsCreated: string[];
  channelsWouldCreate: string[];
  orphanChannels: string[]; // game-channels under Apps & Games with no canonical game (report only)
}

export async function reconcileGames(
  opts: { apply?: boolean } = {},
): Promise<ReconcileResult> {
  const apply = opts.apply ?? false;
  const games = await getCanonicalGames(true);
  const channel = getChannel(CENTRAL_UPDATES_CHANNEL_ID) as any;
  const guild = channel.guild;
  await guild.roles.fetch();
  await guild.channels.fetch();

  const roleByTitle = new Map<string, any>();
  for (const r of guild.roles.cache.values()) roleByTitle.set(r.name.toLowerCase(), r);

  const category = [...guild.channels.cache.values()].find(
    (c: any) => c.type === ChannelType.GuildCategory && c.name === APPS_AND_GAMES_CATEGORY,
  ) as any;
  if (!category) throw new Error(`Category "${APPS_AND_GAMES_CATEGORY}" not found`);

  const channelByName = new Map<string, any>();
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildText) channelByName.set(c.name.toLowerCase(), c);
  }

  const result: ReconcileResult = {
    rolesCreated: [], rolesWouldCreate: [],
    channelsCreated: [], channelsWouldCreate: [], orphanChannels: [],
  };

  for (const game of games) {
    // Role (named by title)
    if (!roleByTitle.has(game.title.toLowerCase())) {
      if (apply) {
        const role = await guild.roles.create({ name: game.title, mentionable: true });
        roleByTitle.set(game.title.toLowerCase(), role);
        result.rolesCreated.push(game.title);
      } else {
        result.rolesWouldCreate.push(game.title);
      }
    }
    // Discussion channel #<discordId> under Apps & Games
    if (!channelByName.has(game.discordId.toLowerCase())) {
      if (apply) {
        const ch = await guild.channels.create({
          name: game.discordId,
          type: ChannelType.GuildText,
          parent: category.id,
        });
        channelByName.set(game.discordId.toLowerCase(), ch);
        result.channelsCreated.push(game.discordId);
      } else {
        result.channelsWouldCreate.push(game.discordId);
      }
    }
  }

  // Orphans: report only (decision B — deletes default off). Channels under
  // Apps & Games whose name is not a canonical discordId.
  const canonical = new Set(games.map((g) => g.discordId.toLowerCase()));
  for (const c of guild.channels.cache.values()) {
    if (
      (c as any).parentId === category.id &&
      c.type === ChannelType.GuildText &&
      !canonical.has(c.name.toLowerCase())
    ) {
      result.orphanChannels.push(c.name);
    }
  }
  return result;
}
```

- [ ] **Step 2: Dry-run against the live server**

`scripts/reconcile-games.ts`: `import { initDiscord } from "../lib/discord"; await initDiscord(); console.log(JSON.stringify(await reconcileGames({ apply: false }), null, 2)); process.exit(0);`
Run `bun run scripts/reconcile-games.ts`.
Expected: `rolesWouldCreate` / `channelsWouldCreate` list only games genuinely missing a role/channel; `orphanChannels` lists non-game channels under the category (e.g. `app-updates`, `other-games`, `thgl-companion-app` — confirm these are expected and add them to an allow-list constant before any apply). **Keep this script** (it is the operator tool).

- [ ] **Step 3: Refine the orphan allow-list**

Add a constant `NON_GAME_CHANNELS = new Set(["app-updates", "other-games", ...])` in `games-provision.ts` from what Step 2 surfaced, and exclude those from `orphanChannels`. Re-run Step 2 until orphans are truly orphans.

- [ ] **Step 4: Commit (still dry-run only; no apply path exercised)**

```bash
git add lib/games-provision.ts scripts/reconcile-games.ts
git commit -m "Add games reconciler (provision role + discussion channel), dry-run"
```

- [ ] **Step 5: Apply mode — ONLY after the bot is granted Manage Roles + Manage Channels**

With the grant in place and the bot role above the game roles, run `reconcileGames({ apply: true })` for the two known-missing-but-existing-channel cases first as the smallest real test, verify in Discord, then enable broadly.
Expected: missing roles/channels created; re-running is a no-op (idempotent).

### Task 4: Reconcile the onboarding prompt (add an option per game)

**Files:**
- Modify: `C:\dev\thgl-discord-bot\lib\games-provision.ts` (extend `reconcileGames` to also reconcile onboarding).
- Reference: `scripts/read-onboarding.ts` (kept — read-only operator tool that dumps the live prompt + role coverage).

The single prompt `1100586372844228610` carries one option per game (`{ title, role_ids:[roleId], channel_ids:[channelId] }`). `editOnboarding` **replaces the entire onboarding config**, so we must fetch current, append only the genuinely-missing options, and write the whole structure back unchanged otherwise.

- [ ] **Step 1: Extend the result type and add onboarding reconciliation**

```ts
import { Routes } from "discord.js";

// add to ReconcileResult:
//   onboardingWouldAdd: string[];
//   onboardingAdded: string[];
//   onboardingNearCap: boolean;

const GAME_PROMPT_ID = "1100586372844228610";
const ONBOARDING_OPTION_SOFT_CAP = 50;

async function reconcileOnboarding(
  guild: any, games: any[], roleByTitle: Map<string, any>,
  channelByName: Map<string, any>, apply: boolean, result: ReconcileResult,
) {
  const client = guild.client;
  const onboarding: any = await client.rest.get(Routes.guildOnboarding(guild.id));
  const prompt = (onboarding.prompts ?? []).find((p: any) => p.id === GAME_PROMPT_ID);
  if (!prompt) throw new Error(`Onboarding prompt ${GAME_PROMPT_ID} not found`);

  const haveTitles = new Set(prompt.options.map((o: any) => o.title.toLowerCase()));
  const missing = games.filter((g) => !haveTitles.has(g.title.toLowerCase()));
  if (!missing.length) return;

  if (prompt.options.length + missing.length >= ONBOARDING_OPTION_SOFT_CAP) {
    result.onboardingNearCap = true;
    console.warn(`[provision] onboarding prompt nearing ${ONBOARDING_OPTION_SOFT_CAP}-option cap (` +
      `${prompt.options.length} + ${missing.length})`);
  }

  for (const g of missing) {
    if (!apply) { result.onboardingWouldAdd.push(g.title); continue; }
    const role = roleByTitle.get(g.title.toLowerCase());
    const ch = channelByName.get(g.discordId.toLowerCase());
    prompt.options.push({
      title: g.title,
      role_ids: role ? [role.id] : [],
      channel_ids: ch ? [ch.id] : [],
    });
    result.onboardingAdded.push(g.title);
  }

  if (apply && result.onboardingAdded.length) {
    // read-merge-write the FULL config back
    await client.rest.put(Routes.guildOnboarding(guild.id), {
      body: {
        enabled: onboarding.enabled,
        default_channel_ids: onboarding.default_channel_ids,
        mode: onboarding.mode,
        prompts: onboarding.prompts,
      },
      reason: "games-provision: add onboarding options for new games",
    });
  }
}
```

Call `reconcileOnboarding(guild, games, roleByTitle, channelByName, apply, result)` at the end of `reconcileGames`, after roles+channels are resolved (so apply-mode has real role/channel IDs to link). Initialize the three new result fields to `[]`/`false`.

- [ ] **Step 2: Dry-run includes onboarding**

Re-run `bun run scripts/reconcile-games.ts`.
Expected: `onboardingWouldAdd` is empty today (all 32 present incl. Subnautica 2 / Witchspire); becomes non-empty only when a game has a role/channel but no onboarding option. Confirms the read-merge logic sees the existing 32.

- [ ] **Step 3: Commit**

```bash
git add lib/games-provision.ts
git commit -m "Reconcile onboarding prompt: add a self-assign option per new game (dry-run)"
```

- [ ] **Step 4: Apply path** — covered by Task 3 Step 5's grant (now also requires **Manage Guild**). After grant, an apply run with a deliberately-removed test option re-adds exactly that option and leaves the other 32 untouched; verify in Server Settings → Onboarding.

### Task 5: Sync endpoint + scheduler + slug realign

**Files:**
- Modify: `index.ts` (add `POST /api/games/sync`, mirroring the FAQ sync route; `?apply=true` gates creates, default dry-run; optional `GAMES_SYNC_SECRET`).
- Create: `lib/games-sync-scheduler.ts` (mirror `lib/faq-scheduler.ts`; dry-run by default).
- Modify: `lib/channels.ts` and `lib/game-roles.ts` — rename `subnautica2` → `subnautica-2` (decision C); audit all slugs against canonical `discordId` and realign any other mismatches.

- [ ] **Step 1: Realign slugs to `discordId`**

Change `name: "subnautica2"` → `name: "subnautica-2"` in both `channels.ts` and `game-roles.ts`. Cross-check every other `name` against the canonical `discordId` list (Phase 1 output) and fix mismatches.

- [ ] **Step 2: Add the sync route + scheduler** (mirror FAQ; dry-run default, secret-gated apply).

- [ ] **Step 3: Verify `/api/games/sync` dry-run over HTTP**

`curl -s -X POST https://discord-bot.th.gl/api/games/sync` → returns the `ReconcileResult` JSON, no mutations.

- [ ] **Step 4: Commit + deploy** (the session's standard flow: commit → wait for Docker build → `docker-compose pull && up -d` on `lol` → verify).

---

## Phase 3 — Forum tags → categories, game filtering on the web

> This phase has **irreversible, outward-facing** steps (renaming/removing live forum tags reorganizes existing threads). Per the ground rules these need explicit per-step sign-off; the plan provides the safe ordering, not an auto-run.

**Decision recorded:** category tags on Discord + per-game filtering on th.gl (the existing `/api/suggestions-issues` already exposes the data).

### Task 1: Web-side per-game filtering (additive, safe — do first)

- [ ] Build a th.gl view over `/api/suggestions-issues` that filters by game, detecting the game from the thread's role mention / title / content (reuse `discordIdForRole`). This removes the *reason* Discord needs a tag per game before touching any tags. Verify it lists threads per game with no Discord change.

### Task 2: Introduce category tags (additive)

- [ ] In `suggestions-issues`, the 20-tag cap is full, so category tags can't be *added* until game tags are removed. Stage it: decide the category set (`Bug`, `Suggestion`, `Question`) and the backfill mapping (existing game tag → category by thread content), scripted via the bot (Manage Threads) so no thread loses categorization.

### Task 3: Cut over (irreversible — explicit sign-off per step)

- [ ] Backfill threads with category tags (apply mode), confirm coverage, then remove game tags. Each destructive step gated and verified in Discord before the next.

---

## Self-review notes

- **Spec coverage:** A (role + discussion channel) → Phase 2 Task 3; onboarding option (owner's follow-up) → Phase 2 Task 4. B (gated deletes, report-only) → Task 3 orphan handling. C (slug realign) → Phase 2 Task 5 Step 1. Forum tags → Phase 3. Permission grant (Manage Roles + Channels + **Guild** for onboarding) → flagged as prerequisite for apply mode only.
- **No unit-test placeholders:** the bot repo has no test harness; verification is live dry-run scripts + `curl`, matching how the repo is actually validated this session. This is intentional, not a gap.
- **Type consistency:** `CanonicalGame` (games-feed) is the shape used by `game-resolver` and `games-provision`; `discordId` is the join key throughout; role name == `title` everywhere.
- **Open items deliberately deferred (not placeholders):** exact edit to the updates handler in Task 2 Step 3 (depends on current handler shape — resolved at execution); the `NON_GAME_CHANNELS` allow-list contents (derived empirically in Task 3 Step 2-3); category tag set + backfill mapping (Phase 3, needs sign-off).
