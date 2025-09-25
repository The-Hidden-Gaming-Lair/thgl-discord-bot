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
- **Discord Integration**: Uses discord.js with minimal intents (only Guilds) to fetch channel messages
- **Channel Configuration**: Hardcoded channel IDs in `lib/channels.ts` for updates and info channels

### Key Components

**Discord Client Management** (`lib/discord.ts`):

- Singleton client pattern with initialization promise
- Helper functions for channel and message access
- Text/voice channel validation

**API Routes**:

- `/api/updates/{channel-name}` - Returns last 5 messages from update channels
- `/api/info/{channel-name}` - Returns last 5 messages from info channels
- Root endpoints list available channels with links

**Message Processing** (`lib/messages.ts`):

- Converts Discord messages to simplified JSON format
- Extracts text content, image attachments, and timestamps

**HTTP Response** (`lib/http.ts`):

- Custom ClientResponse class with CORS headers
- 60-second cache control for all responses

### Environment Requirements

- `DISCORD_TOKEN` environment variable must be set
- Bot requires access to configured Discord channels
- Uses Bun runtime with TypeScript support enabled

### Channel Management

All Discord channels are defined statically in `lib/channels.ts`. Each channel has:

- `name`: URL-friendly identifier used in API routes
- `id`: Discord channel ID for fetching messages

When adding new channels, update the appropriate array (UPDATES_CHANNELS or INFO_CHANNELS) in `lib/channels.ts`.
