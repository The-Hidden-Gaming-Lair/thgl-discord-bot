import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { batchBody, looksLikeSupport } from "./channel-support";
import { feedbackComment, parseFeedbackId } from "./inbox-feedback";
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
  ])("needs help: %s", (text) => expect(looksLikeSupport(text)).toBe(true));

  test.each([
    "lol",
    "ty!",
    "same here",
    "gg everyone, great run today",
    "just got my first legendary drop yesterday",
    "https://cdn.discordapp.com/attachments/1/2/image.png",
    "<:pog:123456789012345678> <:pog:123456789012345678>",
  ])("chat: %s", (text) => expect(looksLikeSupport(text)).toBe(false));
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
    expect(parseFeedbackId("ifb:42:123456789012345678:s")).toEqual({
      itemId: 42,
      userId: "123456789012345678",
      solved: true,
    });
    expect(parseFeedbackId("ifb:42:123456789012345678:n")?.solved).toBe(false);
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
    const labels = [...src.matchAll(/input\("\w+", "([^"]+)"/g), ...src.matchAll(/setTitle\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(labels.length).toBe(6);
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(45);
  });

  test("Reported by marker", () => {
    expect(reportedBy("Reported by <@123456789012345678> in <#555>:\n> text")).toBe("123456789012345678");
    expect(reportedBy("Reported by <@!123456789012345678>")).toBe("123456789012345678");
    expect(reportedBy("a normal post by a member")).toBeNull();
  });
});
