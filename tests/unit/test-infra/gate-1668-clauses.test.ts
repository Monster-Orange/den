import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

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
    console.log(JSON.stringify({ n: g.SEED_AGENTS, tries: g.TRIES, limit: g.LIMIT_MS, probe: g.PROBE_MS }));`),
) as { n: number; tries: number; limit: number; probe: number };

function rows(result: unknown): Row[] {
  return JSON.parse(
    run(`
    const g = await import("./gate/1668.mjs");
    console.log(JSON.stringify(g.expect([{ cell: { browser: "chromium", width: 1280 }, result: ${JSON.stringify(result)} }])));`),
  ) as Row[];
}

const times = (ms: number) =>
  Array.from({ length: limits.tries }, () => ({ ms, status: 200 }));

const fast = {
  seedMs: 900,
  seed: { status: 0, said: `seeded ${limits.n}` },
  warmMs: 4000,
  helperRows: limits.n,
  tries: times(Math.floor(limits.limit / 4)),
  probes: times(Math.floor(limits.probe / 4)),
  medianMs: Math.floor(limits.limit / 4),
  maxProbeMs: Math.floor(limits.probe / 4),
};

describe("gate/1668 rows", () => {
  it("a list and a probe under their limits pass both rows", () => {
    expect(rows(fast).map((r) => r.ok)).toEqual([true, true]);
  });

  it("a list over the limit, with the server stalled behind it, fails both", () => {
    const slow = {
      ...fast,
      tries: times(limits.limit * 5),
      probes: times(limits.probe * 5),
      medianMs: limits.limit * 5,
      maxProbeMs: limits.probe * 5,
    };
    expect(rows(slow).map((r) => r.ok)).toEqual([false, false]);
  });

  it("a fast list that never read the seeded helpers fails: the seed proves nothing", () => {
    expect(rows({ ...fast, helperRows: 0 }).map((r) => r.ok)).toEqual([
      false,
      false,
    ]);
    expect(rows({ ...fast, helperRows: limits.n - 3 })[0].ok).toBe(false);
    expect(
      rows({ ...fast, seed: { status: 2, said: "found 0 Den homes" } })[0].ok,
    ).toBe(false);
  });

  it("a try that didn't answer 200 fails its row", () => {
    const tries = times(10);
    tries[2] = { ms: 10, status: 500 };
    expect(rows({ ...fast, tries })[0].ok).toBe(false);
  });

  it("no den2 fails both, naming why", () => {
    const r = rows({ error: "the bed gives no ctx.den2" });
    expect(r.map((x) => x.ok)).toEqual([false, false]);
    expect(r[0].detail).toContain("no ctx.den2");
  });

  it("each row says how the agents were seeded", () => {
    expect(rows(fast)[0].detail).toContain("by writing their records");
  });

  it("the limits are named constants, the seed is above the old 64-transcript cache", () => {
    expect(limits.n).toBeGreaterThan(64);
    expect(limits.limit).toBeGreaterThan(0);
    expect(limits.probe).toBeGreaterThan(0);
  });
});
