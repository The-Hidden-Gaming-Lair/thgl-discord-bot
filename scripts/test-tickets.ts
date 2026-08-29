import assert from "node:assert/strict";
import {
  computeInactivityAction,
  deriveActivity,
  formatTicketMarker,
  gameColor,
  isWarningMessage,
  matchGameSlug,
  parseTicketMarker,
  ticketThreadName,
  TICKET_DEFAULT_COLOR,
  TICKET_WARNING_FOOTER,
} from "../lib/tickets";

// --- marker ---
assert.equal(formatTicketMarker("311400587445141504"), "user:311400587445141504");
assert.equal(parseTicketMarker("user:311400587445141504"), "311400587445141504");
assert.equal(
  parseTicketMarker("Ticket for user:311400587445141504 (staff only)"),
  "311400587445141504",
);
assert.equal(parseTicketMarker("<@311400587445141504>"), null); // mention is not a marker
assert.equal(parseTicketMarker("user:abc"), null);
assert.equal(parseTicketMarker(""), null);
assert.equal(parseTicketMarker(null), null);
assert.equal(parseTicketMarker(undefined), null);

// --- names ---
assert.equal(ticketThreadName("devleon"), "devleon");
assert.equal(ticketThreadName("x".repeat(200)).length, 100); // Discord cap

// --- inactivity math (times in ms) ---
const HOUR = 3_600_000;
const base = { nowMs: 100 * HOUR, warnAfterMs: 10 * HOUR, closeAfterMs: 14 * HOUR };
// fresh activity -> nothing
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 95 * HOUR, warned: false }),
  "none",
);
// past warn threshold, not warned -> warn
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 89 * HOUR, warned: false }),
  "warn",
);
// past close threshold but never warned -> warn first, never silently close
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 80 * HOUR, warned: false }),
  "warn",
);
// warned but close threshold not reached -> none
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 89 * HOUR, warned: true }),
  "none",
);
// warned and past close threshold -> close
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 80 * HOUR, warned: true }),
  "close",
);
// exactly at threshold -> no action yet (boundary is exclusive)
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 90 * HOUR, warned: false }),
  "none",
);
assert.equal(
  computeInactivityAction({ ...base, lastActivityMs: 86 * HOUR, warned: true }),
  "none",
);

// --- warning detection ---
const warningMsg = {
  author: { bot: true },
  embeds: [{ footer: { text: TICKET_WARNING_FOOTER } }],
};
const normalBotMsg = { author: { bot: true }, embeds: [{ footer: { text: "user:1" } }] };
const userMsg = { author: { bot: false }, embeds: [] };
assert.equal(isWarningMessage(warningMsg), true);
assert.equal(isWarningMessage(normalBotMsg), false);
assert.equal(isWarningMessage(userMsg), false);

// --- deriveActivity: input is newest-first; warning embeds don't count as activity ---
// newest message is the warning -> warned, activity = message before it
const derived1 = deriveActivity(
  [
    { createdTimestamp: 90 * HOUR, isWarning: true },
    { createdTimestamp: 80 * HOUR, isWarning: false },
    { createdTimestamp: 70 * HOUR, isWarning: false },
  ],
  0,
);
assert.deepEqual(derived1, { lastActivityMs: 80 * HOUR, warned: true });
// user replied after a warning -> not warned anymore, clock reset
const derived2 = deriveActivity(
  [
    { createdTimestamp: 95 * HOUR, isWarning: false },
    { createdTimestamp: 90 * HOUR, isWarning: true },
  ],
  0,
);
assert.deepEqual(derived2, { lastActivityMs: 95 * HOUR, warned: false });
// no messages -> fallback (thread creation time), not warned
assert.deepEqual(deriveActivity([], 42), { lastActivityMs: 42, warned: false });
// all messages are warnings -> warned, activity falls back to thread creation time
assert.deepEqual(
  deriveActivity(
    [
      { createdTimestamp: 95 * HOUR, isWarning: true },
      { createdTimestamp: 85 * HOUR, isWarning: true },
    ],
    42,
  ),
  { lastActivityMs: 42, warned: true },
);

// --- game colors (staff idea 2026-08-29: color-code embeds per game) ---
assert.equal(gameColor(undefined), TICKET_DEFAULT_COLOR);
assert.equal(gameColor("  "), TICKET_DEFAULT_COLOR);
// different spellings of the same game map to the same slug -> same color
assert.equal(matchGameSlug("Palia"), matchGameSlug("palia map"));
assert.notEqual(matchGameSlug("Palia"), null);
assert.equal(gameColor("Palia"), gameColor("palia map"));
// distinct games get distinct colors (specific pair pinned)
assert.notEqual(gameColor("Palia"), gameColor("Avowed"));
// unmatched free text still yields a stable non-default color
assert.equal(gameColor("Some Unknown Game"), gameColor("some unknown game"));
// colors are valid 24-bit RGB ints
for (const text of ["Palia", "Avowed", "Some Unknown Game"]) {
  const color = gameColor(text);
  assert.ok(Number.isInteger(color) && color >= 0 && color <= 0xffffff);
}
// overly short/generic input never matches a game
assert.equal(matchGameSlug("a"), null);

console.log("All ticket helper tests passed ✔");
