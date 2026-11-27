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

function runGate(broken: string | null, address: string | null = null) {
  const js = `
    const g = await import("./gate/455.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate455-fake-den.mjs");
    const { ctx } = fakeBed({ broken: ${JSON.stringify(broken)}, address: ${JSON.stringify(address)} });
    const out = await runLikeBed("455.mjs", g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, notes: ctx.notes, ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    notes: string[];
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

  it("logs what each route command printed, for the evidence", () => {
    const r = runGate("routes");
    for (const kind of ["nginx", "caddy", "traefik"])
      expect(
        r.notes.some((n) =>
          n.startsWith(`edge route --for ${kind} --json: exit 0`),
        ),
      ).toBe(true);
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

  // After 0.4.68: when nothing answers at Den's address, the command line
  // (doctor) and the page (the Edge card) say "Not reachable yet".
  describe("nothing answers at Den's address", () => {
    const clause = (r: ReturnType<typeof runGate>) =>
      (r.rows ?? []).find((x) => /Not reachable yet/.test(x.clause));

    it("a working Den: the clause passes", () => {
      const r = runGate(null, "nothing");
      expect(r.error).toBeUndefined();
      expect(clause(r)?.ok).toBe(true);
      const judged = (r.rows ?? []).filter((x) => x.ok !== null);
      expect(judged.every((x) => x.ok === true)).toBe(true);
    });

    it.each(["unreachable-cli", "unreachable-page"])(
      "a Den with the line missing (%s) fails it",
      (broken) => {
        const r = runGate(broken, "nothing");
        expect(r.error).toBeUndefined();
        expect(clause(r)?.ok).toBe(false);
      },
    );

    it("the address works: the clause is skipped, not passed", () => {
      const r = runGate(null);
      expect(clause(r)?.ok).toBeNull();
    });
  });

  it("held by another server: a sub line that says running fails the Edge clause", () => {
    const ok = runGate(null, "held");
    expect(ok.error).toBeUndefined();
    expect((ok.rows ?? []).find((x) => x.clause === ok.clauses[4])?.ok).toBe(
      true,
    );
    const r = runGate("sub-running", "held");
    expect((r.rows ?? []).find((x) => x.clause === r.clauses[4])?.ok).toBe(
      false,
    );
  });
});
