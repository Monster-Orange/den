/**
 * An idle agent got no Hub deliveries: Claude Code's "waiting for your
 * input" notice (sent when an agent sits idle after its turn) marks it
 * waiting, and Den held every delivery for a waiting agent, as it would
 * for one at a permission prompt. Typing into an idle agent is exactly
 * what a delivery should do. A permission prompt, an ask_human question
 * or a held Allow still holds it: typed text would answer them.
 */
import { describe, expect, it } from "@jest/globals";
import * as attention from "../../../src/ui/server/attention.js";

const typingHeld = (
  why: Map<string, string>,
  approvals: string[],
): Set<string> | undefined =>
  (
    attention as {
      typingHeld?: (w: Map<string, string>, a: Iterable<string>) => Set<string>;
    }
  ).typingHeld?.(why, approvals);

describe("which agents Den won't type into", () => {
  const why = new Map([
    ["idle", "input"],
    ["prompt", "permission"],
    ["asking", "asked"],
  ]);

  it("an idle agent (waiting for input) takes deliveries", () => {
    expect(typingHeld(why, [])?.has("idle")).toBe(false);
  });

  it("a permission prompt or an ask_human question holds them", () => {
    const held = typingHeld(why, []);
    expect(held?.has("prompt")).toBe(true);
    expect(held?.has("asking")).toBe(true);
  });

  it("a held Allow holds them, even when its hook said input", () => {
    const held = typingHeld(why, ["agent:idle", "agent:other", "person:p"]);
    expect([...(held ?? [])].sort()).toEqual(
      ["asking", "idle", "other", "prompt"].sort(),
    );
  });
});

/**
 * Issue 701: an ask_human question held the person's own comments, which
 * were its answer, for good. Delivery holds only on a dialog, a held Allow
 * or a pause; a question isn't one (its answer is what's delivered).
 */
const deliveryHeld = (
  why: Map<string, string>,
  approvals: string[],
  paused: string[] = [],
): Set<string> | undefined =>
  (
    attention as {
      deliveryHeld?: (
        w: Map<string, string>,
        a: Iterable<string>,
        p: Iterable<string>,
      ) => Set<string>;
    }
  ).deliveryHeld?.(why, approvals, paused);

describe("issue 701: which agents Hub deliveries wait for", () => {
  const why = new Map([
    ["idle", "input"],
    ["prompt", "permission"],
    ["asking", "asked"],
  ]);

  it("an agent that asked its person a question takes deliveries", () => {
    expect(deliveryHeld(why, [])?.has("asking")).toBe(false);
  });

  it("a permission prompt, a held Allow or a pause still holds them", () => {
    const held = deliveryHeld(why, ["agent:allow"], ["paused"]);
    expect([...(held ?? [])].sort()).toEqual(["allow", "paused", "prompt"]);
  });
});
