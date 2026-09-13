import { initDiscord, getClient } from "../lib/discord";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { CENTRAL_UPDATES_CHANNEL_ID } from "../lib/game-roles";
import { writeFileSync, readFileSync } from "node:fs";

/**
 * Spam bots enumerate channels by Discord's raw `position` field (a per-category
 * sort key with no category grouping), take the first writable ones and post there.
 * "Apps & Games" children own positions 0..46 (games-provision renumbers them on
 * every sync), so #thgl-companion-app sits at raw 2 while the honeypot — created
 * last in the top category, which owns 9..11 — sits at raw 11, i.e. 10th writable.
 *
 * This moves the trap to raw position 0 so it is the FIRST writable channel in
 * that ordering too (it already is in display order). Positions only: no parent,
 * no permission overwrites, no other channel is touched.
 *
 *   bun run scripts/fix-trap-position.ts            # dry run
 *   bun run scripts/fix-trap-position.ts --apply    # apply + verify
 *   bun run scripts/fix-trap-position.ts --revert <snapshot.json>
 */

const TRAP_CHANNEL_ID = process.env.TRAP_CHANNEL_ID ?? "1542957161494093909";
const TARGET_POSITION = 0;
const apply = process.argv.includes("--apply");
const revertFile = process.argv[process.argv.indexOf("--revert") + 1];
const revert = process.argv.includes("--revert");

await initDiscord();
const client = getClient();
const guild = (client.channels.cache.get(CENTRAL_UPDATES_CHANNEL_ID) as any).guild;
await guild.channels.fetch();
const everyone = guild.roles.everyone;

const TEXTLIKE = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

function writable(c: any) {
  const p = c.permissionsFor(everyone);
  return (
    (p?.has(PermissionFlagsBits.ViewChannel) ?? false) &&
    (p?.has(PermissionFlagsBits.SendMessages) ?? false)
  );
}

/** The bots' ordering: every text-like channel sorted by raw position, writable only. */
function writableByRawPosition() {
  return [...guild.channels.cache.values()]
    .filter((c: any) => TEXTLIKE.has(c.type) && writable(c))
    .sort((a: any, b: any) => a.rawPosition - b.rawPosition) as any[];
}

function report(label: string) {
  const ranked = writableByRawPosition();
  const rank = ranked.findIndex((c) => c.id === TRAP_CHANNEL_ID) + 1;
  const trap = guild.channels.cache.get(TRAP_CHANNEL_ID) as any;
  console.log(`\n--- ${label} ---`);
  console.log(`trap #${trap.name}: rawPosition=${trap.rawPosition}, rank among writable = ${rank}/${ranked.length}`);
  console.log("first 5 writable by raw position (= what the bots hit):");
  ranked.slice(0, 5).forEach((c, i) => console.log(`  ${i + 1}. raw=${c.rawPosition} #${c.name}`));
  return rank;
}

const trap = guild.channels.cache.get(TRAP_CHANNEL_ID) as any;
if (!trap) throw new Error(`Trap channel ${TRAP_CHANNEL_ID} not found`);

// Snapshot every sibling in the trap's category so the change is fully reversible.
const siblings = [...guild.channels.cache.values()].filter(
  (c: any) => c.parentId === trap.parentId,
) as any[];

if (revert) {
  if (!revertFile) throw new Error("--revert needs a snapshot file path");
  const snap = JSON.parse(readFileSync(revertFile, "utf8")) as { id: string; position: number; name: string }[];
  console.log(`Reverting ${snap.length} channel position(s) from ${revertFile}`);
  await guild.channels.setPositions(snap.map((s) => ({ channel: s.id, position: s.position })));
  await guild.channels.fetch();
  report("after revert");
  process.exit(0);
}

report("BEFORE");
console.log(`\ncategory "${trap.parent?.name}" siblings (positions that may be renumbered by Discord):`);
for (const c of siblings.sort((a, b) => a.rawPosition - b.rawPosition)) {
  console.log(`  raw=${c.rawPosition} #${c.name} (${c.id})`);
}

if (!apply) {
  console.log(`\nDRY RUN — would set #${trap.name} to position ${TARGET_POSITION}.`);
  console.log("Visible effect: the trap moves to the top of its category (above #📜・rules).");
  console.log("Nothing else changes: same category, same permissions, no other category touched.");
  console.log("Re-run with --apply to perform it.");
  process.exit(0);
}

const snapshotPath = `trap-position-snapshot-${Date.now()}.json`;
writeFileSync(
  snapshotPath,
  JSON.stringify(siblings.map((c) => ({ id: c.id, name: c.name, position: c.rawPosition })), null, 2),
);
console.log(`\nSnapshot written: ${snapshotPath}`);

await guild.channels.setPositions([{ channel: TRAP_CHANNEL_ID, position: TARGET_POSITION }]);
await guild.channels.fetch();
const rank = report("AFTER");

if (rank === 1) {
  console.log("\n✔ The trap is now the first writable channel in the bots' ordering.");
} else {
  console.log(`\n✖ FAILED: trap is still rank ${rank}. Revert with:`);
  console.log(`   bun run scripts/fix-trap-position.ts --revert ${snapshotPath}`);
}
process.exit(0);
