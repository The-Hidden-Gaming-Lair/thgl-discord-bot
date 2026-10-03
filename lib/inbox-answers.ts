// Leon's answers in Discord → the inbox (Leon 2026-10-03: "can the discord bot detect
// reactions? if not, extend functionality").
//
// When an item needs Leon, the agent asks him in the item's thread ("I need to ask DevLeon
// about this: …", work-inbox skill). He answers there, either way:
//   - a reaction on that bot question: 👍 / ✅ = yes (go with the recommendation),
//     👎 / ❌ = no. Other emojis are ignored.
//   - a written reply in the thread.
// Both become an inbox `answer` note on the thread's item; on a `needs_leon` item that hands it
// back to the lane that asked (status open), so the agent continues. A written reply on an item
// in any other state is logged as a plain note (staff replies are otherwise not ingested).
//
// Deciders: INBOX_DECIDER_IDS (comma-separated Discord user ids), default Leon. Inert without
// INBOX_TOKEN. Needs the GuildMessageReactions intent + Message/Reaction partials (lib/discord.ts)
// so reactions on messages sent before a restart still arrive.

import {
  Events,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { inboxApi, inboxEnabled } from "./inbox-sync";

const LEON_ID = "311400587445141504";
export const DECIDER_IDS = (process.env.INBOX_DECIDER_IDS ?? LEON_ID)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** The bot's question to Leon starts with this (work-inbox skill, Only-Leon row). */
export const ASK_MARKER = "I need to ask DevLeon about this";

const YES = new Set(["👍", "✅", "✔️", "☑️"]);
const NO = new Set(["👎", "❌", "✖️"]);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** yes / no for a reaction emoji on a question, null when it carries no answer. Pure, for tests. */
export function reactionVerdict(emoji: string | null | undefined): "yes" | "no" | null {
  if (!emoji) return null;
  const e = emoji.replace(/\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}/gu, ""); // skin tones
  if (YES.has(e)) return "yes";
  if (NO.has(e)) return "no";
  return null;
}

/** Whether a bot message is a question to Leon. Pure, for tests. */
export const isAskMessage = (content: string) => content.includes(ASK_MARKER);

/** The inbox note for a reaction answer. Pure, for tests. */
export function reactionAnswerText(verdict: "yes" | "no", emoji: string, question: string, who: string): string {
  const meaning =
    verdict === "yes" ? "YES - go with the recommendation" : "NO - do not do it / not the recommendation";
  return `${who} answered with ${emoji} on Discord: ${meaning}.\nQuestion: ${clip(question.replace(/<@!?\d+>\s*/g, "").trim(), 1500)}`;
}

type Item = { id: number; fingerprint: string; status: string; data: string | null };

/** The inbox item that belongs to a Discord thread (forum post or ticket). */
export function itemForThread(items: Item[], threadId: string): Item | null {
  const exact = items.find(
    (i) => i.fingerprint === `forum:${threadId}` || i.fingerprint === `ticket:${threadId}`,
  );
  if (exact) return exact;
  return (
    items.find((i) => {
      try {
        return JSON.parse(i.data ?? "{}")?.threadId === threadId;
      } catch {
        return false;
      }
    }) ?? null
  );
}

async function findItem(threadId: string): Promise<Item | null> {
  const res = await inboxApi<{ items: Item[] }>(
    `/inbox?status=all&limit=20&q=${encodeURIComponent(threadId)}`,
  );
  return res ? itemForThread(res.items, threadId) : null;
}

async function record(threadId: string, body: string, answer: boolean) {
  const item = await findItem(threadId);
  if (!item) return;
  const kind = answer && item.status === "needs_leon" ? "answer" : "note";
  const ok = await inboxApi(`/inbox/${item.id}/notes`, "POST", { kind, body });
  if (ok) console.log(`[inbox-answers] #${item.id} ${kind} from thread ${threadId}`);
}

async function onReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
) {
  if (!DECIDER_IDS.includes(user.id)) return;
  const verdict = reactionVerdict(reaction.emoji.name);
  if (!verdict) return;
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (!message.channel.isThread()) return;
  if (message.author?.id !== message.client.user.id || !isAskMessage(message.content)) return;
  const who = user.username ?? "DevLeon";
  await record(message.channelId, reactionAnswerText(verdict, reaction.emoji.name!, message.content, who), true);
}

async function onMessage(m: Message) {
  if (!DECIDER_IDS.includes(m.author.id) || !m.channel.isThread() || !m.content.trim()) return;
  await record(m.channelId, `${m.author.username} replied in the Discord thread: ${clip(m.content, 7000)}`, true);
}

export function registerInboxAnswers(client: Client) {
  if (!inboxEnabled()) return;
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    void onReaction(reaction, user).catch((err) => console.warn("[inbox-answers] reaction failed:", err));
  });
  client.on(Events.MessageCreate, (m) => {
    void onMessage(m).catch((err) => console.warn("[inbox-answers] message failed:", err));
  });
  console.log(`[inbox-answers] relaying answers from ${DECIDER_IDS.length} decider(s)`);
}
