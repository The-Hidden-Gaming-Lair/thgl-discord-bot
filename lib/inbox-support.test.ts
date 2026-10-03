import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { batchBody, channelScope, looksLikeSupport } from "./channel-support";
import { feedbackChannelText, feedbackComment, parseFeedbackId } from "./inbox-feedback";
import { reportedBy } from "./inbox-sync";

describe("game-channel support detection", () => {
  test.each([
    "the overlay doesn't show anything since the update",
    "How do I enable live mode in the companion app?",
    "is there a filter for chum buckets somewhere",
    "Palia map not working for me after the patch",
    "would be nice to have a marker for the plushies",
    "die Karte funktioniert nicht mehr seit heute",
    "the app crashes when I alt tab",
    "where are the fossil spots on the map",
    // Missed 2026-10-02 in #wuthering-waves ("missing" without is/are).
    "new map missing the new collectible Thousandfold Petals (coordinates on lower left 3948 1548 37)",
    "the markers for the new chests are all missing",
    "Thousandfold Petals missing from the map",
    "the new boss is not on the map yet",
    "there is no marker for the shrine in the new region",
  ])("needs help: %s", (text) => expect(looksLikeSupport(text)).toBe(true));

  test.each([
    "lol",
    "ty!",
    "same here",
    "gg everyone, great run today",
    "just got my first legendary drop yesterday",
    "https://cdn.discordapp.com/attachments/1/2/image.png",
    "<:pog:123456789012345678> <:pog:123456789012345678>",
    "missing you all, back from vacation tomorrow",
    "I was missing one piece for the set but finally got it",
  ])("chat: %s", (text) => expect(looksLikeSupport(text)).toBe(false));
});

describe("which channels are ours to answer in", () => {
  const games = [
    { id: "palia", discordId: "palia" },
    { id: "diablo4", discordId: "diablo4" },
    { id: "aniimo", discordId: "aniimo" },
  ];
  test("game channels map to their game (incl. legacy aliases)", () => {
    expect(channelScope("palia-map", games)).toBe("palia");
    expect(channelScope("diablo-iv-map", games)).toBe("diablo4");
    expect(channelScope("aniimo", games)).toBe("aniimo");
  });
  test("our own non-game channels are answered without a game", () => {
    expect(channelScope("thgl-companion-app", games)).toBeNull();
    expect(channelScope("other-games", games)).toBeNull();
  });
  test("other products' channels are never answered", () => {
    expect(channelScope("palia-tracker", games)).toBe("skip");
    expect(channelScope("diablo-iv-companion", games)).toBe("skip");
    expect(channelScope("new-world-companion", games)).toBe("skip");
    expect(channelScope("palia-map", [])).toBe("skip"); // games feed + fallback both empty: stay quiet
  });
});

describe("channel batch → inbox item", () => {
  test("one item per channel; detail lists every message; reply to the bot raises priority", () => {
    const msg = (id: string, toBot = false) => ({
      id,
      userId: "123456789012345678",
      username: "player",
      content: `question ${id}?`,
      url: `https://discord.com/channels/1/2/${id}`,
      at: 0,
      toBot,
      attachments: 0,
    });
    const ch = { id: "555", name: "palia-map", url: "https://discord.com/channels/1/555" };
    const plain = batchBody(ch, "palia", [msg("1"), msg("2")]);
    expect(plain).toMatchObject({
      fingerprint: "channel:555",
      source: "channel_message",
      appId: "palia",
      priority: 2,
      sourceUrl: "https://discord.com/channels/1/2/1",
    });
    expect(plain.detail).toContain("[1] player (<@123456789012345678>): question 1?");
    expect(plain.detail).toContain("[2] player");
    expect(plain.data.messages).toHaveLength(2);
    expect(batchBody(ch, null, [msg("3", true)]).priority).toBe(3);
  });
});

describe("feedback buttons + agent-opened forum posts", () => {
  test("custom ids", () => {
    // Older single "Yes, solved" button: verification not asked.
    expect(parseFeedbackId("ifb:42:123456789012345678:s")).toEqual({
      itemId: 42,
      userId: "123456789012345678",
      solved: true,
      verified: undefined,
      code: "s",
    });
    expect(parseFeedbackId("ifb:42:123456789012345678:v")).toMatchObject({ solved: true, verified: true });
    expect(parseFeedbackId("ifb:42:123456789012345678:u")).toMatchObject({ solved: true, verified: false });
    expect(parseFeedbackId("ifb:42:123456789012345678:n")?.solved).toBe(false);
    expect(parseFeedbackId("ifb:42:123456789012345678:x")).toBeNull();
    expect(parseFeedbackId("ifbm:42:123456789012345678:n", "ifbm")?.itemId).toBe(42);
    expect(parseFeedbackId("ifbm:42:123456789012345678:n")).toBeNull(); // wrong prefix
    expect(parseFeedbackId("ifb:done")).toBeNull();
    expect(parseFeedbackId("ticket:open")).toBeNull();
  });

  test("form answers become one log line; empty answers are left out", () => {
    expect(feedbackComment(true, "", "")).toBe("");
    expect(feedbackComment(true, "quick, but long text", "a Palia clock")).toBe(
      "How was the help: quick, but long text | Would like: a Palia clock",
    );
    expect(feedbackComment(false, "north map marker still missing", "")).toBe(
      "Still not working: north map marker still missing",
    );
  });

  test("form labels fit Discord's 45-character limit", () => {
    const src = readFileSync(join(import.meta.dir, "inbox-feedback.ts"), "utf8");
    // setTitle may pick between titles (verified vs not yet): every quoted string on that line counts.
    const titles = [...src.matchAll(/setTitle\(([^\n]+)\)/g)].flatMap((m) =>
      [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1]),
    );
    const labels = [...[...src.matchAll(/input\("\w+", "([^"]+)"/g)].map((m) => m[1]), ...titles];
    expect(labels.length).toBe(7);
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(45);
  });

  test("Reported by marker", () => {
    expect(reportedBy("Reported by <@123456789012345678> in <#555>:\n> text")).toBe("123456789012345678");
    expect(reportedBy("Reported by <@!123456789012345678>")).toBe("123456789012345678");
    expect(reportedBy("a normal post by a member")).toBeNull();
  });
});

describe("#user-feedback channel post", () => {
  test("quotes both answers, marks empty ones, never exceeds 2000 chars", () => {
    const text = feedbackChannelText({
      solved: false,
      userId: "123456789012345678",
      itemId: 18,
      title: "Suggestion: mined-out ore",
      where: "https://discord.com/channels/1/2/3",
      first: "still shows\nafter relog",
      second: "",
    });
    expect(text).toContain("❌ **Not solved** from <@123456789012345678> on #18");
    expect(text).toContain("> still shows\n> after relog");
    expect(text).toContain("**Could have done better:**\n> (empty)");
    expect(feedbackChannelText({ solved: true, userId: "1", itemId: 1, title: "t", where: "", first: "x".repeat(3000), second: "" }).length).toBeLessThanOrEqual(2000);
    const base = { solved: true, userId: "1", itemId: 7, title: "t", where: "", first: "", second: "" };
    expect(feedbackChannelText({ ...base, verified: true })).toStartWith("✅ **Solved** (checked it) from");
    expect(feedbackChannelText({ ...base, verified: false })).toStartWith("✅ **Solved** (not checked yet) from");
  });
});
