/**
 * Issue 503's live check, run as the bed runs it (runLikeBed: setup, run,
 * expect(result), checkRows, teardown) on a fake bed. A working Den passes
 * every clause it can judge; each broken part fails its own clause, so the
 * check can tell the PTY leak from a fixed host. Terminals open through
 * the CLI (the page's route is refused to the fixture person, issue 810);
 * when none opens, nothing was measured: not run, never a FAIL.
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

function runGate(
  broken: string | null,
  opts: { cap?: number; capIn?: string } = {},
) {
  const js = `
    const g = await import("./gate/503.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate503-fake-den.mjs");
    const { ctx } = fakeBed({ broken: ${JSON.stringify(broken)}, ...${JSON.stringify(opts)} });
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
  it("a working Den: no error, clauses a–d pass; e and the page's 429 are not run with their reasons", () => {
    const r = runGate(null);
    expect(r.error).toBeUndefined();
    for (const i of [0, 1, 2, 3]) expect(row(r, i)?.ok).toBe(true);
    expect(row(r, 4)).toMatchObject({ ok: null, skip: "needs-pty-limit" });
    expect(row(r, 5)).toMatchObject({ ok: null, skip: "person" });
  });

  it("no terminal opens: the PTY clause is not run, never a FAIL", () => {
    const r = runGate("nostart");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)).toMatchObject({ ok: null, skip: "needs-terminal" });
  });

  it("reads the cap from Den's default when den.yml doesn't set it", () => {
    const r = runGate(null, { cap: 6, capIn: "default" });
    expect(row(r, 0)?.ok).toBe(true);
    expect(r.notes.some((n) => n.startsWith("PTYs (cap 6)"))).toBe(true);
  });

  it("a cap of 20 or more: all 20 open", () => {
    const r = runGate(null, { cap: 25 });
    expect(row(r, 0)?.ok).toBe(true);
    expect(r.open).toBe(0);
  });

  it("logs the refusal it stopped at", () => {
    const r = runGate(null);
    expect(r.notes.some((n) => /^refused after 8: .*"cap":true/.test(n))).toBe(
      true,
    );
  });

  it("closes every terminal it opened, and logs the PTY counts", () => {
    const r = runGate(null);
    expect(r.open).toBe(0);
    expect(r.notes.some((n) => /^PTYs \(cap 8\): before /.test(n))).toBe(true);
  });

  it("another program's PTYs on the machine don't fail it: the host is the bed's own count, the machine's is a note", () => {
    const r = runGate("others");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)?.ok).toBe(true);
    expect(r.notes.some((n) => /machine 4\d → 4\d/.test(n))).toBe(true);
  });

  it.each([
    ["leak", 0],
    ["doctor", 1],
    ["keys", 2],
    ["pty", 3],
    // Stopped at 8 with no refusal naming the key: can't tell it was the cap.
    ["reason", 0],
  ])("a broken %s fails its clause", (broken, i) => {
    const r = runGate(broken);
    expect(r.error).toBeUndefined();
    expect(row(r, i)?.ok).toBe(false);
  });
});
