# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development

- `bun --hot run index.ts` or `bun dev` - Start the bot with hot reload
- `bun run index.ts` or `bun start` - Start the bot in production mode
- `bun install` - Install dependencies

## Architecture

### Core Structure

This Discord bot exposes API endpoints for THGL Discord channel content:

- **Main Server**: HTTP server on Bun.serve exposing `/api/updates` and `/api/info` routes
- **Discord Integration**: Uses discord.js with GuildMessages and MessageContent intents to fetch channel messages and role mentions
- **Channel Configuration**: Hardcoded channel IDs in `lib/channels.ts` for updates and info channels
- **Centralized Updates**: Uses a central app-updates channel (ID: 1166078913756270702) as fallback for game updates

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
- `/api/suggestions-issues` - Returns forum posts from suggestions-issues forum channel (includes title, content, tags, and metadata)
  - Optional: `?limit=N` - Limit number of posts returned
  - Note: Posts with deleted starter messages will have empty content
- `/api/suggestions-issues/{postId}` - Returns single forum post with ALL replies, reactions, and full details
- Root endpoints list available channels with links

**Message Processing** (`lib/messages.ts`):

- Converts Discord messages to simplified JSON format
- Extracts text content, image attachments, and timestamps

**HTTP Response** (`lib/http.ts`):

- Custom ClientResponse class with CORS headers
- 60-second cache control for all responses

**Game Configuration** (`lib/game-roles.ts`):

- Maps game names to their Discord channels and role IDs
- Provides title keyword matching for game identification
- Supports both role mention filtering and title-based filtering

**App Updates Cache** (`lib/app-updates-cache.ts`):

- Caches up to 100 messages from the central app-updates channel
- Cache TTL: 5 minutes
- Automatically refreshes when expired
- Reduces API calls for frequently accessed game updates

### Environment Requirements

- `DISCORD_TOKEN` environment variable must be set
- Bot requires access to configured Discord channels
- Uses Bun runtime with TypeScript support enabled

### Channel Management

All Discord channels are defined statically in `lib/channels.ts`. Each channel has:

- `name`: URL-friendly identifier used in API routes
- `id`: Discord channel ID for fetching messages

When adding new channels, update the appropriate array (UPDATES_CHANNELS or INFO_CHANNELS) in `lib/channels.ts`.

### Updates Fallback Strategy

The `/api/updates` endpoint uses a two-tier fallback strategy:

1. **Primary**: Try to fetch from the game's dedicated update channel (e.g., `dune-awakening` channel)
2. **Fallback**: If channel doesn't exist or has fewer than 5 messages, fetch from central app-updates channel (1166078913756270702)
3. **Filtering**: Messages from central channel are filtered by:
   - Role mentions (if `roleIds` are configured in `lib/game-roles.ts`)
   - OR title keywords (e.g., "Dune: Awakening Update")

This allows:
- New games without dedicated channels to still have updates via the central channel
- Gradual transition from dedicated channels to central channel
- Role-based filtering for precise game identification

### Utility Scripts

- `scripts/extract-role-ids.ts` - Extract role IDs from app-updates channel messages (run after mentioning roles)
- `scripts/test-matching.ts` - Test game matching logic against cached messages
- `scripts/debug-messages.ts` - Debug message structure and role mentions
