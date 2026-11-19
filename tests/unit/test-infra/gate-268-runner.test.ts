/**
 * Issue 268's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate268-fake-den.mjs). The Den-wide row and the
 * project's row, with the stub's project overriding and another following:
 * the layers' names and order, what is in effect and from where, the links
 * both ways, the Agents list's words, en/es/ja. The project's mode the
 * check set is put back, the language too, and the agent is removed.
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

function runGate(den: string) {
  const js = `
    const g = await import("./gate/268.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate268-fake-den.mjs");
    const bed = fakeBed({ den: ${JSON.stringify(den)} });
    const out = await runLikeBed("268.mjs", g, bed.ctx);
    console.log(JSON.stringify({ clauses: g.clauses, after: bed.state(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    after: {
      agent: string | null;
      lang: string;
      modes: Record<string, unknown>;
    };
    rows?: Row[];
    error?: string;
  };
}

const oks = (r: ReturnType<typeof runGate>) => (r.rows ?? []).map((x) => x.ok);
const LEFT = { agent: null, lang: "en", modes: { north: null, south: null } };

describe("gate/268.mjs as the bed runs it", () => {
  it("Den as built: every clause passes, and the bed is left as it was", () => {
    const r = runGate("good");
    expect(r.error).toBeUndefined();
    expect(r.clauses).toHaveLength(6);
    expect(oks(r)).toEqual([true, true, true, true, true, true]);
    expect(r.after).toEqual(LEFT);
  });

  it("the old labels: the names clause fails", () => {
    const r = runGate("oldWords");
    expect(r.rows?.[0].ok).toBe(false);
    expect(r.after).toEqual(LEFT);
  });

  it("no in-effect line: the in-effect clause and either-row clause fail", () => {
    const r = runGate("noStatus");
    expect(r.rows?.[1].ok).toBe(false);
    expect(r.rows?.[5].ok).toBe(false);
  });

  it("no links between the rows: the links clause fails", () => {
    expect(runGate("noLinks").rows?.[2].ok).toBe(false);
  });

  it("the Agents list with other words: that clause fails", () => {
    const r = runGate("agentWords");
    expect(oks(r)).toEqual([true, true, true, false, true, true]);
  });

  it("es and ja in English: the languages clause fails, and the language is put back", () => {
    const r = runGate("untranslated");
    expect(r.rows?.[4].ok).toBe(false);
    expect(r.after.lang).toBe("en");
  });

  it("one project only: not run, saying why, and nothing changed", () => {
    const r = runGate("oneProject");
    expect(r.error).toBeUndefined();
    expect(oks(r)).toEqual([null, null, null, null, null, null]);
    expect(r.rows?.[0].skip).toBe("needs-two-projects");
    expect(r.after).toEqual({
      agent: null,
      lang: "en",
      modes: { north: null },
    });
  });

  it("a stub without modes: the Agents list clause is not run, saying why", () => {
    const r = runGate("noRuntime");
    expect(r.rows?.[3]).toMatchObject({ ok: null, skip: "needs-mode-runtime" });
    expect(r.rows?.[0].ok).toBe(true);
  });
});
