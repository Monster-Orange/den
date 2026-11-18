/**
 * Issue 455's live check must work as the bed calls it: expect(result)
 * with one argument (CONTRIBUTING.md, "Live checks"). On 11-18 every
 * clause of gate/455.mjs was an ERROR on the bed because its expect read
 * the setup state from a second argument the runner never passes. Here the
 * gate runs through tests/fixtures/gate-runner-like.mjs (the runner's own
 * call order) on a fake bed: a working Den passes the clauses it can judge,
 * and each broken part fails its clause.
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
    const g = await import("./gate/455.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate455-fake-den.mjs");
    const { ctx } = fakeBed({ broken: ${JSON.stringify(broken)} });
    const out = await runLikeBed("455.mjs", g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    rows?: Row[];
    error?: string;
  };
}

describe("gate/455.mjs as the bed runs it", () => {
  it("a working Den: no error, and the clauses it can judge pass", () => {
    const r = runGate(null);
    expect(r.error).toBeUndefined();
    const judged = (r.rows ?? []).filter((x) => x.ok !== null);
    expect(judged.length).toBeGreaterThanOrEqual(4);
    expect(judged.every((x) => x.ok === true)).toBe(true);
  });

  it.each([
    ["identity", 0],
    ["doctor", 3],
    ["routes", 7],
  ])("a broken %s fails its clause", (broken, i) => {
    const r = runGate(broken);
    expect(r.error).toBeUndefined();
    const row = (r.rows ?? []).find((x) => x.clause === r.clauses[i]);
    expect(row?.ok).toBe(false);
  });
});
