/**
 * Issue 773: the kit's one sort rule for who needs the person
 * (packages/den-ui/src/attention.js), shared by Den's Agents page and bell
 * and Hub's Now view. The rules table of the approved mock, one test per
 * row that the kit owns: Order, Counts, and the state of an agent.
 */
import { describe, expect, it } from "@jest/globals";
import {
  ATTENTION_STATES,
  ATTENTION_TABLE,
  attentionCounts,
  attentionState,
  attentionTable,
  compareAttention,
  sortByAttention,
} from "../../../packages/den-ui/src/attention.js";

const T = (m: number) => new Date(Date.UTC(2026, 10, 20, 10, m)).toISOString();

describe("issue 773: the attention table is data", () => {
  it("four states, ranked Needs you 4, Done 3, Working 2, Idle 1", () => {
    expect(ATTENTION_STATES).toEqual(["needs", "done", "working", "idle"]);
    expect(ATTENTION_STATES.map((s) => ATTENTION_TABLE[s].rank)).toEqual([
      4, 3, 2, 1,
    ]);
  });

  it("Counts: the rail counts Needs you only; the bell Needs you and Done", () => {
    expect(ATTENTION_TABLE.needs.rail).toBe(true);
    expect(ATTENTION_TABLE.done.rail).toBe(false);
    expect(ATTENTION_TABLE.needs.bell).toBe(true);
    expect(ATTENTION_TABLE.done.bell).toBe(true);
    expect(ATTENTION_TABLE.working.bell).toBe(false);
    expect(ATTENTION_TABLE.idle.bell).toBe(false);
    const c = attentionCounts([
      { state: "needs" },
      { state: "needs" },
      { state: "done" },
      { state: "working" },
      { state: "idle" },
    ]);
    expect(c).toEqual({
      needs: 2,
      done: 1,
      working: 1,
      idle: 1,
      rail: 2,
      bell: 3,
    });
  });

  it("a person's override changes one entry and keeps the rest (#780)", () => {
    const t = attentionTable({ done: { bell: false } });
    expect(t.done.bell).toBe(false);
    expect(t.done.rank).toBe(3);
    expect(t.needs).toEqual(ATTENTION_TABLE.needs);
    // The default table is never changed by an override.
    expect(ATTENTION_TABLE.done.bell).toBe(true);
    // Unknown states and fields are ignored.
    const u = attentionTable({ nope: { rank: 9 }, idle: { rank: "x" } });
    expect(u).toEqual(attentionTable());
  });
});

describe("issue 773: an agent's state", () => {
  it("Needs you over everything; then Working; then Done not seen; else Idle", () => {
    expect(attentionState({ needs: true, working: true, done: true })).toBe(
      "needs",
    );
    expect(attentionState({ working: true, done: true })).toBe("working");
    expect(attentionState({ done: true })).toBe("done");
    expect(attentionState({})).toBe("idle");
  });
});

describe("issue 773: Order", () => {
  it("blocked on you before waiting (Done), then oldest first, then name", () => {
    const items = [
      { id: "d-new", name: "alpha", state: "done", since: T(30) },
      { id: "n-new", name: "zed", state: "needs", since: T(20) },
      { id: "d-old", name: "beta", state: "done", since: T(5) },
      { id: "n-old", name: "yak", state: "needs", since: T(1) },
      { id: "n-tie-b", name: "bob", state: "needs", since: T(10) },
      { id: "n-tie-a", name: "amy", state: "needs", since: T(10) },
    ];
    expect(sortByAttention(items).map((i) => i.id)).toEqual([
      "n-old",
      "n-tie-a",
      "n-tie-b",
      "n-new",
      "d-old",
      "d-new",
    ]);
  });

  it("Needs you, then Done, then Working, then Idle; Working and Idle A to Z", () => {
    const items = [
      { id: "i2", name: "triage", state: "idle", since: T(0) },
      { id: "w2", name: "linter", state: "working", since: T(0) },
      { id: "i1", name: "Scribe", state: "idle", since: T(9) },
      { id: "d1", name: "builder", state: "done", since: T(1) },
      { id: "w1", name: "docs", state: "working", since: T(9) },
      { id: "n1", name: "planner", state: "needs", since: T(3) },
      { id: "w3", name: "tester", state: "working", since: T(1) },
    ];
    expect(sortByAttention(items).map((i) => i.id)).toEqual([
      "n1",
      "d1",
      "w1",
      "w2",
      "w3",
      "i1",
      "i2",
    ]);
  });

  it("same input, same order every time (ties on everything keep their id order)", () => {
    const items = [
      { id: "b", name: "same", state: "idle" },
      { id: "a", name: "same", state: "idle" },
      { id: "c", name: "same", state: "needs" },
    ];
    const once = sortByAttention(items).map((i) => i.id);
    const reversed = sortByAttention([...items].reverse()).map((i) => i.id);
    expect(once).toEqual(["c", "a", "b"]);
    expect(reversed).toEqual(once);
    // The input is left as it was.
    expect(items.map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("a wait with no time known goes after the ones that have one", () => {
    const items = [
      { id: "x", name: "a", state: "needs" },
      { id: "y", name: "b", state: "needs", since: T(40) },
    ];
    expect(sortByAttention(items).map((i) => i.id)).toEqual(["y", "x"]);
  });

  it("compareAttention is the comparator sortByAttention uses", () => {
    const a = { id: "a", name: "a", state: "needs", since: T(1) };
    const b = { id: "b", name: "b", state: "done", since: T(0) };
    expect(compareAttention(a, b)).toBeLessThan(0);
    expect(compareAttention(b, a)).toBeGreaterThan(0);
    expect(compareAttention(a, a)).toBe(0);
  });
});

describe("issue 773 (mock v3 rules): no person's order inside a band", () => {
  it("a saved place never moves a row: Working and Idle stay A to Z, Needs you and Done the longest wait first", () => {
    const items = [
      { id: "a", name: "alpha", state: "idle", group: "north", place: 1 },
      { id: "z", name: "zeta", state: "idle", group: "north", place: 0 },
      { id: "n2", name: "n2", state: "needs", since: T(9), place: 0 },
      { id: "n1", name: "n1", state: "needs", since: T(1), place: 1 },
      { id: "w", name: "worker", state: "working", group: "north", place: 3 },
      { id: "b", name: "beta", state: "working", group: "north", place: 0 },
    ];
    expect(sortByAttention(items).map((i) => i.id)).toEqual([
      "n1",
      "n2",
      "b",
      "w",
      "a",
      "z",
    ]);
  });
});
