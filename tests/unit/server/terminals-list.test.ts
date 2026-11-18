/**
 * Issue 482 (model A): terminals get their own list. The list's rules
 * (public/terminals-list.js, no DOM): which rows each page shows, the
 * project filter, the order (running first, then exited, each by last
 * used, newest first), what a row says, which buttons it has, the
 * one-time "N shells moved" note on Agents, and the project a start goes
 * to when none is running. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  forPage,
  inProject,
  movedNote,
  rowActions,
  shellGroups,
  shellMeta,
  startProject,
} from "../../../src/ui/server/public/terminals-list.js";
import { shellUsedAt } from "../../../src/ui/server/public/shell-pick.js";

type Row = {
  id: string;
  kind: "agent" | "session";
  workspace: string;
  label: string;
  exited?: boolean;
  server?: boolean;
  startedAt?: string;
  inputAt?: string;
  folder?: string;
};
const at = (hhmm: string) => `2026-11-18T${hhmm}:00.000Z`;
const sh = (
  id: string,
  workspace: string,
  started: string,
  more: Partial<Row> = {},
): Row => ({
  id,
  kind: "session",
  workspace,
  label: id,
  startedAt: at(started),
  folder: `~/${workspace}`,
  ...more,
});
const ag = (id: string, workspace: string, more: Partial<Row> = {}): Row => ({
  id,
  kind: "agent",
  workspace,
  label: id,
  startedAt: at("09:00"),
  ...more,
});

const rows: Row[] = [
  ag("planner", "north"),
  sh("n1", "north", "10:00"),
  sh("n2", "north", "10:05", { inputAt: at("10:30") }),
  sh("n3", "north", "10:10", { exited: true }),
  ag("server", "__server__", { server: true }),
  sh("s1", "south", "10:20"),
  sh("s2", "south", "09:00", { exited: true, inputAt: at("11:00") }),
];

describe("issue 482: which rows each page lists (clause 1)", () => {
  it("Terminals: plain shells only, running or exited", () => {
    expect(forPage("terminals", rows).map((r) => r.id)).toEqual([
      "n1",
      "n2",
      "n3",
      "s1",
      "s2",
    ]);
  });
  it("Agents: agents only (the server agent too), never a plain shell", () => {
    expect(forPage("agents", rows).map((r) => r.id)).toEqual([
      "planner",
      "server",
    ]);
  });
});

describe("issue 482: the project filter (clause 2)", () => {
  it("one project: only its shells; All projects (null): every shell", () => {
    const shells = forPage("terminals", rows);
    expect(inProject(shells, "south").map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(inProject(shells, null)).toHaveLength(5);
  });
});

describe("issue 482: the order (mock v3, 'What the developers build')", () => {
  it("running first, then exited, each newest used first (shellUsedAt)", () => {
    const g = shellGroups(forPage("terminals", rows), {});
    expect(g.running.map((r) => r.id)).toEqual(["n2", "s1", "n1"]);
    expect(g.exited.map((r) => r.id)).toEqual(["s2", "n3"]);
  });
  it("this browser's own use counts, as it does for the rail (issue 448)", () => {
    const used = { n1: Date.parse(at("12:00")) };
    const g = shellGroups(forPage("terminals", rows), used);
    expect(g.running[0].id).toBe("n1");
    expect(g.running.map((r) => shellUsedAt(r, used))).toEqual(
      [...g.running.map((r) => shellUsedAt(r, used))].sort((a, b) => b - a),
    );
  });
});

describe("issue 482: what a row says (clause 2)", () => {
  it("All projects names the project; one project leaves it out", () => {
    const r = sh("n1", "north", "10:00", { folder: "~/north/api" });
    expect(shellMeta(r, { showProject: true, projName: (w) => w })).toBe(
      "north · ~/north/api",
    );
    expect(shellMeta(r, { showProject: false, projName: (w) => w })).toBe(
      "~/north/api",
    );
  });
  it("a project's own name, not its slug; no folder: the project alone", () => {
    const r = sh("n1", "north", "10:00", { folder: undefined });
    expect(
      shellMeta(r, { showProject: true, projName: () => "North Star" }),
    ).toBe("North Star");
  });
});

describe("issue 482: a row's buttons (clause 3)", () => {
  it("an exited shell: Restart and Remove; a running one: neither", () => {
    expect(rowActions(sh("x", "north", "10:00", { exited: true }))).toEqual([
      "restart",
      "remove",
    ]);
    expect(rowActions(sh("y", "north", "10:00"))).toEqual([]);
  });
});

describe("issue 482: the one-time note on Agents (clause 6)", () => {
  it("shown once, with how many shells moved; never again once seen", () => {
    expect(movedNote({ seen: false, shells: 3 })).toEqual({
      show: true,
      n: 3,
      markSeen: true,
    });
    expect(movedNote({ seen: true, shells: 3 })).toEqual({
      show: false,
      n: 3,
      markSeen: false,
    });
  });
  it("an install with no shells never shows it, and never will", () => {
    expect(movedNote({ seen: false, shells: 0 })).toEqual({
      show: false,
      n: 0,
      markSeen: true,
    });
  });
});

describe("issue 482: where a start goes with none running (clause 5)", () => {
  it("one project: that project", () => {
    expect(startProject(rows, "south", ["north", "south"], {})).toBe("south");
  });
  it("All projects: the project of the shell used last, exited ones too", () => {
    expect(startProject(rows, null, ["north", "south"], {})).toBe("south");
    const used = { n3: Date.parse(at("13:00")) };
    expect(startProject(rows, null, ["north", "south"], used)).toBe("north");
  });
  it("All projects, no shell ever: the first project", () => {
    expect(startProject([], null, ["north", "south"], {})).toBe("north");
    expect(startProject([], null, [], {})).toBe(null);
  });
});
