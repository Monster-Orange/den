/**
 * WS-6 (0.4.3), the pure parts of focus, status and switch
 * (public/workspace-status.js): status from services (WS-6.3), the chip's
 * "n down in <ws>" (WS-6.5), the menu's order (WS-6.6), what Switch and
 * Stop & Switch do (WS-6.7, WS-6.8) and the Workspaces settings (WS-6.10).
 */
import { describe, expect, it } from "@jest/globals";
import {
  agentsByWorkspace,
  awayDown,
  awayText,
  focusLabel,
  menuRows,
  pickAction,
  pillText,
  stopCount,
  summaryParts,
  statusesOf,
  stoppedAsQuiet,
  switchPlan,
  switchPrefs,
  workspaceStatus,
  wsDot,
} from "../../../src/ui/server/public/workspace-status.js";

const row = (
  repo: string,
  workspaces: string[],
  o: {
    ok?: boolean | null;
    running?: boolean;
    runs?: string;
    inView?: boolean;
  } = {},
) => ({
  repo,
  service: repo,
  address: repo,
  ok: o.ok ?? null,
  running: o.running ?? o.ok === true,
  runs: o.runs ?? "local",
  workspaces,
  inView: o.inView ?? true,
});

// north: notes (up), api (shared with south, up), wiki (stopped)
// south: blog (running, down), api
// east: docs (stopped)
const ROWS = [
  row("notes", ["north"], { ok: true }),
  row("api", ["north", "south"], { ok: true }),
  row("wiki", ["north"], { ok: false, running: false }),
  row("blog", ["south"], { ok: false, running: true, inView: false }),
  row("docs", ["east"], { ok: false, running: false, inView: false }),
  row("cdn", ["north"], { runs: "remote", ok: true }),
];

describe("WS-6.3: status is derived from services", () => {
  it("Running n/m, Partial n/m or Stopped, and a down count", () => {
    expect(workspaceStatus(ROWS, "north")).toEqual({
      n: 3,
      up: 2,
      down: 0,
      state: "partial",
    });
    expect(workspaceStatus(ROWS, "south")).toEqual({
      n: 2,
      up: 2,
      down: 1,
      state: "running",
    });
    expect(workspaceStatus(ROWS, "east")).toEqual({
      n: 1,
      up: 0,
      down: 0,
      state: "stopped",
    });
    expect(pillText(workspaceStatus(ROWS, "north"))).toBe("Partial 2/3");
    expect(pillText(workspaceStatus(ROWS, "south"))).toBe("Running 2/2");
    expect(pillText(workspaceStatus(ROWS, "east"))).toBe("Stopped");
  });

  it("a stopped service is never down, and a remote one isn't counted", () => {
    // wiki and docs fail their checks but don't run: stopped, not down.
    expect(workspaceStatus(ROWS, "east").down).toBe(0);
    expect(wsDot(workspaceStatus(ROWS, "east"))).toBe("off");
    expect(wsDot(workspaceStatus(ROWS, "south"))).toBe("bad");
    expect(wsDot(workspaceStatus(ROWS, "north"))).toBe("warn");
    // cdn is remote: north counts 3, not 4.
    expect(workspaceStatus(ROWS, "north").n).toBe(3);
    expect(pillText(workspaceStatus([], "north"))).toBe("Not checked");
  });

  it("sums the workspaces for All workspaces", () => {
    const s = summaryParts(statusesOf(ROWS, ["north", "south", "east"]));
    expect(s).toEqual({
      text: "1 running · 1 partial · 1 stopped",
      down: 1,
    });
  });
});

describe("WS-6.3: a service whose process died without down (0.4.5)", () => {
  // The server sends running: false, down: true for a record whose process
  // is gone and whose check fails: it doesn't run, and it is down.
  const crashed = {
    ...row("blog", ["north"], { ok: false, running: false }),
    down: true,
  };
  const rows = [
    row("notes", ["north"], { ok: true }),
    row("api", ["north"], { ok: true }),
    crashed,
  ];

  it("counts as not running and down: Partial 2/3 · 1 down", () => {
    expect(workspaceStatus(rows, "north")).toEqual({
      n: 3,
      up: 2,
      down: 1,
      state: "partial",
    });
  });

  it("Switch and Stop & Switch start it", () => {
    expect(switchPlan("north", rows, []).starts).toEqual(["blog"]);
  });
});

describe("WS-6.3: a stopped service reads as stopped, not failing (0.4.5)", () => {
  it("stoppedAsQuiet: a stopped service's failing check is no verdict", () => {
    const mail = (service: string) => ({
      ...row("mail", ["south", "west"], { ok: false, running: false }),
      service,
      address: `mail/${service}`,
    });
    const crashed = {
      ...row("blog", ["north"], { ok: false, running: false }),
      down: true,
    };
    const q = stoppedAsQuiet([
      mail("web"),
      mail("worker"),
      crashed,
      row("notes", ["north"], { ok: true }),
    ]);
    expect([...q.stopped]).toEqual(["mail/web", "mail/worker"]);
    expect(q.rows.map((r) => [r.repo, r.ok])).toEqual([
      ["mail", null],
      ["mail", null],
      ["blog", false],
      ["notes", true],
    ]);
  });
});

describe("WS-6.5: problems outside the focus", () => {
  it("counts down services outside the focus, by workspace", () => {
    const a = awayDown(ROWS);
    expect(a).toEqual({ n: 1, ws: "south", by: { south: 1 } });
    expect(awayText(a)).toBe(" · 1 down in south");
    expect(awayText(awayDown(ROWS.filter((r) => r.repo !== "blog")))).toBe("");
  });
});

describe("WS-6.6: the Workspace menu's order", () => {
  it("the focus first (✓), then All, then the rest", () => {
    expect(menuRows("south", ["north", "south", "east"])).toEqual([
      { value: "south", checked: true, sep: true },
      { value: "all", checked: false },
      { value: "north", checked: false },
      { value: "east", checked: false },
    ]);
  });
  it("All first and checked when the focus is all", () => {
    expect(menuRows("all", ["north", "south"]).map((r) => r.value)).toEqual([
      "all",
      "north",
      "south",
    ]);
    expect(menuRows("all", ["north"])[0].checked).toBe(true);
    expect(focusLabel("all", ["north"])).toBe("All workspaces");
    expect(focusLabel("north", ["north"])).toBe("north");
    // A focus not on this machine reads All workspaces.
    expect(focusLabel("gone", ["north"])).toBe("All workspaces");
  });
});

describe("WS-6.7, WS-6.8: what Switch and Stop & Switch do", () => {
  const sessions = [
    { workspace: "south", state: "running", exited: false },
    { workspace: "south", state: "ended", exited: true },
    { workspace: "east", state: "stopped", exited: false },
    { workspace: "north", state: "running", exited: false },
  ];

  it("Switch starts the target's services that aren't running", () => {
    const p = switchPlan("north", ROWS, []);
    expect(p.starts).toEqual(["wiki"]);
  });

  it("Stop & Switch stops other workspaces' services, never a shared repo's or a session", () => {
    const p = switchPlan("north", ROWS, sessions);
    // blog runs in south and north lacks it: stopped. api is shared: kept.
    expect(p.stops).toEqual([
      { workspace: "south", addresses: ["blog"], repos: ["blog"] },
    ]);
    expect(stopCount(p)).toBe(1);
    expect(p.keeps).toEqual([{ repo: "api", with: ["south"] }]);
    // Agents keep running: south's one running session (not the ended
    // one, nor north's own).
    expect(p.agents).toEqual([{ workspace: "south", n: 1 }]);
  });

  it("counts running agents and sessions per workspace", () => {
    expect(agentsByWorkspace(sessions)).toEqual({ south: 1, north: 1 });
  });
});

describe("WS-6.10: what picking does", () => {
  it("just shows it by default; asks or switches when set; All only shows", () => {
    expect(pickAction(undefined, 2, "north")).toBe("show");
    expect(pickAction("ask", 2, "north")).toBe("ask");
    expect(pickAction("switch", 2, "north")).toBe("switch");
    expect(pickAction("switch", 2, "all")).toBe("show");
    // Nothing to start: only shows.
    expect(pickAction("ask", 0, "north")).toBe("show");
  });
  it("defaults: Just show it, and confirm Stop & Switch", () => {
    expect(switchPrefs(undefined)).toEqual({
      on_pick: "show",
      confirm_stop_switch: true,
    });
    expect(
      switchPrefs({ on_pick: "bogus", confirm_stop_switch: false }),
    ).toEqual({
      on_pick: "show",
      confirm_stop_switch: false,
    });
  });
});
