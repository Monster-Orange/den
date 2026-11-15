/**
 * D79 (den#96): a project's agents in the person's order (agents/order.ts).
 */
import { describe, expect, it } from "@jest/globals";
import {
  inAgentOrder,
  moveInOrder,
  parseAgentOrder,
} from "../../../src/shared/agents/order.js";

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
  it("an agent not in the project is said", () => {
    expect(() => moveInOrder(shown, "z", "top")).toThrow(
      'no agent "z" in this project',
    );
  });
});
