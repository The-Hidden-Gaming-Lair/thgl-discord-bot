import assert from "node:assert/strict";
import { rule0Decision } from "../lib/spam-guard";

// Pure-logic assertions for Rule 0's decision table. No token needed:
//   bun run scripts/test-spam-guard.ts

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 13);
const MEMBER_ROLES = new Set(["role-avowed", "role-palia", "role-coding"]);

type Input = Parameters<typeof rule0Decision>[0];

/** An established, role-holding, chatty member posting the spam signature. */
function base(overrides: Partial<Input> = {}): Input {
  return {
    imageCount: 4,
    attachmentCount: 4,
    content: "",
    joinedAt: NOW - 400 * DAY,
    hasMember: true,
    roleIds: ["role-avowed"],
    knownMemberRoleIds: MEMBER_ROLES,
    hadHistory: true,
    now: NOW,
    ...overrides,
  };
}

// --- signature detection ---
assert.equal(rule0Decision(base({ imageCount: 2, attachmentCount: 2 })), null, "2 images is not a burst");
assert.equal(rule0Decision(base({ content: "look at this" })), null, "images with text are not a burst");
assert.equal(rule0Decision(base({ imageCount: 0, attachmentCount: 0, content: "hi" })), null, "plain chat");
assert.deepEqual(
  rule0Decision(base({ joinedAt: NOW - DAY })),
  { rule: "Image burst", gate: "new member" },
  "3+ textless images from a fresh member",
);
assert.deepEqual(
  rule0Decision(
    base({ imageCount: 0, attachmentCount: 0, content: "discord.gg/QyKrtC2ke", joinedAt: NOW - DAY }),
  ),
  { rule: "Invite link", gate: "new member" },
  "bare invite from a fresh member",
);
assert.equal(
  rule0Decision(base({ imageCount: 0, attachmentCount: 0, content: "join us at discord.gg/x for more", joinedAt: NOW - DAY })),
  null,
  "an invite inside a sentence is not the signature",
);
assert.equal(
  rule0Decision(base({ imageCount: 0, attachmentCount: 1, content: "discord.gg/x", joinedAt: NOW - DAY })),
  null,
  "invite rule only covers attachment-free messages",
);

// --- leg 1: join age (the only gate that acts without a history check) ---
assert.equal(rule0Decision(base({ joinedAt: NOW - 6 * DAY }))?.gate, "new member");
assert.equal(
  rule0Decision(base({ joinedAt: NOW - 6 * DAY, hadHistory: true }))?.gate,
  "new member",
  "a fresh member's history does not save them",
);
assert.equal(
  rule0Decision(base({ joinedAt: NOW - 8 * DAY })),
  null,
  "8d-old member with roles + history is left alone",
);

// --- history is what protects an established account ---
assert.equal(rule0Decision(base({ hadHistory: true })), null, "onboarded + has posted");
assert.equal(
  rule0Decision(base({ roleIds: [], hadHistory: true })),
  null,
  "no onboarding role but has posted here: left alone",
);

// --- leg 2: no onboarding role, never posted ---
assert.deepEqual(
  rule0Decision(base({ roleIds: [], hadHistory: false })),
  { rule: "Image burst", gate: "no onboarding role" },
  "no roles at all and silent",
);
assert.equal(
  rule0Decision(base({ roleIds: ["role-coding"], hadHistory: false }))?.gate,
  "review",
  "a non-game onboarding role (Coding/Development) still marks a real member",
);
assert.equal(
  rule0Decision(base({ roleIds: ["role-patreon-only"], hadHistory: false }))?.gate,
  "no onboarding role",
  "a role we do not know is not proof of onboarding (ban path, hence the history requirement)",
);

// --- fail-safes: never act on missing data ---
assert.equal(
  rule0Decision(base({ roleIds: [], hadHistory: false, knownMemberRoleIds: new Set() }))?.gate,
  "review",
  "role set not loaded yet: downgrade to review, never ban",
);
assert.equal(
  rule0Decision(base({ hasMember: false, roleIds: [], joinedAt: null, hadHistory: false }))?.gate,
  "review",
  "no member object: downgrade to review, never ban",
);

// --- leg 3: review ---
assert.deepEqual(
  rule0Decision(base({ hadHistory: false })),
  { rule: "Image burst", gate: "review" },
  "onboarded member with no history is reviewed, not banned",
);
assert.equal(
  rule0Decision(base({ joinedAt: NOW - DAY, roleIds: [], hadHistory: false }))?.gate,
  "new member",
  "leg 1 outranks the rest",
);

console.log("✔ spam-guard Rule 0 decision table: all assertions passed");
