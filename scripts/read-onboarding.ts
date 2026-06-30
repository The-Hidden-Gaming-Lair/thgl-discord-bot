import { Routes } from "discord.js";
import { initDiscord, getClient, getChannel } from "../lib/discord";
import { CENTRAL_UPDATES_CHANNEL_ID } from "../lib/game-roles";

await initDiscord();
const client = getClient();
const guild = (getChannel(CENTRAL_UPDATES_CHANNEL_ID) as any).guild;
await guild.roles.fetch();

const roleName = (id: string) => guild.roles.cache.get(id)?.name ?? `?(${id})`;

// GET /guilds/{guild.id}/onboarding
const onboarding: any = await client.rest.get(Routes.guildOnboarding(guild.id));

console.log(`enabled: ${onboarding.enabled}  mode: ${onboarding.mode}`);
console.log(`default_channel_ids: ${onboarding.default_channel_ids?.length ?? 0}`);
console.log(`prompts: ${onboarding.prompts?.length ?? 0}\n`);

for (const prompt of onboarding.prompts ?? []) {
  console.log(`### PROMPT "${prompt.title}" (${prompt.id})`);
  console.log(`    type=${prompt.type} single_select=${prompt.single_select} required=${prompt.required} in_onboarding=${prompt.in_onboarding}`);
  console.log(`    options: ${prompt.options?.length ?? 0}`);
  for (const opt of prompt.options ?? []) {
    const roles = (opt.role_ids ?? []).map(roleName).join(", ") || "(no roles)";
    console.log(`      - "${opt.title}"  roles=[${roles}]  channels=${(opt.channel_ids ?? []).length}`);
  }
  console.log();
}

// Which game roles are NOT referenced by any onboarding option?
const referenced = new Set<string>();
for (const p of onboarding.prompts ?? [])
  for (const o of p.options ?? [])
    for (const r of o.role_ids ?? []) referenced.add(r);

console.log("=== Roles NOT in any onboarding option ===");
for (const role of [...guild.roles.cache.values()].sort((a: any, b: any) => a.name.localeCompare(b.name))) {
  if (role.name === "@everyone") continue;
  if (!referenced.has(role.id)) console.log(`  ${role.name} (${role.id})`);
}

process.exit(0);
