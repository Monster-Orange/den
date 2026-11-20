/**
 * Issue 307's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate307-fake-den.mjs). Den's rail: the SERVICE tag on a
 * pin, "<name> · <Kind>" collapsed, the HUB tag, ⌘K listing projects, no
 * tag naming a machine, es and ja. The pins, the collapse and the language
 * are put back as they were.
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
    const g = await import("./gate/307.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate307-fake-den.mjs");
    const bed = fakeBed({ den: ${JSON.stringify(den)} });
    const out = await runLikeBed("307.mjs", g, bed.ctx);
    console.log(JSON.stringify({ clauses: g.clauses, after: bed.state(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    after: { lang: string; pins: string[]; collapsed: boolean };
    rows?: Row[];
    error?: string;
  };
}

const oks = (r: ReturnType<typeof runGate>) => (r.rows ?? []).map((x) => x.ok);
const LEFT = { lang: "en", pins: [], collapsed: false };

describe("gate/307.mjs as the bed runs it", () => {
  it("Den as built: Den's clauses pass, Hub's rail and the person's own look are not run", () => {
    const r = runGate("good");
    expect(r.error).toBeUndefined();
    expect(r.clauses).toHaveLength(8);
    expect(oks(r)).toEqual([true, true, true, true, true, true, null, null]);
    expect(r.rows?.[6].skip).toBe("needs-hub");
    expect(r.rows?.[7].skip).toBe("person");
    expect(r.after).toEqual(LEFT);
  });

  it("a pin without its tag: the SERVICE clause fails", () => {
    const r = runGate("noTag");
    expect(r.rows?.[0].ok).toBe(false);
    expect(r.after).toEqual(LEFT);
  });

  it("collapsed with the host's own tooltip: the collapsed clause fails", () => {
    expect(runGate("hostTitle").rows?.[1].ok).toBe(false);
  });

  it("⌘K without projects: that clause fails", () => {
    expect(runGate("noProjects").rows?.[3].ok).toBe(false);
  });

  it("a tag naming the machine: that clause fails", () => {
    expect(runGate("machine").rows?.[4].ok).toBe(false);
  });

  it("es and ja tags in English: the words clause fails, and the language is put back", () => {
    const r = runGate("english");
    expect(r.rows?.[5].ok).toBe(false);
    expect(r.after.lang).toBe("en");
  });

  it("no Hub address: the Hub clause is not run, saying why", () => {
    expect(runGate("noHub").rows?.[2]).toMatchObject({
      ok: null,
      skip: "needs-hub",
    });
  });

  it("a pin already there: the check pins nothing and leaves it", () => {
    const r = runGate("pinned");
    expect(oks(r).slice(0, 6)).toEqual([true, true, true, true, true, true]);
    expect(r.after.pins).toEqual(["web/admin"]);
  });
});
