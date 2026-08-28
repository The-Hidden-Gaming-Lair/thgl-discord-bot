# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development

- `bun --hot run index.ts` or `bun dev` - Start the bot with hot reload
- `bun run index.ts` or `bun start` - Start the bot in production mode
- `bun install` - Install dependencies

## Architecture

### Core Structure

This Discord bot exposes API endpoints for THGL Discord channel content and reconciles Discord against canonical web feeds:

- **Main Server**: HTTP server on Bun.serve exposing `/api/updates`, `/api/info`, `/api/suggestions-issues`, `/api/roles`, `/api/faq/sync`, `/api/games/sync`
- **Discord Integration**: Uses discord.js with GuildMessages and MessageContent intents to fetch channel messages and role mentions
- **Canonical games source**: `https://www.th.gl/api/games` (the web monorepo's `@repo/lib` games array) is the single source of truth for which games exist. The hardcoded lists in `lib/channels.ts` / `lib/game-roles.ts` are a **fallback cache**, not the source — new games need NO edits here; the games sync provisions Discord automatically (see Games Sync below).
- **Centralized Updates**: All game updates flow through the central app-updates channel (ID: 1166078913756270702); per-game `#updates-*` channels are deprecated

### Key Components

**Discord Client Management** (`lib/discord.ts`):

- Singleton client pattern with initialization promise
- Helper functions for channel and message access
- Text/voice channel validation

**API Routes**:

- `/api/updates/{channel-name}` - Returns last 5 messages from update channels (with fallback to central channel)
  - Strategy: First attempts dedicated game channel, then falls back to central app-updates channel
  - Filters central channel messages by role mentions or title keywords
- `/api/info/{channel-name}` - Returns last 5 messages from info channels
- `/api/suggestions-issues` - Returns forum posts from suggestions-issues forum channel (title, content, tags, plus `games: string[]` and `category: "bug"|"suggestion"|"question"` — see Suggestions Meta below)
  - Optional: `?limit=N` - Limit number of posts returned
  - Note: Posts with deleted starter messages will have empty content
- `/api/suggestions-issues/{postId}` - Returns single forum post with ALL replies, reactions, and full details (same `games`/`category` fields)
- `/api/faq/sync` (POST) - Web→Discord FAQ sync. Reconciles the FAQ forum (FAQ_CHANNEL in `lib/channels.ts`) against the canonical web feed. `?apply=true` also deletes legacy/orphaned threads (default dry-run for deletions). Optional `FAQ_SYNC_SECRET` via `x-sync-secret` header or `?secret=`.
- `/api/games/sync` (GET or POST) - Web→Discord games reconciliation report (dry-run, read-only). `POST ?apply=true` creates missing Discord objects; returns 403 unless `GAMES_SYNC_SECRET` is set and provided. See Games Sync below.
- `/api/roles` (GET) - Returns `[{ name, roleId, channelId }]` for every game in `lib/game-roles.ts` that has a `roleIds` entry. Lets other tools build the `<@&ROLE_ID>` announcement ping mention without hardcoding role IDs (consumed by data-forge `scripts/draft-release-notes.ts`, which falls back to a baked-in copy if this endpoint is unavailable).
- Root endpoints list available channels with links

**FAQ Sync** (`lib/faq.ts`, `lib/faq-scheduler.ts`):

- The web FAQ (`faq-entries.ts` on www.th.gl, served at `FAQ_API_URL`, default `https://www.th.gl/api/faq`) is the single source of truth.
- `syncFaq({ applyDeletes })` creates/updates one **bot-authored** thread per web entry (bot must author them to edit on resync), matching existing threads by the canonical `th.gl/faq/{id}` link embedded in the starter message. Long answers are truncated to Discord's 2000-char limit with a link to the full page.
- FAQ `labels` map to forum tag **names** (`LABEL_TO_TAG_NAME`, fallback `THGL`), resolved to tag IDs at runtime.
- Deletions (legacy non-bot threads + orphaned bot threads) only happen when `applyDeletes` is true. The scheduler (`startFaqSyncScheduler`) runs additively by default; see README env vars.

**Games Sync** (`lib/games-feed.ts`, `lib/game-resolver.ts`, `lib/games-provision.ts`, `lib/games-sync-scheduler.ts`):

- The web games list (`https://www.th.gl/api/games`, override `GAMES_API_URL`) is the single source of truth. `getCanonicalGames()` caches it 5 min and falls back to a bundled list derived from `GAME_CONFIGS` when offline. The join key is `discordId` (a slug like `aeternum-map`, NOT a snowflake).
- `resolveRoleId(discordId)` resolves a game's role from the LIVE guild by matching the role name to the canonical title (5-min cache), falling back to hardcoded `roleIds`. This is why forgetting `roleIds` for a new game no longer breaks update filtering.
- `reconcileGames({ apply })` provisions per game: role (named by title), discussion channel `#<discordId>` under "Apps & Games" (legacy names recognized via `CHANNEL_ALIASES` — owner chose aliases over renaming), guild emoji (matched by name or uploaded from the feed's `logo` URL), and an onboarding option (role + channel + emoji) in prompt `1100586372844228610`. Channels and onboarding options re-sort after creates (pinned specials, then A–Z).
- **Additive-only, guarded**: never deletes/renames anything; the onboarding full-replace PUT maps Discord's nested `emoji` objects to flat `emoji_id`/`emoji_name` (the PUT ignores nested objects — this once wiped all option emojis) and aborts if any existing option or emoji would be dropped. Orphan channels are report-only. `runReconcileGames` is the concurrency-guarded wrapper the route/scheduler use.
- Scheduler env: `GAMES_SYNC_ENABLED`, `GAMES_SYNC_INTERVAL_MS` (default 30 min), `GAMES_SYNC_APPLY` (default false = dry-run). Apply needs Discord perms: Manage Roles, Manage Channels, Manage Server (onboarding), Create Expressions (emoji upload).

**Ticket System** (`lib/tickets.ts`, `lib/ticket-interactions.ts`, `lib/ticket-scheduler.ts`):

- Self-hosted replacement for MEE6 ticketing. A ticket is a **private thread** in `TICKET_CHANNEL_ID`, **one persistent thread per user** (close = archive, reopen = unarchive the same thread — full history preserved). Discord is the only data store: threads are matched to users via a `user:<id>` marker in the first bot message's embed footer; **OPEN ⇔ thread not archived** (threads are named after the user and never renamed).
- Flow: panel button (`thgl:ticket:open`) → modal (subject/description/optional game text) → private thread with opener mention; every configured staff member (`TICKET_STAFF_USER_IDS` in `lib/channels.ts`, each re-verified to still hold the staff role via single-member fetch) is then **silently added** via `thread.members.add` (no ping — owner decision 2026-08-27). The GuildMembers privileged intent is NOT used — enabling it needs Discord verification review at this bot's scale, so staff are an explicit ID list. New staff → add the ID to the list (or `TICKET_STAFF_USER_IDS` env). Staff also see all threads via ManageThreads, and the log channel records every event. Optional free-text Game/App field is shown in the ticket embed. Close button archives; a user reply to a closed thread auto-unarchives it (no staff re-ping). Inactivity scheduler warns then auto-closes (`TICKET_*` env vars, see README).
- Inert unless `TICKET_CHANNEL_ID` is set. **Production (since 2026-08-28)**: `TICKET_CHANNEL_ID=1092316764081225788` (📕・support-ticket) + `TICKET_LOG_CHANNEL_ID=1542600991986425916` (`#🎫・ticket-log`, staff-only) are set ONLY in the server's docker-compose. **Never set them in the local `.env` while the production bot runs** — that's the multi-instance kill-switch: interactions are safe either way (every handler acks before side effects, and Discord accepts one ack per interaction), but a second instance with the same env would duplicate scheduler warnings and log embeds.
- Production channel perms (applied by `setup-ticket-channels.ts --production`): `@everyone` can view + use the panel and type in threads (`SendMessagesInThreads`), but not write in the channel or create threads; users only see their own ticket (private-thread membership).
- Operator scripts: `scripts/setup-ticket-channels.ts`, `scripts/publish-ticket-panel.ts`; pure-logic tests in `scripts/test-tickets.ts`.

**Suggestions Meta** (`lib/suggestions-meta.ts`, `data/suggestions-snapshot.json`):

- The suggestions-issues forum has CATEGORY tags (Coding/Bug/Suggestion/Question), not per-game tags (Discord caps forums at 20 tags; the per-game scheme was cut over in 2026-07). Per-game filtering lives on th.gl via the API's `games[]` field.
- Game association precedence: live game tags (none remain post-cutover, but supported) → the committed snapshot → `titleKeywords` detection on title/content. Category: live category tag → snapshot → deterministic heuristic (`classifyCategory`).
- `data/suggestions-snapshot.json` is the full pre-cutover backup (854 threads incl. starter content) and the ONLY game-association source for historical threads — **never delete it**; the Dockerfile ships it into the image.

Web→Discord flows: FAQ sync and Games sync. All other routes are Discord→web reads.

**Message Processing** (`lib/messages.ts`):

- Converts Discord messages to simplified JSON format
- Extracts text content, image attachments, and timestamps

**HTTP Response** (`lib/http.ts`):

- Custom ClientResponse class with CORS headers
- 60-second cache control for all responses

**Game Configuration** (`lib/game-roles.ts`) — fallback cache, not the source of truth:

- Maps game names to Discord channels/role IDs; used when the live feed or guild lookup can't resolve something, and as the bundled offline fallback for the games feed
- `titleKeywords` remain load-bearing: update filtering (title fallback) and suggestions game detection both use them
- New games do NOT require edits here (runtime resolution covers them), but adding the entry keeps offline fallback complete

**App Updates Cache** (`lib/app-updates-cache.ts`):

- Caches up to 100 messages from the central app-updates channel
- Cache TTL: 5 minutes
- Automatically refreshes when expired
- Reduces API calls for frequently accessed game updates

### Environment Requirements

- `DISCORD_TOKEN` environment variable must be set
- Bot requires access to configured Discord channels
- Uses Bun runtime with TypeScript support enabled
- Sync env vars (`FAQ_SYNC_*`, `GAMES_SYNC_*`, `GAMES_API_URL`, `FAQ_API_URL`): see the README tables. Production values live in the server's `docker-compose.yml` (host `lol`); `GAMES_SYNC_APPLY=true` + `GAMES_SYNC_SECRET` are set there, so provisioning runs automatically in production

### Adding a New Game

Add it to the canonical games list in the web monorepo (`packages/lib/src/games.ts` → served at `th.gl/api/games`). That's it — the games sync provisions the Discord role, discussion channel, emoji, and onboarding option automatically (scheduler tick or `POST /api/games/sync?apply=true`). The API slug is the game's `discordId`. Optionally add a fallback entry (with `titleKeywords`) to `lib/game-roles.ts`/`lib/channels.ts` for offline completeness.

`lib/channels.ts` still statically defines the legacy/non-game channels (`name` = URL identifier for API routes, `id` = Discord channel id, empty id = central-channel-only) plus INFO_CHANNELS, SUGGESTIONS_ISSUES_CHANNEL, and FAQ_CHANNEL.

### Updates Fallback Strategy

The `/api/updates/{game}` endpoint:

1. **Dedicated channel** (legacy): fetched if the game has a non-empty channel id — all per-game `#updates-*` channels are deprecated/emptying, so in practice…
2. **Central channel**: messages from app-updates (1166078913756270702) are filtered per game by role mention — the candidate role set is the LIVE guild role (resolved by canonical title via `game-resolver`) **unioned** with hardcoded `roleIds`, each independently sufficient — with `titleKeywords` first-line matching as the final fallback.

### Utility Scripts

- `scripts/reconcile-games.ts` - Games sync operator tool: dry-run report, `--apply --force` to provision (concurrency-guarded)
- `scripts/inspect-server.ts` - Dump guild channels/categories/forum-tag usage
- `scripts/read-onboarding.ts` - Dump the onboarding prompt + role coverage
- `scripts/forum-stats.ts` - Suggestions forum tag/thread statistics
- `scripts/snapshot-suggestions.ts` - Full read-only forum backup to `data/suggestions-snapshot.json` (rerun + commit before any forum-mutating migration)
- `scripts/swap-forum-tags.ts`, `scripts/backfill-categories.ts` - The 2026-07 category-tag cutover tools (executed; kept for reference/verify mode — `backfill-categories.ts --verify` checks forum invariants against the snapshot)
- `scripts/extract-role-ids.ts` - Legacy: extract role IDs from app-updates messages
- `scripts/test-matching.ts` - Test game matching logic against cached messages
- `scripts/debug-messages.ts` - Debug message structure and role mentions
- `scripts/setup-ticket-channels.ts` - Ticket system: create staff-only test + log channels (idempotent)
- `scripts/publish-ticket-panel.ts` - Ticket system: post/update the panel message in TICKET_CHANNEL_ID
- `scripts/test-tickets.ts` - Ticket system: pure-logic assertions (no token needed)
