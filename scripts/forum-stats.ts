import { ChannelType, PermissionsBitField } from "discord.js";
import { initDiscord, getChannel, getForumPosts } from "../lib/discord";
import { SUGGESTIONS_ISSUES_CHANNEL, FAQ_CHANNEL } from "../lib/channels";
import { CENTRAL_UPDATES_CHANNEL_ID } from "../lib/game-roles";

await initDiscord();
const guild = (getChannel(CENTRAL_UPDATES_CHANNEL_ID) as any).guild;
const me = await guild.members.fetchMe();
const F = PermissionsBitField.Flags;
console.log(`ManageThreads: ${me.permissions.has(F.ManageThreads)}`);

const forum = getChannel(SUGGESTIONS_ISSUES_CHANNEL.id) as any;
console.log(`\n=== #${forum.name} ===`);
console.log(`requireTag flag: ${forum.flags?.has?.("RequireTag") ?? "?"}`);
const tags = forum.availableTags ?? [];
console.log(`availableTags: ${tags.length}/20`);
const tagName = new Map<string, string>(tags.map((t: any) => [t.id, t.name]));
for (const t of tags) console.log(`  - ${t.name} (${t.id})${t.moderated ? " [mod-only]" : ""}${t.emoji ? ` emoji=${t.emoji.name ?? t.emoji.id}` : ""}`);

// All threads (active + archived)
const threads = await getForumPosts(SUGGESTIONS_ISSUES_CHANNEL.id);
console.log(`\ntotal threads: ${threads.length}`);
const usage = new Map<string, number>();
let untagged = 0;
let multiTag = 0;
for (const th of threads as any[]) {
  const applied = th.appliedTags ?? [];
  if (applied.length === 0) untagged++;
  if (applied.length > 1) multiTag++;
  for (const id of applied) {
    const n = tagName.get(id) ?? `unknown(${id})`;
    usage.set(n, (usage.get(n) ?? 0) + 1);
  }
}
console.log(`untagged threads: ${untagged}, multi-tag threads: ${multiTag}`);
console.log("tag usage:");
for (const [n, c] of [...usage.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(c).padStart(4)}  ${n}`);
}

// Archived split
const active = (threads as any[]).filter((t) => !t.archived).length;
console.log(`active: ${active}, archived: ${threads.length - active}`);

process.exit(0);
