import { initDiscord } from "../lib/discord";
import { getAppUpdatesMessages } from "../lib/app-updates-cache";
import { getGameConfig } from "../lib/game-roles";

/**
 * Test script to verify game matching logic works correctly
 */

await initDiscord();

console.log("\n=== Testing Game Matching Logic ===\n");

// Get messages from app-updates channel
const messages = await getAppUpdatesMessages();
console.log(`Found ${messages.length} messages in app-updates channel\n`);

// Test matching for specific games
const gamesToTest = [
  "dune-awakening",
  "blue-protocol-star-resonance",
  "infinity-nikki",
  "satisfactory",
];

for (const gameName of gamesToTest) {
  console.log(`\n--- Testing ${gameName} ---`);
  const gameConfig = getGameConfig(gameName);

  if (!gameConfig) {
    console.log(`  ⚠️ No config found for ${gameName}`);
    continue;
  }

  console.log(`  Keywords: ${gameConfig.titleKeywords?.join(", ")}`);

  let matchCount = 0;
  for (const message of messages) {
    // Check title matching
    const content = message.content || message.cleanContent || "";
    const title = content.split("\n")[0].toLowerCase();

    const hasKeywordMatch = gameConfig.titleKeywords?.some((keyword) =>
      title.includes(keyword)
    );

    if (hasKeywordMatch) {
      matchCount++;
      console.log(
        `  ✓ Match found: "${title.substring(0, 60)}..."`
      );
      if (matchCount >= 3) break; // Show max 3 examples
    }
  }

  if (matchCount === 0) {
    console.log(`  ✗ No matches found`);
  } else {
    console.log(`  Total matches: ${matchCount}`);
  }
}

console.log("\n=== All messages in app-updates (first 10) ===\n");
for (let i = 0; i < Math.min(10, messages.length); i++) {
  const message = messages[i];
  const content = message.content || message.cleanContent || "";
  const title = content.split("\n")[0];
  console.log(`${i + 1}. ${title.substring(0, 80)}`);

  // Check for role mentions
  if (message.mentions.roles.size > 0) {
    const roles = Array.from(message.mentions.roles.values())
      .map((r) => r.name)
      .join(", ");
    console.log(`   Roles: ${roles}`);
  }
}

process.exit(0);
