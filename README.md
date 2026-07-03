# The Hidden Gaming Lair — Discord Bot

This is the official Discord bot for [The Hidden Gaming Lair](https://www.th.gl), built with [Bun](https://bun.sh).  
It provides an API that exposes content from the **updates** and **info** channels of the THGL Discord community.

This API powers features such as **release notes** and **announcements** across THGL websites and apps.

Join the community on Discord: [https://th.gl/discord](https://th.gl/discord)

## 🧩 Related Repositories

This repo is part of a larger ecosystem of tools and services powering The Hidden Gaming Lair. Some of these repositories are private and not open source:

| Repository                                                                            | Description                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [`thgl-data-forge`](https://github.com/The-Hidden-Gaming-Lair/thgl-data-forge)        | Data mining and API project for serving static game data (locations, filters, icons, etc.). |
| [`thgl-api-forge`](https://github.com/The-Hidden-Gaming-Lair/thgl-api-forge)          | Dynamic API + database layer (starting with comments, more to come).                        |
| [`thgl-memory-access`](https://github.com/The-Hidden-Gaming-Lair/thgl-memory-access)  | Game-specific memory reading projects for real-time data extraction.                        |
| [`thgl-companion-app`](https://github.com/The-Hidden-Gaming-Lair/thgl-companion-app)  | Windows companion app with in-game overlay and position tracking.                           |
| [`thgl-discord-bot`](https://github.com/The-Hidden-Gaming-Lair/thgl-discord-bot)      | Discord bot exposing update & info channels via API (used for release notes on apps/web).   |
| [`thgl-web-components`](https://github.com/The-Hidden-Gaming-Lair/thgl-companion-app) | Multi-app frontend monorepo containing apps, websites, and shared UI components.            |

## 🚀 Features

- **Channel Feed API**  
  Access to curated posts from updates and info channels in the THGL Discord server.

- **Integrates with Web & App Frontends**  
  Used to show release notes, patch summaries, and community news in the THGL ecosystem.

- **Game Role IDs API**  
  `GET /api/roles` returns `[{ name, roleId, channelId }]` for each game (from
  `lib/game-roles.ts`), so tools can build the `<@&ROLE_ID>` announcement ping
  mention without hardcoding role IDs.

- **Games Sync (web → Discord auto-provisioning)**  
  The canonical games list on th.gl drives Discord: new games get their role,
  discussion channel, guild emoji, and onboarding option automatically. See below.

- **Suggestions & Issues API with game/category metadata**  
  Forum posts are served with `games[]` and `category` (bug/suggestion/question)
  so th.gl can filter per game without a Discord tag per game.

- **Lightweight & Fast**  
  Built with Bun for performance and simplicity.

- **FAQ Sync (web → Discord)**  
  Mirrors the web FAQ (`faq-entries.ts`, served at `https://www.th.gl/api/faq`)
  into the Discord FAQ forum, so the FAQ is maintained in one place. See below.

## 🎮 Games Sync (auto-provisioning)

The canonical games list (`https://www.th.gl/api/games`, from `@repo/lib`
`games` in the web monorepo) is the single source of truth for which games
exist. The bot reconciles Discord against it every 30 minutes; adding a game on
th.gl is all that's needed — within one tick the bot provisions:

1. a **role** named after the game title (members claim it via onboarding),
2. a **discussion channel** `#<discordId>` under "Apps & Games" (sorted A–Z,
   specials pinned; legacy channel names are recognized via an alias map),
3. a **guild emoji** (matched by name, or uploaded from the game's logo URL),
4. an **onboarding option** (role + channel + emoji) in the game prompt, sorted.

Everything is **additive-only**: the reconciler never deletes or renames roles,
channels, emojis, or onboarding options, and it aborts any onboarding write
that would drop an existing option or emoji. Orphans are report-only.

**Trigger**

```
GET  /api/games/sync             # dry-run report (read-only)
POST /api/games/sync?apply=true  # create missing objects (requires secret)
```

`apply=true` returns 403 unless `GAMES_SYNC_SECRET` is configured. Operator
alternative: `bun run scripts/reconcile-games.ts [--apply --force]`.

**Environment**

| Variable                 | Default                        | Purpose                                                |
| ------------------------ | ------------------------------ | ------------------------------------------------------ |
| `GAMES_API_URL`          | `https://www.th.gl/api/games`  | Canonical games feed (falls back to the bundled list). |
| `GAMES_SYNC_SECRET`      | _(unset — apply disabled)_     | Required via `x-sync-secret` header or `?secret=` for apply. |
| `GAMES_SYNC_ENABLED`     | on                             | Set `false` to disable the scheduler.                  |
| `GAMES_SYNC_INTERVAL_MS` | `1800000` (30 min)             | Scheduler poll interval.                               |
| `GAMES_SYNC_APPLY`       | `false`                        | `true` lets the scheduler create missing objects.      |

**Discord permissions** the bot needs for apply: *Manage Roles*, *Manage
Channels*, *Manage Server* (edit onboarding), *Create Expressions* (upload
emojis). Dry-run needs none of these.

## 💡 Suggestions & Issues

`GET /api/suggestions-issues` (list, `?limit=N`) and
`GET /api/suggestions-issues/{postId}` (full detail with replies) serve the
`#suggestions-issues` forum. Each post includes:

- `tags` — the live Discord forum tags (**Coding / Bug / Suggestion / Question**;
  the forum's 20-tag cap made one-tag-per-game unsustainable),
- `games[]` — game slugs for per-game filtering on th.gl, resolved from live
  tags → the committed pre-cutover snapshot (`data/suggestions-snapshot.json`)
  → keyword detection on title/content,
- `category` — `bug` / `suggestion` / `question`.

`data/suggestions-snapshot.json` is the permanent backup and game-association
source for all threads created before the 2026-07 tag cutover — **do not
delete it**.

## ❔ FAQ Sync

The web is the single source of truth for the FAQ. The bot reconciles the FAQ
forum so each web entry has exactly one **bot-authored** thread (bot-authored so
it can be edited on later runs), with as much of the answer as fits plus a link
to the canonical page.

**Trigger**

```
POST /api/faq/sync             # create/update threads; LIST pending deletions (dry run)
POST /api/faq/sync?apply=true  # also delete legacy/orphaned threads
```

A scheduler also runs periodically (see env below). Deletions are off by default
everywhere so the first run can be inspected before anything is removed.

**Environment**

| Variable                 | Default                      | Purpose                                              |
| ------------------------ | ---------------------------- | ---------------------------------------------------- |
| `FAQ_API_URL`            | `https://www.th.gl/api/faq`  | Canonical FAQ feed to mirror.                        |
| `FAQ_SYNC_SECRET`        | _(unset)_                    | If set, required via `x-sync-secret` header or `?secret=`. |
| `FAQ_SYNC_ENABLED`       | on                           | Set `false` to disable the scheduler.                |
| `FAQ_SYNC_INTERVAL_MS`   | `1800000` (30 min)           | Scheduler poll interval.                             |
| `FAQ_SYNC_APPLY_DELETES` | `false`                      | `true` lets the scheduler delete legacy/orphan threads automatically. |

**Discord permissions** the bot role needs in the FAQ forum: *Create Posts*,
*Send Messages in Threads*, *Manage Threads* (to unarchive on update and delete
legacy/orphan threads), *Manage Messages* (to edit starter messages), and
*Manage Channels* (to create the web-label tags on the forum). Without Manage
Channels the sync still runs; it just logs that it couldn't create tags.

**First migration**

1. `POST /api/faq/sync` — creates bot threads and prints the legacy posts it
   *would* delete (those marked `[NO WEB EQUIVALENT]` have no web page and would
   be lost — migrate them into `faq-entries.ts` first if you want to keep them).
2. Once the plan looks right, `POST /api/faq/sync?apply=true` to remove the
   legacy `devleon`-authored posts.

## 🤝 Access & Contact

The API is private.  
To request access, message `devleon` on Discord or reach out in the THGL server.

## 🛠️ Contributing

Pull requests are welcome!  
If you want to improve the bot, suggest features, or report issues:

- Open a GitHub Issue
- Submit a PR (small, focused changes preferred)

## 📝 License

This project is licensed under the [MIT License](LICENSE).
