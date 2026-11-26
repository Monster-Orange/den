/**
 * Issue 96: a project's agents in the person's order (agents/order.ts).
 */
import { describe, expect, it } from "@jest/globals";
import {
  agentOrderIn,
  inAgentOrder,
  mergeAgentOrder,
  moveInOrder,
  placeInOrder,
  parseAgentOrder,
  withAgentOrder,
} from "../../../src/shared/agents/order.js";
import type { UserConfig } from "../../../src/shared/den-config.js";

type Row = { ws: string; id?: string; startedAt?: string; label: string };
const row = (ws: string, id: string | undefined, startedAt: string): Row => ({
  ws,
  id,
  startedAt,
  label: id ?? "shell",
});
const key = (r: Row) =>
  r.id ? { ws: r.ws, id: r.id, startedAt: r.startedAt } : null;
const ids = (rs: Row[]) => rs.map((r) => r.label);

describe("the stored order", () => {
  it("keeps agent ids only, each once", () => {
    expect(parseAgentOrder(["b", "a", "b", 3, "../x", "c"])).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(parseAgentOrder("a,b")).toEqual([]);
  });
});

describe("a project's agents in its order", () => {
  const rows = [
    row("north", "scout", "2026-11-15T01:00:00Z"),
    row("north", "coder", "2026-11-15T02:00:00Z"),
    row("north", undefined, "2026-11-15T02:30:00Z"),
    row("north", "fixer", "2026-11-15T03:00:00Z"),
    row("south", "pilot", "2026-11-15T00:00:00Z"),
  ];

  it("no order saved: by start time", () => {
    expect(ids(inAgentOrder(rows, key, () => []))).toEqual([
      "scout",
      "coder",
      "shell",
      "fixer",
      "pilot",
    ]);
  });

  it("saved: its place first; a new agent at the bottom; a removed id leaves no gap; plain sessions and other projects stay put", () => {
    const orderOf = (ws: string) =>
      ws === "north" ? ["fixer", "gone", "scout"] : [];
    expect(ids(inAgentOrder(rows, key, orderOf))).toEqual([
      "fixer",
      "scout",
      "shell",
      "coder",
      "pilot",
    ]);
  });
});

describe("moving one", () => {
  const shown = ["a", "b", "c", "d"];
  it("up, down, top, bottom, a place", () => {
    expect(moveInOrder(shown, "c", "up")).toEqual(["a", "c", "b", "d"]);
    expect(moveInOrder(shown, "a", "up")).toEqual(shown);
    expect(moveInOrder(shown, "b", "down")).toEqual(["a", "c", "b", "d"]);
    expect(moveInOrder(shown, "d", "down")).toEqual(shown);
    expect(moveInOrder(shown, "c", "top")).toEqual(["c", "a", "b", "d"]);
    expect(moveInOrder(shown, "a", "bottom")).toEqual(["b", "c", "d", "a"]);
    expect(moveInOrder(shown, "d", 2)).toEqual(["a", "d", "b", "c"]);
    expect(moveInOrder(shown, "a", 99)).toEqual(["b", "c", "d", "a"]);
  });
  it("before or after another (a drop, or a move within the page's group)", () => {
    expect(moveInOrder(shown, "d", { before: "b" })).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
    expect(moveInOrder(shown, "a", { after: "c" })).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(moveInOrder(shown, "b", { before: "c" })).toEqual(shown);
    expect(moveInOrder(shown, "b", { after: "a" })).toEqual(shown);
  });
  it("an agent not in the project is said, moved or named", () => {
    expect(() => moveInOrder(shown, "z", "top")).toThrow(
      'no agent "z" in this project',
    );
    expect(() => moveInOrder(shown, "a", { before: "z" })).toThrow(
      'no agent "z" in this project',
    );
    expect(() => moveInOrder(shown, "a", { after: "a" })).toThrow(
      "an agent can't move next to itself",
    );
  });
});

describe("merging a stored order with the agents there now", () => {
  it("stored first by place; a new agent at the end; a removed or unknown id dropped", () => {
    expect(
      mergeAgentOrder(["fixer", "gone", "scout"], ["scout", "coder", "fixer"]),
    ).toEqual(["fixer", "scout", "coder"]);
    expect(mergeAgentOrder(["nobody", "../x", 7], ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
    expect(mergeAgentOrder(undefined, ["a", "b"])).toEqual(["a", "b"]);
    expect(mergeAgentOrder(["b", "a"], [])).toEqual([]);
  });
});

describe("the store: per person, in their user config", () => {
  it("each person's config has its own order; other projects and agents.* keys stay", () => {
    const ada: UserConfig = { agents: { layout: "tabs" } };
    const bo: UserConfig = {};
    const ada2 = withAgentOrder(ada, "north", ["c", "a", "b"]);
    const bo2 = withAgentOrder(bo, "north", ["b", "a"]);
    expect(agentOrderIn(ada2, "north")).toEqual(["c", "a", "b"]);
    expect(agentOrderIn(bo2, "north")).toEqual(["b", "a"]);
    // The input isn't changed; the layout pref is kept.
    expect(ada).toEqual({ agents: { layout: "tabs" } });
    expect((ada2.agents as { layout?: string }).layout).toBe("tabs");
    const both = withAgentOrder(ada2, "south", ["z"]);
    expect(agentOrderIn(both, "north")).toEqual(["c", "a", "b"]);
    expect(agentOrderIn(both, "south")).toEqual(["z"]);
  });

  it("[] clears it and leaves no empty block behind; a bad project name is refused", () => {
    const one = withAgentOrder({}, "north", ["a"]);
    expect(withAgentOrder(one, "north", [])).toEqual({});
    expect(() => withAgentOrder({}, "../etc", ["a"])).toThrow(
      "is not a project name",
    );
  });

  it("a hand-broken block reads as no order", () => {
    expect(agentOrderIn({ agents: { order: "a,b" } }, "north")).toEqual([]);
    expect(
      agentOrderIn({ agents: { order: { north: [1, "a", "a"] } } }, "north"),
    ).toEqual(["a"]);
  });
});

describe("issue 773 + issue 96: each agent's place, for the bands", () => {
  it("its index in its project's saved order; none when the person set none or it isn't listed", () => {
    const order: Record<string, string[]> = { north: ["zeta", "alpha"] };
    const of = (ws: string) => order[ws] ?? [];
    expect(placeInOrder(of, "north", "zeta")).toBe(0);
    expect(placeInOrder(of, "north", "alpha")).toBe(1);
    expect(placeInOrder(of, "north", "new")).toBeUndefined();
    expect(placeInOrder(of, "south", "zeta")).toBeUndefined();
  });
});
