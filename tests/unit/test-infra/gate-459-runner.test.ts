/**
 * Issue 459's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate459-fake-den.mjs): a fake Den reads the feed the
 * check adds to the bed's workspaces.yml and reads the check's own event
 * stream over real HTTP. Each way Den could get one clause wrong fails
 * that clause only. Whatever happens (a throw, a time-out that skips the
 * run's finally, someone else writing to the file), the bed is put back,
 * its Den restarted on it, and the agent removed; a Den that doesn't come
 * back, or a file that can't be put back, fails every clause.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}
interface After {
  text: string | null;
  newLeft: boolean;
  up: boolean;
  downs: number;
  ups: number;
  feeds: number;
  gotos: string[];
  held: unknown;
}

function runGate(den: string, bed = "file", limitMs = 0) {
  const js = `
    const g = await import("./gate/459.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed, ORIGINAL } = await import("./tests/fixtures/gate459-fake-den.mjs");
    const b = fakeBed({ den: ${JSON.stringify(den)}, bed: ${JSON.stringify(bed)} });
    let out;
    try {
      out = await runLikeBed("459.mjs", g, b.ctx, { limitMs: ${limitMs} });
    } finally {
      var after = b.after();
      b.cleanup();
    }
    console.log(JSON.stringify({ clauses: g.clauses, removed: b.removed(), after, original: ORIGINAL, ...out }));
    process.exit(0); // as the runner does: a run that timed out is still pending`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 90_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    removed: boolean;
    after: After;
    original: string;
    rows?: Row[];
    error?: string;
  };
}

const oks = (r: ReturnType<typeof runGate>) => (r.rows ?? []).map((x) => x.ok);

/** The bed as it was: the file's own text (its comment too), Den up without the feed. */
function putBack(r: ReturnType<typeof runGate>) {
  expect(r.after.text).toBe(r.original);
  expect(r.after.newLeft).toBe(false);
  expect(r.after.up).toBe(true);
  expect(r.after.feeds).toBe(0);
  expect(r.removed).toBe(true);
}

describe("gate/459.mjs as the bed runs it", () => {
  it("Den as built: every clause passes, and the bed is put back", () => {
    const r = runGate("good");
    expect(r.error).toBeUndefined();
    expect(r.clauses).toHaveLength(5);
    expect(oks(r)).toEqual([true, true, true, true, true]);
    expect(r.after.gotos[0]).toContain("project=north");
    expect(r.after.downs).toBe(2);
    expect(r.after.ups).toBe(2);
    putBack(r);
  });

  it("enterApart: the Enter typed as a key of its own still passes every clause", () => {
    const r = runGate("enterApart");
    expect(r.error).toBeUndefined();
    expect(oks(r)).toEqual([true, true, true, true, true]);
    putBack(r);
  });

  it("a held item left for its agent is captured, and Den's held file is never edited", () => {
    const r = runGate("heldLeft");
    expect(r.error).toBeUndefined();
    expect(r.rows?.[1].detail).toContain('"held_reason":"busy"');
    expect(r.after.held).toEqual({
      queue: {
        "gate-459-feed": [{ id: "feed:old", held_reason: "busy" }],
        "other-agent": [{ id: "hub:keep" }],
      },
      active: {},
    });
    putBack(r);
  });

  it.each([
    ["wrongAgent", 0, "the view lists the feed for another agent"],
    ["typesBait", 1, "the pointer carries the app's own text"],
    ["redeliver", 2, "the same id is delivered again"],
    ["logGone", 2, "the stub's log can't be read for the repeat"],
    ["noLastId", 3, "a reconnect sends no Last-Event-ID"],
    ["noFill", 3, "a reconnect never asks the list form"],
    ["rawWords", 4, "Settings shows the state's key, not its words"],
  ])(
    "%s: clause %i fails, the others pass, and the file is put back (%s)",
    (den, n) => {
      const r = runGate(den as string);
      expect(r.error).toBeUndefined();
      const want = [true, true, true, true, true];
      want[n as number] = false;
      expect(oks(r)).toEqual(want);
      putBack(r);
    },
  );

  it("the check's run throws: the file's text is still put back and Den restarted", () => {
    const r = runGate("pageThrows");
    expect(r.error).toMatch(/Settings: page crashed/);
    putBack(r);
    expect(r.after.downs).toBe(2);
  });

  it("no bed root given: every clause fails, saying so, and nothing is touched", () => {
    const r = runGate("good", "missing");
    expect(r.error).toBeUndefined();
    expect(oks(r)).toEqual([false, false, false, false, false]);
    for (const x of r.rows ?? [])
      expect(x.detail).toMatch(/bed root not given/);
    expect(r.after.downs).toBe(0);
    expect(r.removed).toBe(true);
  });

  it("no session at run time, though setup started it: every clause fails, never skipped", () => {
    const r = runGate("noSession");
    expect(oks(r)).toEqual([false, false, false, false, false]);
    expect((r.rows ?? []).some((x) => x.skip)).toBe(false);
    expect(r.after.text).toBe(r.original);
    expect(r.after.downs).toBe(0);
  });

  it("the bed had no workspaces.yml: it has none after", () => {
    const r = runGate("good", "none");
    expect(oks(r)).toEqual([true, true, true, true, true]);
    expect(r.after.text).toBeNull();
    expect(r.after.up).toBe(true);
    expect(r.after.feeds).toBe(0);
  });
  it("the run times out (its finally never runs): teardown puts the bed back", () => {
    const r = runGate("hangs", "file", 3000);
    expect(r.error).toMatch(/run chromium 1280 timed out after 3000 ms/);
    putBack(r);
    expect(r.after.downs).toBe(2);
    expect(r.after.ups).toBe(2);
  });

  it("someone else writes to the file mid-run: only the feed comes out, their change stays", () => {
    const r = runGate("changedMidRun");
    expect(r.error).toBeUndefined();
    expect(oks(r)).toEqual([true, true, true, true, true]);
    expect(r.rows?.[0].detail).toMatch(
      /changed during the check: only the gate459 feed taken out/,
    );
    expect(r.after.text).toContain("# a project someone added");
    expect(r.after.text).toContain("/beds/east");
    expect(r.after.text).toContain("/beds/south");
    expect(r.after.text).not.toContain("gate459");
    expect(r.after.text).not.toContain("event_feeds");
    expect(r.after.up).toBe(true);
    expect(r.after.feeds).toBe(0);
  });

  it("Den doesn't come back after the bed is put back: every clause fails", () => {
    const r = runGate("noComeBack");
    expect(r.error).toBeUndefined();
    expect(oks(r)).toEqual([false, false, false, false, false]);
    for (const x of r.rows ?? []) expect(x.detail).toMatch(/NOT put back/);
    expect(r.after.text).toBe(r.original);
    expect(r.removed).toBe(true);
  });

  (process.getuid?.() === 0 ? it.skip : it)(
    "putting the file back throws: every clause fails, and Den is still restarted",
    () => {
      const r = runGate("readOnly");
      expect(r.error).toBeUndefined();
      expect(oks(r)).toEqual([false, false, false, false, false]);
      for (const x of r.rows ?? [])
        expect(x.detail).toMatch(/EACCES|permission denied/i);
      expect(r.after.downs).toBe(2);
      expect(r.after.ups).toBe(2);
      expect(r.after.up).toBe(true);
      expect(r.removed).toBe(true);
    },
  );
});
