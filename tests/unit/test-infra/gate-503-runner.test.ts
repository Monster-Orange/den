/**
 * Issue 503's live check, run as the bed runs it (runLikeBed: setup, run,
 * expect(result), checkRows, teardown) on a fake bed. A working Den passes
 * every clause it can judge; each broken part fails its own clause, so the
 * check can tell the PTY leak from a fixed host.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
}

function runGate(broken: string | null) {
  const js = `
    const g = await import("./gate/503.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate503-fake-den.mjs");
    const { ctx } = fakeBed({ broken: ${JSON.stringify(broken)} });
    const out = await runLikeBed("503.mjs", g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, notes: ctx.notes, open: ctx.openNow(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    notes: string[];
    open: number;
    rows?: Row[];
    error?: string;
  };
}

const row = (r: ReturnType<typeof runGate>, i: number) =>
  (r.rows ?? []).find((x) => x.clause === r.clauses[i]);

describe("gate/503.mjs as the bed runs it", () => {
  it("a working Den: no error, clauses a–d pass, e is not run with its reason", () => {
    const r = runGate(null);
    expect(r.error).toBeUndefined();
    for (const i of [0, 1, 2, 3]) expect(row(r, i)?.ok).toBe(true);
    expect(row(r, 4)).toMatchObject({ ok: null, skip: "needs-pty-limit" });
  });

  it("closes every terminal it opened, and logs the PTY counts", () => {
    const r = runGate(null);
    expect(r.open).toBe(0);
    expect(r.notes.some((n) => /^PTYs: before /.test(n))).toBe(true);
  });

  it.each([
    ["leak", 0],
    ["doctor", 1],
    ["keys", 2],
    ["pty", 3],
  ])("a broken %s fails its clause", (broken, i) => {
    const r = runGate(broken);
    expect(r.error).toBeUndefined();
    expect(row(r, i)?.ok).toBe(false);
  });
});
