import { initDiscord, getChannelMessages } from "../lib/discord";

/**
 * Debug script to see the structure of messages
 */

await initDiscord();

console.log("\n=== Checking app-updates channel ===");
const messages = await getChannelMessages("1166078913756270702", 5);

console.log(`Fetched ${messages.size} messages`);

for (const [id, message] of messages) {
  console.log("\n--- Message ---");
  console.log("Message ID:", message.id);
  console.log("Author:", message.author?.username);
  console.log("Timestamp:", message.createdTimestamp);
  console.log("All properties:", Object.keys(message));

  // Try to access different properties
  console.log("Content:", message.content);
  console.log("Clean content:", message.cleanContent);

  // Check mentions
  if (message.mentions) {
    console.log("Has mentions object: true");
    console.log("Mentions object keys:", Object.keys(message.mentions));
    if (message.mentions.roles) {
      console.log("Roles size:", message.mentions.roles.size);
      if (message.mentions.roles.size > 0) {
        for (const [id, role] of message.mentions.roles) {
          console.log(`  - Role: ${role.name} (${id})`);
        }
      }
    }
  } else {
    console.log("Has mentions object: false");
  }
}

process.exit(0);
