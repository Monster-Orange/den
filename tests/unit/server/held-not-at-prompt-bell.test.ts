/**
 * Issue 664: text held because an agent isn't at its input prompt: the
 * bell says so once it has waited long enough, says it again while it
 * waits (how long, and why), and lets it go once it's typed. A fake store
 * and record; no server.
 */
import { describe, expect, it } from "@jest/globals";
import { heldBell } from "../../../src/ui/server/hub-delivery-service.js";
import type { AgentRecord } from "../../../src/shared/agents/records.js";

describe("issue 664: the bell's held-text item", () => {
  it("after the wait: one item that says why; again each minute; gone when typed", () => {
    const added: { subject: string; text: string; msg?: unknown }[] = [];
    const withdrawn: string[] = [];
    const store = {
      add: (n: { subject: string; text: string; msg?: unknown }) => {
        added.push(n);
        return null;
      },
      withdraw: (subject: string) => {
        withdrawn.push(subject);
        return true;
      },
    };
    const recOf = () =>
      ({
        id: "planner-1",
        persona: "planner",
        workspace: "north",
      }) as unknown as AgentRecord;
    const o = (now: number) => ({ store, recOf, now });
    heldBell("planner-1", 2, 30_000, 60, o(0));
    expect(added).toEqual([]);
    heldBell("planner-1", 2, 61_000, 60, o(31_000));
    expect(added).toHaveLength(1);
    expect(added[0].subject).toBe("record:not-at-prompt:planner-1");
    expect(added[0].text).toBe(
      "planner: 2 messages wait for 1 min. Waiting: the agent isn't at its prompt",
    );
    expect(added[0].msg).toEqual({
      key: "bell.m.notAtPrompt",
      vars: { name: "planner", n: 2, m: 1 },
    });
    // Within the minute: not said again.
    heldBell("planner-1", 2, 90_000, 60, o(60_000));
    expect(added).toHaveLength(1);
    heldBell("planner-1", 2, 181_000, 60, o(151_000));
    expect(added).toHaveLength(2);
    expect(added[1].text).toContain("for 3 min");
    heldBell("planner-1", 0, 0, 60, o(160_000));
    expect(withdrawn).toEqual(["record:not-at-prompt:planner-1"]);
  });
});
