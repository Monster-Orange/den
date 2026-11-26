import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import type * as http from "http";
import * as os from "os";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { resetHelperCache } from "../../../src/shared/agents/claude-helpers.js";
import { helpersBlock } from "../../../src/shared/den-config.js";
import { rowHelpers } from "../../../src/ui/cli/agent-ops.js";
import { HelperRows } from "../../../src/ui/server/helper-rows.js";
import { handleSessionList } from "../../../src/ui/server/session-routes.js";
import { writeHelper } from "../agents/helpers/seed-helpers.js";

const AGENTS = 12;
let dir = "";
let stateDir = "";
const savedHome = process.env.HOME;
const token = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1668r-")));
  stateDir = path.join(dir, "state");
  const home = path.join(dir, "home");
  process.env.HOME = home;
  for (let i = 0; i < AGENTS; i++) {
    writeHelper(home, token(i), `a${String(i).padStart(16, "0")}`, "Look");
    writeRecord(stateDir, {
      id: `agent${i}`,
      persona: "builder",
      runtime: "den-claude",
      workspace: "north",
      cwd: dir,
      session: { backend: "den-pty", id: `gone-${i}` },
      sessionName: `acme-north:agent${i}`,
      startedAt: "2026-11-01T09:59:00.000Z",
      resumeToken: token(i),
    } as Parameters<typeof writeRecord>[1]);
  }
});

afterEach(() => {
  process.env.HOME = savedHome;
  resetHelperCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeRes() {
  let body = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(c: number) {
      res.statusCode = c;
    },
    end(b?: string) {
      body = b ?? "";
    },
  };
  return {
    res: res as unknown as http.ServerResponse,
    json: () =>
      JSON.parse(body) as {
        sessions: { agent?: string; helpers?: { total: number } }[];
      },
  };
}

function list(
  rows: HelperRows,
  compute: typeof rowHelpers,
  refreshSeconds = 30,
) {
  const r = fakeRes();
  const req = { method: "GET", url: "/api/sessions" } as http.IncomingMessage;
  return handleSessionList(req, r.res, "/api/sessions", true, {
    stateDir: () => stateDir,
    dist: () => "acme",
    activeWorkspaces: () => ["north"],
    connectExisting: async () => null,
    hubNow: async () => null,
    helperSettings: () => helpersBlock({ refresh_seconds: refreshSeconds }),
    helperRows: rows,
    rowHelpers: compute,
  }).then(() => r.json());
}

function counting(spinMs = 0) {
  const calls: string[] = [];
  const fn: typeof rowHelpers = (rec, ...rest) => {
    calls.push(rec.id);
    const end = Date.now() + spinMs;
    let spins = 0;
    while (Date.now() < end) spins++;
    expect(spins).toBeGreaterThanOrEqual(0);
    return rowHelpers(rec, ...rest);
  };
  return { calls, fn };
}

const totals = (j: Awaited<ReturnType<typeof list>>) =>
  j.sessions
    .filter((s) => s.agent)
    .map((s) => [s.agent, s.helpers?.total ?? 0])
    .sort();

describe("a session list reads helpers from the shared refresher", () => {
  it("a repeat list inside agents.helpers.refresh_seconds computes nothing", async () => {
    const rows = new HelperRows();
    const c = counting();
    const first = await list(rows, c.fn);
    expect(c.calls).toHaveLength(AGENTS);
    expect(totals(first)).toContainEqual(["agent3", 1]);
    c.calls.length = 0;
    const second = await list(rows, c.fn);
    expect(c.calls).toEqual([]);
    expect(totals(second)).toEqual(totals(first));
  });

  it("lists asked at the same time share one computation", async () => {
    const rows = new HelperRows();
    const c = counting();
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => list(rows, c.fn)));
    expect(c.calls).toHaveLength(AGENTS);
    for (const j of all) expect(totals(j)).toEqual(totals(all[0]));
  });

  it("the main thread is free between agents: a timer fires while a list computes", async () => {
    const rows = new HelperRows();
    const c = counting(25);
    const t0 = Date.now();
    let firedAt = 0;
    setTimeout(() => (firedAt = Date.now() - t0), 0);
    await list(rows, c.fn);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(AGENTS * 25);
    expect(firedAt).toBeGreaterThan(0);
    expect(firedAt).toBeLessThan(100);
  });

  it("a row older than refresh_seconds is served at once and refreshed behind", async () => {
    let now = 1_000_000;
    const rows = new HelperRows(() => now);
    const c = counting();
    await list(rows, c.fn);
    now += 31_000;
    c.calls.length = 0;
    const stale = await list(rows, c.fn);
    expect(c.calls).toEqual([]);
    expect(totals(stale)).toContainEqual(["agent3", 1]);
    await rows.idle();
    expect(c.calls).toHaveLength(AGENTS);
  });

  it("refresh_seconds 0: every list computes its rows", async () => {
    const rows = new HelperRows();
    const c = counting();
    await list(rows, c.fn, 0);
    await list(rows, c.fn, 0);
    expect(c.calls).toHaveLength(2 * AGENTS);
  });

  it("an agent's new helper shows on the next list once its row is refreshed", async () => {
    let now = 1_000_000;
    const rows = new HelperRows(() => now);
    const c = counting();
    await list(rows, c.fn);
    writeHelper(
      path.join(dir, "home"),
      token(3),
      "b0000000000000003",
      "Look again",
    );
    now += 31_000;
    await list(rows, c.fn);
    await rows.idle();
    expect(totals(await list(rows, c.fn))).toContainEqual(["agent3", 2]);
  });
});

describe("a helper started or finished inside refresh_seconds", () => {
  it("a new helper's files show on the very next list", async () => {
    const rows = new HelperRows();
    const c = counting();
    await list(rows, c.fn);
    await new Promise((r) => setTimeout(r, 20));
    writeHelper(
      path.join(dir, "home"),
      token(3),
      "b0000000000000003",
      "Look again",
    );
    c.calls.length = 0;
    expect(totals(await list(rows, c.fn))).toContainEqual(["agent3", 2]);
    expect(c.calls).toEqual(["agent3"]);
  });
});

describe("lists naming different agents", () => {
  it("past agents.helpers.facts_cache_mb the least recently asked goes first", async () => {
    let t = 0;
    const rows = new HelperRows(
      () => ++t,
      async () => undefined,
    );
    let reads = 0;
    const ask = (id: string) => ({
      id,
      key: id,
      compute: () => (
        reads++,
        {
          running: 0,
          idle: 0,
          ended: 1,
          total: 1,
          cleared: 0,
          activeCount: 0,
          active: [],
        }
      ),
    });
    const tiny = 700;
    await rows.ensure([ask("a")], 5_000, tiny);
    await rows.ensure([ask("b")], 5_000, tiny);
    await rows.ensure([ask("a")], 5_000, tiny);
    await rows.ensure([ask("c")], 5_000, tiny);
    reads = 0;
    await rows.ensure([ask("a"), ask("c")], 5_000, tiny);
    expect(reads).toBe(0);
    await rows.ensure([ask("b")], 5_000, tiny);
    expect(reads).toBe(1);
  });

  it("never evict each other's rows (a page on ?ws= beside the rail's count)", async () => {
    let computes = 0;
    const rows = new HelperRows(Date.now, async () => undefined);
    const ask = (id: string) => ({
      id,
      key: id,
      compute: () => {
        computes++;
        return undefined;
      },
    });
    const one = ["a1", "a2", "shared"].map(ask);
    const two = ["b1", "b2", "shared"].map(ask);
    for (let i = 0; i < 5; i++) {
      await rows.ensure(one, 5_000);
      await rows.ensure(two, 5_000);
    }
    expect(computes).toBe(5);
  });

  it("a row nobody asked for in a minute is dropped", async () => {
    let now = 1_000_000;
    const rows = new HelperRows(
      () => now,
      async () => undefined,
    );
    const a = { id: "gone", key: "k", compute: () => undefined };
    await rows.ensure([a], 5_000);
    now += 61_000;
    await rows.ensure([], 5_000);
    let again = 0;
    await rows.ensure([{ ...a, compute: () => (again++, undefined) }], 5_000);
    expect(again).toBe(1);
  });
});

describe("agents.helpers.refresh_seconds", () => {
  it("defaults to 5; a value is read; a bad one names the key", () => {
    expect(helpersBlock(undefined).refreshSeconds).toBe(5);
    expect(helpersBlock({ refresh_seconds: 0 }).refreshSeconds).toBe(0);
    expect(helpersBlock({ refresh_seconds: 60 }).refreshSeconds).toBe(60);
    for (const bad of [-1, "soon", 100_000])
      expect(() => helpersBlock({ refresh_seconds: bad })).toThrow(
        "agents.helpers.refresh_seconds",
      );
  });
});
