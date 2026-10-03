import { describe, expect, test } from "bun:test";
import { isAskMessage, itemForThread, reactionAnswerText, reactionVerdict } from "./inbox-answers";

describe("Leon's answers in Discord", () => {
  test.each([
    ["👍", "yes"],
    ["👍🏽", "yes"],
    ["✅", "yes"],
    ["👎", "no"],
    ["❌", "no"],
    ["❤️", null],
    ["🎉", null],
    [null, null],
  ] as const)("reaction %s → %s", (emoji, want) => expect(reactionVerdict(emoji)).toBe(want));

  test("only the bot's questions to Leon count", () => {
    expect(
      isAskMessage("<@311400587445141504> I need to ask DevLeon about this: chum buckets only last 5 minutes."),
    ).toBe(true);
    expect(isAskMessage("I need to wait for DevLeon to continue this task.")).toBe(false);
    expect(isAskMessage("Thanks for the snapshots! Picked forage now disappears.")).toBe(false);
  });

  test("the answer note says what the reaction means and quotes the question without the ping", () => {
    const text = reactionAnswerText(
      "yes",
      "👍",
      "<@311400587445141504> I need to ask DevLeon about this: is it worth it? Recommendation: yes.",
      "devleon",
    );
    expect(text).toBe(
      "devleon answered with 👍 on Discord: YES - go with the recommendation.\nQuestion: I need to ask DevLeon about this: is it worth it? Recommendation: yes.",
    );
    expect(reactionAnswerText("no", "👎", "q", "devleon")).toContain("NO");
  });

  test("finds the thread's item by fingerprint, then by data.threadId", () => {
    const items = [
      { id: 1, fingerprint: "forum:111", status: "done", data: null },
      { id: 2, fingerprint: "manual:x", status: "needs_leon", data: JSON.stringify({ threadId: "222" }) },
      { id: 3, fingerprint: "ticket:333", status: "needs_leon", data: null },
    ];
    expect(itemForThread(items, "111")?.id).toBe(1);
    expect(itemForThread(items, "222")?.id).toBe(2);
    expect(itemForThread(items, "333")?.id).toBe(3);
    expect(itemForThread(items, "999")).toBeNull();
  });
});
