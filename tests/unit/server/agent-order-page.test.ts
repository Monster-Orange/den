/**
 * Issue 96: where a move on the Agents page goes (public/agent-order.js).
 * A row moves inside its group: the same project, and the same side of
 * the list (running, or Stopped).
 */
import { describe, expect, it } from "@jest/globals";
import {
  dropTo,
  orderable,
  orderGroup,
  orderTo,
} from "../../../src/ui/server/public/agent-order.js";

type Row = { kind: string; agent?: string; workspace: string; off?: boolean };
const a = (agent: string, workspace = "north", off = false): Row => ({
  kind: "agent",
  agent,
  workspace,
  off,
});
const rows: Row[] = [
  a("scout"),
  { kind: "session", workspace: "north" },
  a("pilot", "south"),
  a("coder"),
  a("old", "north", true),
  a("fixer"),
  a("older", "north", true),
];
const off = (r: Row) => !!r.off;

describe("a row's group", () => {
  it("its project's agents on its side of the list, in the shown order", () => {
    expect(orderGroup(rows, a("coder"), off)).toEqual([
      "scout",
      "coder",
      "fixer",
    ]);
    expect(orderGroup(rows, a("old", "north", true), off)).toEqual([
      "old",
      "older",
    ]);
    expect(
      orderGroup(rows, { kind: "session", workspace: "north" }, off),
    ).toEqual([]);
  });

  it("the server agent's folder and plain sessions don't move", () => {
    expect(orderable(a("scout"), "den-server")).toBe(true);
    expect(orderable(a("srv", "den-server"), "den-server")).toBe(false);
    expect(
      orderable({ kind: "session", workspace: "north" }, "den-server"),
    ).toBe(false);
    expect(orderable(null, "den-server")).toBe(false);
  });
});

describe("where a move goes", () => {
  const ids = ["scout", "coder", "fixer"];
  it("up, down and top are next to a neighbour in the group", () => {
    expect(orderTo(ids, "coder", "up")).toEqual({ before: "scout" });
    expect(orderTo(ids, "coder", "down")).toEqual({ after: "fixer" });
    expect(orderTo(ids, "fixer", "top")).toEqual({ before: "scout" });
  });
  it("nothing past either end, nor for one not in the group", () => {
    expect(orderTo(ids, "scout", "up")).toBeNull();
    expect(orderTo(ids, "scout", "top")).toBeNull();
    expect(orderTo(ids, "fixer", "down")).toBeNull();
    expect(orderTo(ids, "pilot", "up")).toBeNull();
    expect(orderTo(ids, "coder", "sideways")).toBeNull();
  });
  it("a drop: before or after the row it lands on; none where nothing changes", () => {
    expect(dropTo(ids, "fixer", "scout", false)).toEqual({ before: "scout" });
    expect(dropTo(ids, "scout", "fixer", true)).toEqual({ after: "fixer" });
    expect(dropTo(ids, "scout", "coder", false)).toBeNull();
    expect(dropTo(ids, "coder", "scout", true)).toBeNull();
    expect(dropTo(ids, "coder", "coder", true)).toBeNull();
    expect(dropTo(ids, "pilot", "coder", true)).toBeNull();
  });
});
