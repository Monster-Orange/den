import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listRecords } from "../../../src/shared/agents/records";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  detail?: string;
}

function run(js: string): string {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return r.stdout.trim().split("\n").pop()!;
}

const limits = JSON.parse(
  run(`
    const g = await import("./gate/1668.mjs");
    console.log(JSON.stringify({ n: g.SEED_AGENTS, tries: g.TRIES, limit: g.LIMIT_MS, probe: g.PROBE_MS, min: g.IN_FLIGHT_MIN, wait: g.HELPERS_WAIT_MS, big: g.BIG_MB, clauses: g.clauses.length }));`),
) as {
  big: number;
  clauses: number;
  n: number;
  tries: number;
  limit: number;
  probe: number;
  min: number;
  wait: number;
};

function rows(result: unknown): Row[] {
  return JSON.parse(
    run(`
    const g = await import("./gate/1668.mjs");
    console.log(JSON.stringify(g.expect([{ cell: { browser: "chromium", width: 1280 }, result: ${JSON.stringify(result)} }])));`),
  ) as Row[];
}

const times = (ms: number) =>
  Array.from({ length: limits.tries }, () => ({ ms, status: 200 }));
const probes = (ms: number, inFlight = limits.tries) =>
  Array.from({ length: limits.tries }, (_, i) => ({
    ms,
    status: 200,
    inFlight: i < inFlight,
  }));

const fast = {
  seedMs: 900,
  seed: { status: 0, said: `seeded ${limits.n}` },
  warmMs: 40,
  coldMs: 30,
  coldStatus: 200,
  coldHelperRows: 0,
  coldProbe: { ms: 6, status: 200, inFlight: true },
  helpersMs: 2100,
  fill: [
    { ms: 5, status: 200 },
    { ms: 8, status: 200 },
  ],
  helperRows: limits.n,
  tries: times(Math.floor(limits.limit / 4)),
  probes: probes(Math.floor(limits.probe / 4)),
  idleMs: 5,
  inFlight: limits.tries,
  medianMs: Math.floor(limits.limit / 4),
  maxProbeMs: Math.floor(limits.probe / 4),
  big: {
    mb: limits.big,
    ms: 60,
    status: 200,
    listed: true,
    probe: { ms: 7, status: 200, inFlight: true },
    fill: [
      { ms: 6, status: 200 },
      { ms: 9, status: 200 },
    ],
    fillMs: 2400,
  },
};

describe("gate/1668 rows", () => {
  it("a list and a probe under their limits pass every row", () => {
    expect(rows(fast).map((r) => r.ok)).toEqual([true, true, true]);
  });

  it("the bars are fixed: 1500 ms for any list, cold or warm, and 250 ms for server-info", () => {
    expect(limits.limit).toBe(1500);
    expect(limits.probe).toBe(250);
  });

  it("one big transcript (300 MB to 1 GB) rides beside the seed, and its cold list has its own row", () => {
    expect(limits.big).toBeGreaterThanOrEqual(300);
    expect(limits.big).toBeLessThanOrEqual(1024);
    expect(limits.clauses).toBe(3);
    const r = rows(fast);
    expect(r[2].clause).toContain(`${limits.big} MB`);
    expect(r[2].detail).toContain("cold list with the big transcript 60 ms");
  });

  it("the cold list with the big transcript over the bar fails only its row", () => {
    const slow = rows({ ...fast, big: { ...fast.big, ms: limits.limit + 1 } });
    expect(slow.map((x) => x.ok)).toEqual([true, true, false]);
    const stall = rows({
      ...fast,
      big: {
        ...fast.big,
        probe: { ms: limits.probe + 1, status: 200, inFlight: true },
      },
    });
    expect(stall.map((x) => x.ok)).toEqual([true, true, false]);
    expect(stall[2].detail).toContain(
      `server-info during it ${limits.probe + 1} ms`,
    );
    expect(rows({ ...fast, big: { ...fast.big, status: 500 } })[2].ok).toBe(
      false,
    );
  });

  it("only a proven low disk skips the big row, as needs-disk-room with the free disk", () => {
    const r = rows({
      ...fast,
      big: {
        skipped: "needs-disk-room",
        room: "free disk 120 MB, needs 3072 MB",
      },
    });
    expect(r.map((x) => x.ok)).toEqual([true, true, null]);
    expect((r[2] as Row & { skip?: string }).skip).toBe("needs-disk-room");
    expect(r[2].detail).toContain("free disk 120 MB");
  });

  it("an unknown disk, a failed write or an unreached list is not measured, never a skip", () => {
    for (const big of [
      { error: "free disk unknown: EPERM" },
      { error: "the big transcript could not be written: ENOSPC" },
      undefined,
    ])
      expect(() => rows({ ...fast, big })).toThrow(
        /1668 not measured: (free disk unknown|the big transcript)/,
      );
  });

  it("a big agent the list never showed is not measured", () => {
    expect(() =>
      rows({ ...fast, big: { ...fast.big, listed: false } }),
    ).toThrow(/1668 not measured: the list did not show the big agent/);
  });

  it("the big agent's helpers are waited for, and never coming within the wait is not measured", () => {
    expect(rows(fast)[2].detail).toContain(
      "its helpers showed after 2400 ms, 2 probes, max 9 ms",
    );
    expect(() => rows({ ...fast, big: { ...fast.big, fillMs: null } })).toThrow(
      new RegExp(
        `1668 not measured: the big agent's helpers did not show within ${limits.wait / 1000} s`,
      ),
    );
  });

  it("server-info stalled while the 1 GB transcript is read fails the big row", () => {
    const r = rows({
      ...fast,
      big: {
        ...fast.big,
        fill: [
          { ms: 6, status: 200 },
          { ms: limits.probe + 1, status: 200 },
        ],
      },
    });
    expect(r.map((x) => x.ok)).toEqual([true, true, false]);
    expect(r[2].detail).toContain(`max ${limits.probe + 1} ms`);
  });

  it("a list over the limit, with the server stalled behind it, fails both", () => {
    const slow = {
      ...fast,
      tries: times(limits.limit * 5),
      probes: probes(limits.probe * 5),
      medianMs: limits.limit * 5,
      maxProbeMs: limits.probe * 5,
    };
    expect(rows(slow).map((r) => r.ok)).toEqual([false, false, true]);
  });

  it("server-info waiting behind the list (0.4.90: 9 s against an idle 3-9 ms) fails row 2 and shows the idle time", () => {
    const r = rows({
      ...fast,
      probes: probes(9000),
      maxProbeMs: 9000,
    });
    expect(r.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r[1].detail).toContain("server-info idle 5 ms");
    expect(r[1].detail).toContain("max in flight 9000");
  });

  it("a list fast enough that no probe overlapped it judges both rows on that bound, no throw", () => {
    const quick = {
      ...fast,
      tries: times(Math.floor(limits.probe / 10)),
      medianMs: Math.floor(limits.probe / 10),
      probes: probes(4, 0),
      inFlight: 0,
      maxProbeMs: null,
    };
    const r = rows(quick);
    expect(r.map((x) => x.ok)).toEqual([true, true, true]);
    expect(r[1].detail).toContain("so nothing could wait behind it longer");
    const stuck = rows({ ...quick, probes: probes(limits.probe * 2, 0) });
    expect(stuck[1].ok).toBe(false);
  });

  it("a slow list no probe overlapped is not measured, never a PASS", () => {
    expect(() =>
      rows({
        ...fast,
        tries: times(limits.probe * 3),
        medianMs: limits.probe * 3,
        probes: probes(3, limits.min - 1),
        inFlight: limits.min - 1,
      }),
    ).toThrow(
      /1668 not measured: server-info started while the list was still in flight on/,
    );
  });

  it("0.4.90's cold list, reading every transcript before it answers, fails row 1 even when the warm lists are fast", () => {
    const r = rows({
      ...fast,
      coldMs: limits.limit * 6,
      coldHelperRows: limits.n,
      coldProbe: { ms: limits.probe * 18, status: 200, inFlight: true },
    });
    expect(r.map((x) => x.ok)).toEqual([false, false, true]);
    expect(r[0].detail).toContain(`cold list ${limits.limit * 6} ms`);
    expect(r[1].detail).toContain(
      `during the cold list ${limits.probe * 18} ms`,
    );
  });

  it("server-info stalled while the background reader fills the helpers fails row 2, and its detail shows the fill probes", () => {
    const r = rows({
      ...fast,
      fill: [
        { ms: 6, status: 200 },
        { ms: limits.probe * 8, status: 200 },
      ],
    });
    expect(r.map((x) => x.ok)).toEqual([true, false, true]);
    expect(r[1].detail).toContain(
      `while the helpers filled 2 probes, max ${limits.probe * 8} ms`,
    );
    expect(rows(fast)[1].detail).toContain(
      "while the helpers filled 2 probes, max 8 ms",
    );
    expect(rows({ ...fast, fill: [] })[1].detail).toContain(
      "none (helpers were there at once)",
    );
  });

  it("helpers that never appear within the wait are not measured, naming the wait", () => {
    expect(() =>
      rows({
        ...fast,
        helperRows: 0,
        helpersMs: null,
        listed: limits.n,
        listRows: limits.n + 1,
      }),
    ).toThrow(
      new RegExp(
        `1668 not measured: the list showed helpers on 0 of ${limits.n} seeded agents within ${limits.wait / 1000} s of the seed \\(it listed ${limits.n} of them`,
      ),
    );
  });

  it("a seed the list never showed is an ERROR (not measured), never a FAIL", () => {
    expect(() => rows({ ...fast, helperRows: 0 })).toThrow(/1668 not measured/);
    expect(() => rows({ ...fast, helperRows: limits.n - 3 })).toThrow(
      /1668 not measured: the list showed helpers on/,
    );
    expect(() =>
      rows({ ...fast, seed: { status: 1, said: "EACCES" } }),
    ).toThrow(/1668 not measured: seed/);
  });

  it("a try that didn't answer 200 fails its row", () => {
    const tries = times(10);
    tries[2] = { ms: 10, status: 500 };
    expect(rows({ ...fast, tries })[0].ok).toBe(false);
  });

  it("no den2 is an ERROR, naming why", () => {
    expect(() => rows({ error: "the bed gives no ctx.den2" })).toThrow(
      /1668 not measured: the bed gives no ctx.den2/,
    );
  });

  it("each row says how the agents were seeded", () => {
    expect(rows(fast)[0].detail).toContain("the gate process then writes");
  });

  it("the limits are named constants, the seed is above the old 64-transcript cache", () => {
    expect(limits.n).toBeGreaterThan(64);
    expect(limits.limit).toBeGreaterThan(0);
    expect(limits.probe).toBeGreaterThan(0);
  });
});

describe("gate/1668 seed files", () => {
  const seedJs = (dir: string, body: string) =>
    run(`
    import fs from "fs"; import path from "path"; import crypto from "crypto";
    const { seedFiles: f, SEED_AGENTS } = await import("./gate/1668.mjs");
    const D = ${JSON.stringify(dir)};
    ${body}`);

  function fakeDen(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "g1668-"));
    for (const [n, tok] of [
      ["abc123", "t-mine"],
      ["def456", "t-other"],
    ]) {
      fs.mkdirSync(path.join(d, "cwd", n, "h", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(d, "cwd", n, "h", "agents", "g1668-template.json"),
        JSON.stringify({
          id: "g1668-template",
          resumeToken: tok,
          sessionName: "p:g1668-template",
          session: { id: "x" },
        }),
      );
    }
    fs.mkdirSync(path.join(d, "cwd", "abc123", "proj-gate"));
    fs.mkdirSync(path.join(d, "stub"));
    return d;
  }

  it("finds only the home whose template holds the token, and none for another token", () => {
    const d = fakeDen();
    const got = JSON.parse(
      seedJs(
        d,
        `console.log(JSON.stringify([f.findHome(fs, path, D + "/cwd", "t-mine"), f.findHome(fs, path, D + "/cwd", "t-none"), f.findHome(fs, path, D + "/cwd/abc123/proj-gate", "t-mine")]));`,
      ),
    );
    expect(got[0].home).toBe(path.join(d, "cwd", "abc123", "h"));
    expect(got[1].error).toMatch(/found 0 Den homes/);
    expect(got[2].home).toBe(path.join(d, "cwd", "abc123", "h"));
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("Den's own listRecords lists every seeded agent (a record needs its own id and a session)", () => {
    const d = fakeDen();
    const home = path.join(d, "cwd", "abc123", "h");
    seedJs(
      d,
      `f.seed(fs, path, crypto, ${JSON.stringify(home)}, D + "/stub", [], 0.01); console.log("{}");`,
    );
    const ids = listRecords(home).map((r) => r.id);
    expect(ids.filter((x) => x.startsWith("g1668-a")).length).toBe(limits.n);
    expect(new Set(listRecords(home).map((r) => r.session.id)).size).toBe(
      limits.n + 1,
    );
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("seeds every agent with a record, a transcript and a helper, and clean removes only those", () => {
    const d = fakeDen();
    const got = JSON.parse(
      seedJs(
        d,
        `const s = { home: D + "/cwd/abc123/h", dir: D + "/stub", made: [] };
        f.seed(fs, path, crypto, s.home, s.dir, s.made, 0.01);
        const rec = JSON.parse(fs.readFileSync(s.made[0].record, "utf8"));
        const after = { records: fs.readdirSync(s.home + "/agents").length, stub: fs.readdirSync(s.dir).length, name: rec.sessionName, sessionName: rec.session?.name ?? null, sessionId: rec.session?.id ?? null };
        s.made.push({ id: "g1668-a999", record: D + "/cwd/def456/h/agents/g1668-template.json", transcript: "/etc/x.jsonl" });
        const n = f.clean(fs, path, s);
        console.log(JSON.stringify({ n: SEED_AGENTS, after, cleaned: n, left: fs.readdirSync(s.home + "/agents"), stub: fs.readdirSync(s.dir).length, other: fs.existsSync(D + "/cwd/def456/h/agents/g1668-template.json") }));`,
      ),
    );
    expect(got.after).toMatchObject({
      records: got.n + 1,
      stub: got.n * 2,
      name: "p:g1668-a001",
    });
    expect(got.after.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(got.after.sessionId).not.toBe("x");
    expect(got.left).toEqual(["g1668-template.json"]);
    expect(got.stub).toBe(0);
    expect(got.other).toBe(true);
    fs.rmSync(d, { recursive: true, force: true });
  });

  it("room for the big transcript needs three times its size free", () => {
    const got = JSON.parse(
      seedJs(
        "/",
        `console.log(JSON.stringify([f.bigRoom(400 * 1048576, 300), f.bigRoom(4000 * 1048576, 300)]));`,
      ),
    );
    expect(got[0]).toMatch(/free disk 400 MB, needs 900 MB/);
    expect(got[1]).toBeNull();
  });

  it("seeds one big agent with a transcript of the size asked, and clean removes it too", () => {
    const d = fakeDen();
    const got = JSON.parse(
      seedJs(
        d,
        `const s = { home: D + "/cwd/abc123/h", dir: D + "/stub", made: [] };
        f.seed(fs, path, crypto, s.home, s.dir, s.made, 0.01);
        const b = f.seedBig(fs, path, crypto, s.home, s.dir, s.made, 2);
        const size = fs.statSync(b.transcript).size;
        const rec = JSON.parse(fs.readFileSync(b.record, "utf8"));
        const helper = fs.existsSync(b.transcript.slice(0, -6) + "/subagents/agent-h1.jsonl");
        f.clean(fs, path, s);
        console.log(JSON.stringify({ id: b.id, size, recId: rec.id, helper, left: fs.readdirSync(s.home + "/agents"), stub: fs.readdirSync(s.dir).length }));`,
      ),
    );
    expect(got.id).toBe("g1668-big");
    expect(got.recId).toBe("g1668-big");
    expect(got.size).toBeGreaterThanOrEqual(2 * 1048576);
    expect(got.size).toBeLessThan(3 * 1048576);
    expect(got.helper).toBe(true);
    expect(got.left).toEqual(["g1668-template.json"]);
    expect(got.stub).toBe(0);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
