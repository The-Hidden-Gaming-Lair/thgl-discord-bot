import { initDiscord } from "../lib/discord";
import { getAppUpdatesMessages } from "../lib/app-updates-cache";
import { GAME_CONFIGS } from "../lib/game-roles";

/**
 * Utility script to extract role IDs from messages in the app-updates channel
 * Run this script periodically after you start mentioning roles in messages
 * to build/update the roleIds mapping in lib/game-roles.ts
 */

await initDiscord();

console.log("\n=== Extracting Role IDs from App Updates ===\n");

const messages = await getAppUpdatesMessages();
console.log(`Analyzing ${messages.length} messages from app-updates channel\n`);

// Map to store role ID -> role name
const roleMap = new Map<string, string>();

// Collect all role mentions
for (const message of messages) {
  if (message.mentions.roles.size > 0) {
    for (const [roleId, role] of message.mentions.roles) {
      roleMap.set(roleId, role.name);
    }
  }
}

if (roleMap.size === 0) {
  console.log("❌ No role mentions found in app-updates channel yet.");
  console.log("\nOnce you start pinging roles in the app-updates channel, run this script again.");
  process.exit(0);
}

console.log(`Found ${roleMap.size} unique roles mentioned:\n`);

// Try to match roles to games
const gameRoleMapping: Record<string, string[]> = {};

for (const [roleId, roleName] of roleMap) {
  console.log(`- ${roleName} (${roleId})`);

  // Try to find matching game config
  const matchingGame = GAME_CONFIGS.find((game) => {
    // Try exact name match first
    if (game.name === roleName.toLowerCase().replace(/ /g, "-")) {
      return true;
    }

    // Try keyword match
    if (game.titleKeywords) {
      const lowerRoleName = roleName.toLowerCase();
      return game.titleKeywords.some((keyword) =>
        lowerRoleName.includes(keyword.toLowerCase())
      );
    }

    return false;
  });

  if (matchingGame) {
    if (!gameRoleMapping[matchingGame.name]) {
      gameRoleMapping[matchingGame.name] = [];
    }
    gameRoleMapping[matchingGame.name].push(roleId);
    console.log(`  → Matched to game: ${matchingGame.name}`);
  } else {
    console.log(`  ⚠️ No matching game found - manual mapping needed`);
  }
}

console.log("\n\n=== TypeScript Code to Add to lib/game-roles.ts ===\n");
console.log("Update the GAME_CONFIGS array by adding roleIds to the appropriate games:");
console.log("```typescript");

for (const [gameName, roleIds] of Object.entries(gameRoleMapping)) {
  console.log(`  // ${gameName}`);
  console.log(`  roleIds: [${roleIds.map((id) => `"${id}"`).join(", ")}],`);
  console.log();
}

console.log("```");

console.log("\n=== Verification ===");
console.log(
  "\nAfter updating lib/game-roles.ts, restart the bot to use role-based filtering."
);
console.log(
  "The API will then prioritize role mentions over title keywords for matching."
);

process.exit(0);
