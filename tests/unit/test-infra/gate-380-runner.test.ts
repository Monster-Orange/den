/**
 * Issue 380's live check, run as the bed runs it (runLikeBed) on a fake
 * bed. Saves a field anyone may change (language), so the fixture person's
 * saves are taken: a Den that writes user.yml whole passes; one whose
 * reader can see half a file fails. When no save is taken (every one
 * refused), nothing was measured: not run, never a FAIL.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

type Mode = "whole" | "torn" | "refused";

function runGate(mode: Mode) {
  const js = `
    const g = await import("./gate/380.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const mode = ${JSON.stringify(mode)};
    const file = "# Per-engineer preferences\\nlanguage: es\\n";
    let reads = 0;
    const bodies = [];
    const ctx = {
      async api(p) { return p === "/api/settings" ? { language: "es" } : {}; },
      async fetch(p, init) {
        if (p !== "/api/settings") return { status: 404, body: "{}" };
        bodies.push(init.body);
        // Den's answer to a person-only field from the fixture person.
        if (mode === "refused") return { status: 403, body: '{"ok":false,"error":"only a person can change it"}' };
        await new Promise((r) => setImmediate(r));
        return { status: 200, body: "{}" };
      },
      readBed(rel) {
        if (rel !== "config/local/user.yml") return null;
        reads++;
        return mode === "torn" && reads % 50 === 0 ? file.slice(0, 12) : file;
      },
      listBed() { return ["user.yml"]; },
      async sleep() {},
      log() {},
    };
    const out = await runLikeBed("380.mjs", g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, bodies: [...new Set(bodies)], ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    bodies: string[];
    rows?: {
      clause: string;
      ok: boolean | null;
      skip?: string;
      detail?: string;
    }[];
    error?: string;
  };
}

const row = (r: ReturnType<typeof runGate>, i: number) =>
  (r.rows ?? []).find((x) => x.clause === r.clauses[i]);

describe("gate/380.mjs as the bed runs it", () => {
  it("saves the language it found, a field anyone may change: never a person-only one", () => {
    const r = runGate("whole");
    expect(r.bodies).toEqual([JSON.stringify({ language: "es" })]);
  });

  it("a Den that writes user.yml whole passes both clauses", () => {
    const r = runGate("whole");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)?.ok).toBe(true);
    expect(row(r, 1)?.ok).toBe(true);
  });

  it("a reader that sees half the file fails clause 1", () => {
    const r = runGate("torn");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)?.ok).toBe(false);
  });

  it("no save taken: both clauses not run, with the refusal, never a FAIL", () => {
    const r = runGate("refused");
    expect(r.error).toBeUndefined();
    for (const i of [0, 1]) {
      expect(row(r, i)).toMatchObject({
        ok: null,
        skip: "needs-settings-save",
      });
      expect(row(r, i)?.detail).toMatch(/403/);
    }
  });
});
