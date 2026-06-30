import { initDiscord, getClient } from "../lib/discord";
import { ChannelType } from "discord.js";
import { CENTRAL_UPDATES_CHANNEL_ID } from "../lib/game-roles";

await initDiscord();
const client = getClient();
const central = client.channels.cache.get(CENTRAL_UPDATES_CHANNEL_ID) as any;
const guild = central.guild;
await guild.channels.fetch();

const channels = [...guild.channels.cache.values()] as any[];
const typeName: Record<number, string> = {
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildCategory]: "category",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildMedia]: "media",
};

// 1) Everything named like a known game (avowed) to see its full footprint
console.log("=== ALL channels matching 'avowed' ===");
for (const c of channels.filter((c) => /avowed/i.test(c.name ?? ""))) {
  const parent = c.parentId ? channels.find((p) => p.id === c.parentId)?.name : "(none)";
  console.log(`  ${typeName[c.type] ?? c.type}  #${c.name} (${c.id})  parent=${parent}`);
}

// 2) Full child listing of the two game categories
for (const catName of ["Apps & Games", "Shared-Filters", "Deprecated"]) {
  const cat = channels.find((c) => c.type === ChannelType.GuildCategory && c.name === catName);
  if (!cat) continue;
  const kids = channels.filter((c) => c.parentId === cat.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  console.log(`\n=== ${catName} (${kids.length}) ===`);
  for (const c of kids) {
    console.log(`  ${typeName[c.type] ?? c.type}  #${c.name} (${c.id})`);
  }
}

process.exit(0);
