# Privileged Intent Request — Message Content (resubmission draft)

App: The Hidden Gaming Lair (1176153275918204928). Deadline: ~2026-09-26
(29 days from the 2026-08-28 notice; reapplying within 30 days retains
access during review).

**Request ONLY the Message Content intent.** The bot does not use Guild
Members or Presence (they are not in its gateway IDENTIFY and the portal
toggles are off). A prior request was denied — denials apply to the whole
request, so including unused intents sinks everything.

---

## Use-case text (paste into the Message Content field)

> Our app is a private, single-server infrastructure bot. It is a member of
> exactly one guild — our own community "The Hidden Gaming Lair" (~XX,000
> members) — and is not installable by other servers. It connects our
> Discord community with our companion website www.th.gl and our desktop
> app. Message Content is required for four read-only functions over our
> own server's channels:
>
> 1. Release-notes mirror: our team posts app release notes as regular
> messages in our announcements channel (#app-updates). The bot reads these
> messages and serves them as JSON to www.th.gl and our desktop companion
> app, so users can read update notes outside Discord. These are
> human-authored messages, so neither interaction primitives nor
> bot-authored content can replace this — without the intent the entire
> pipeline serves empty text.
>
> 2. Community feedback mirror: the bot serves our suggestions/issues forum
> posts (titles and bodies, written by community members) to www.th.gl so
> suggestions are searchable per game on the website and duplicates are
> avoided.
>
> 3. Spam protection for our own members: a guard detects cross-channel
> image/link spam campaigns (which hit us multiple times per week), deletes
> the spam and bans the throwaway accounts. Detection needs the message
> attachments/content of arbitrary user messages at creation time; AutoMod
> cannot express our behavioral rules (cross-channel correlation,
> image-only bursts), and interactions do not apply to passively received
> messages.
>
> 4. Support-ticket context: staff can convert a user's help request posted
> in a game channel into a private support thread; the bot quotes the
> user's original message into the ticket.
>
> Data handling: message content is processed transiently. Only content
> from our own announcement and public feedback channels is exposed — on
> our own website, for our own community. Spam-guard buffers message
> content in memory for at most 60 seconds. No message content is sold,
> shared with third parties, or used for ML training.

(Replace ~XX,000 with the actual member count before submitting.)

## Portal fields (General Information tab + review form)

- **Terms of Service URL**: `https://www.th.gl/terms-of-service` (page added
  to the web monorepo 2026-08-29; covers websites, apps, and the Discord
  community/bot incl. moderation bans)
- **Privacy Policy URL**: `https://www.th.gl/privacy-policy` (now includes a
  "Discord Community & Bot" section disclosing message-content processing:
  announcements/suggestions republishing, tickets, 60s spam buffer, no
  sale/sharing/AI training — reviewers check for exactly this)
- **Install link**: `https://discord.com/oauth2/authorize?client_id=1176153275918204928&scope=bot+applications.commands`
  — a required form field for every app under review (reviewers use it to
  verify the app is real). It does NOT make the bot public: keep the
  **"Public Bot" toggle OFF** in the Bot tab, then only the owner can
  complete that OAuth flow. Mention in the use case that the app is
  intentionally private/single-server.

## Form question notes

- "Do you store message content?" — transiently in memory (≤60s for spam
  detection, ≤5min caches for the website API); announcement/forum content
  is republished on our own site; nothing else persisted.
- If asked for alternatives considered: AutoMod (cannot express
  cross-channel behavioral rules or serve content to our website), slash
  commands/interactions (do not apply to passively posted announcements,
  forum posts, or spam), webhooks (our announcements are authored by
  humans in Discord, the website is the consumer, not the producer).
- Only tick Message Content. Verify the Bot-tab toggles for Presence and
  Server Members are OFF before submitting.

## If it is denied again

Alternatives (worse, but survivable) would be: moving release notes to a
web-first workflow (post on th.gl, bot mirrors INTO Discord — bot-authored
content is exempt from the intent), and accepting the loss of spam-guard
content rules + suggestions mirroring. The ticket system itself survives
either way (it reads bot-authored messages, which are exempt).
