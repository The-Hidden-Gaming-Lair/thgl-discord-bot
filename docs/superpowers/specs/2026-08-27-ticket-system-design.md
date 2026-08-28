# THGL Ticket System — Design

**Date**: 2026-08-27
**Status**: Approved (staff-only test phase first; MEE6 untouched until cutover)

## Problem

The MEE6 ticketing module (panel in 📕・support-ticket `1092316764081225788`) creates one private **channel** per ticket, which:

- hits Discord's 50-channels-per-category limit, forcing staff to delete tickets and lose troubleshooting history;
- produces **ghost tickets**: MEE6's state can claim a user has an open ticket whose channel no longer exists (e.g. ticket deleted via the "user left server" prompt without being closed), blocking them from ever opening another;
- doesn't notify users on staff replies unless staff remember to use Discord's Reply feature.

We replace it with a ticket system built into this bot (discord.js v14, Bun) for full control.

## Decisions (agreed with owner)

| Decision | Choice |
| --- | --- |
| Migration | Clean cut. Old MEE6 ticket channels stay until staff remove them manually; no data import. **MEE6 stays fully active until the staff-only test phase succeeds.** |
| Rollout | Phase 1: staff-only test in new staff-only channels. Phase 2: production cutover in 📕・support-ticket. |
| Open flow | Button → modal (Subject required, Description required, Game/App optional) |
| Ticket model | **One persistent private thread per user** (ModMail-style). Close = archive; reopen = unarchive the same thread. Full per-user history in one place. |
| Staff access | **No pings (owner decision)**: staff role gets ManageThreads on the panel channel and sees every private ticket thread; new-ticket awareness via the staff log channel. Opener added via own mention. |
| v1 extras | Staff log channel + auto-close of inactive tickets |
| State storage | **Approach A: Discord-native, no database.** The thread is the record; the bot stays stateless. |

## Architecture

Discord is the only data store, consistent with this repo's reconcile-against-canonical-source philosophy (FAQ sync, games sync).

- A ticket is a **private thread** (`invitable: false`, 7-day auto-archive) in the ticket panel channel. Private threads require a `GUILD_TEXT` parent — both the test channel and 📕・support-ticket qualify.
- The bot's starter/ticket embed contains the opener's mention plus a literal `user:<id>` marker; threads are matched to users by this marker (same pattern as FAQ sync's `th.gl/faq/{id}` link matching).
- **A ticket is OPEN ⇔ its thread is not archived.** Threads are named after the user and never renamed (owner decision 2026-08-28 after staff testing: stale dots were misleading; renames are capped at 2/10 min).
- User → thread lookup: fetch active + archived threads of the panel channel once, build an in-memory index (`userId → threadId`), refresh lazily (~5-min TTL, invalidated on ticket events). Trivial at this guild's volume (~50 tickets today).
- Ghost tickets are impossible by construction: no thread ⇒ no ticket.

### Modules

| File | Purpose |
| --- | --- |
| `lib/tickets.ts` | Core: thread index/cache, find-or-create user thread, `openTicket`, `closeTicket`, `reopenTicket`, marker + state helpers (pure functions where possible) |
| `lib/ticket-interactions.ts` | `InteractionCreate` router for `thgl:ticket:*` custom_ids: panel button → modal → submit; close button. Ignores all other custom_ids (no MEE6 interference). |
| `lib/ticket-scheduler.ts` | Inactivity warn + auto-close loop (pattern: `faq-scheduler.ts`) |
| `scripts/setup-ticket-channels.ts` | Operator script, idempotent: creates the staff-only test panel channel + ticket-log channel under 🔰 Staff with correct permission overwrites; prints IDs |
| `scripts/publish-ticket-panel.ts` | Operator script: posts/updates the panel message (embed + 📩 green "Open ticket" button, custom_id `thgl:ticket:open`) in the configured panel channel |
| `scripts/test-tickets.ts` | Exercises pure helpers (marker parsing, state derivation, inactivity math) without Discord, in the spirit of `scripts/test-matching.ts` |
| `lib/channels.ts` | Add `TICKET_STAFF_ROLE_ID = "1173945621963604069"` and env-backed channel IDs (below) |
| `index.ts` | Register `InteractionCreate`, `ThreadUpdate` (reopen-by-reply detection), `ThreadDelete` (logging) listeners; start scheduler |

### Configuration (env, with defaults in code)

| Var | Meaning | Default |
| --- | --- | --- |
| `TICKET_CHANNEL_ID` | Panel + threads parent channel | *(test-phase channel id; later `1092316764081225788`)* |
| `TICKET_LOG_CHANNEL_ID` | Staff log channel | *(from setup script)* |
| `TICKET_SCHEDULER_ENABLED` | Enable auto-close loop | `true` |
| `TICKET_SCHEDULER_INTERVAL_MS` | Scan interval | 6 h |
| `TICKET_WARN_AFTER_MS` | Inactivity before warning | 5 d |
| `TICKET_CLOSE_AFTER_MS` | Inactivity before auto-close (must be > warn) | 7 d |

Channel IDs via env keeps the test → production cutover a docker-compose change, matching how sync env vars are handled today.

## User flows

### Open

1. User clicks **Open ticket** → bot resolves the user's thread from the index.
2. Open thread exists → ephemeral: "You already have a ticket: {link}". Done.
3. Otherwise show modal (`thgl:ticket:modal`): **Subject** (short, required), **Description** (paragraph, required), and **Game / App** (short, optional). On submit, the ticket is created directly.
4. On submit: the optional free-text game/app field is shown in the ticket embed. No staff ping is sent by design (owner decision 2026-08-27); staff see every private ticket thread via ManageThreads on the panel channel, and are informed of new tickets via the log channel.
   - **No thread**: create private thread named after the user; post ticket embed (opener mention — which adds them — `user:<id>` marker, modal answers, **Close** button `thgl:ticket:close`).
   - **Closed thread exists**: unarchive, post fresh ticket embed with the new answers, re-mention opener. Prior conversation remains above — "reuse old tickets".
5. Ephemeral confirmation with thread link. Log event.

### Close

Close button (opener or staff) → bot posts "Closed by {user} — reply here or use the panel to reopen", archives the thread. No confirmation dialog: closing is cheap and fully reversible. Log event.

### Reopen by reply

A message in an archived thread auto-unarchives it (Discord behavior). The bot's `ThreadUpdate` listener sees the archived→active transition (ignoring bot-initiated reopens) and logs "reopened". No staff ping is sent (owner decision 2026-08-27); staff see the reopen via ManageThreads and the log channel. Users replying weeks later just work.

## Auto-close & staff log

Scheduler every `TICKET_SCHEDULER_INTERVAL_MS`: for each **active** (non-archived) ticket thread, determine **last activity = newest message that is not the bot's warning embed** (otherwise posting the warning would reset the clock and nothing would ever auto-close).

- Inactive > `TICKET_WARN_AFTER_MS` and not yet warned → post warning ("no activity; will auto-close in 2 days — reply to keep it open"). "Already warned" is derived from Discord itself: the newest message being the bot's warning embed.
- Inactive > `TICKET_CLOSE_AFTER_MS` and warned → close (same path as Close button, attributed to "auto-close").
- A thread Discord auto-archived on its own simply counts as closed — consistent by definition.

**Staff log channel**: one compact embed per event — opened / reopened (button or reply) / closed (by whom; manual or auto) / thread deleted — with subject and thread link. This is the audit trail; archived threads keep full conversation history forever, so no transcript system is needed.

## Error handling & edge cases

- **Ghost tickets**: structurally impossible. Staff deleting a thread ⇒ user's next open creates a fresh thread; `ThreadDelete` logged.
- **User left & rejoined**: thread matches by `user:<id>` marker → history preserved; mention on reopen re-adds them.
- **User leaves with open ticket**: no special handling; auto-close drains it. (MEE6's problematic delete-on-leave prompt has no equivalent.)
- **Renames**: never performed — the name-dot state indicator was removed after staff testing (stale dots misled staff; renames are capped at 2/10 min).
- **1000 active-threads guild cap**: unreachable with archive-on-close at this volume; scheduler guarantees drainage.
- **Partial failure during open** (thread created, embed/mention failed): ephemeral error asks user to retry; the retry finds the thread by marker (or, if the marker message failed, an empty bot thread is detected and adopted) and completes initialization.
- **Foreign components**: router handles only `thgl:ticket:*`; MEE6's buttons are never touched.
- **Duplicate threads for one user** (should not happen; e.g. race or manual creation): index prefers the most recently active; others are ignored and can be deleted by staff.

### Permission checklist (per panel channel)

- Bot: **Create Private Threads**, **Send Messages in Threads**, **Manage Threads**, View/Send.
- `@everyone` (production) / staff role (test phase): **Send Messages in Threads** — without it ticket openers can't type (documented pitfall) — **Manage Threads** (staff only; grants visibility into every private ticket thread without a ping — owner decision 2026-08-27) — and **Create Private Threads OFF** so only the bot creates tickets.
- Test-phase channels additionally deny `@everyone` **View Channel**; allow staff role.

`setup-ticket-channels.ts` applies these overwrites so nothing is hand-configured.

## Rollout

### Phase 1 — staff-only test (this implementation)

1. Deploy bot with listeners + scheduler (inert until channel IDs are set).
2. Run `setup-ticket-channels.ts` → creates staff-only `🎫・ticket-test` + `🎫・ticket-log` under 🔰 Staff.
3. Set `TICKET_CHANNEL_ID`/`TICKET_LOG_CHANNEL_ID` (docker-compose), run `publish-ticket-panel.ts`.
4. Staff open/close/reopen test tickets themselves. Short-scale env timings to verify warn/auto-close live.
5. **MEE6 remains fully untouched.**

### Phase 2 — production cutover (executed 2026-08-28)

1. ✅ `TICKET_CHANNEL_ID` → 📕・support-ticket `1092316764081225788` (server docker-compose only — local `.env` must NOT set ticket env; multi-instance kill-switch, see CLAUDE.md); permissions via `setup-ticket-channels.ts --production`; panel via `publish-ticket-panel.ts`.
2. Owner (pending): delete the MEE6 panel message; disable MEE6 ticketing plugin.
3. ✅ The 2025-06-18 instructions message deleted — its checklist now lives in the panel embed.
4. Ticket-log channel stays; `🎫・ticket-test` deleted after cutover; old MEE6 ticket channels cleaned up manually by staff over time.

## Testing

- `scripts/test-tickets.ts`: pure-function checks (marker parse/format, open-state derivation, warn/close threshold math) — runnable in CI/dev without a token.
- Manual checklist in the test channel: open; duplicate-open guard; close via button (opener and staff); reopen via panel button; reopen via reply to archived thread; staff-role auto-add + notification; warn → auto-close with second-scale timings; log embed per event; MEE6 panel unaffected.

## Out of scope (v1)

Claiming, close reasons/confirmation dialogs, ratings/feedback, transcripts/web viewer, API exposure of tickets, category/topic routing, importing MEE6 ticket history.
