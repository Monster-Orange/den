/**
 * Issue 267's live check, run as the bed runs it (runLikeBed: setup, run
 * per matrix cell, expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate267-fake-den.mjs). Settings › Hub on a Den with no
 * Hub: the address checked as typed, Save writes it and restarts Den,
 * change and Clear the same; the words in en/es/ja; the doc; hub_connect's
 * check. The bed is left as it was: no address, its language, nothing
 * waiting for an Allow.
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
    const g = await import("./gate/267.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate267-fake-den.mjs");
    const bed = fakeBed({ den: ${JSON.stringify(den)} });
    const out = await runLikeBed("267.mjs", g, bed.ctx);
    console.log(JSON.stringify({ clauses: g.clauses, after: bed.state(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    after: { url: string | null; lang: string; approvals: number };
    rows?: Row[];
    error?: string;
  };
}

const oks = (r: ReturnType<typeof runGate>) => (r.rows ?? []).map((x) => x.ok);
const LEFT = { url: null, lang: "en", approvals: 0 };

describe("gate/267.mjs as the bed runs it", () => {
  it("with a link to the doc: every clause the bed can run passes; the bed is left as it was", () => {
    const r = runGate("fixed");
    expect(r.error).toBeUndefined();
    expect(r.clauses).toHaveLength(11);
    expect(oks(r)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      null,
      null,
    ]);
    expect(r.rows?.[9].skip).toBe("needs-hub");
    expect(r.rows?.[10].skip).toBe("person");
    expect(r.after).toMatchObject(LEFT);
  });

  it("the doc named in the section's text, with no link: that clause fails, the rest pass", () => {
    const r = runGate("built");
    expect(oks(r)).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      null,
      null,
    ]);
    expect(r.rows?.[4].detail).toMatch(/doc link none/);
  });

  it("Save without a restart: the Save and change clauses fail", () => {
    const r = runGate("noRestart");
    expect(r.rows?.[2].ok).toBe(false);
    expect(r.rows?.[3].ok).toBe(false);
    expect(r.after).toMatchObject(LEFT);
  });

  it("no check as the address is typed: the address clause fails", () => {
    expect(runGate("noInline").rows?.[1].ok).toBe(false);
  });

  it("Hub's bell rows still under Notifications: the section clause fails", () => {
    expect(runGate("oldSection").rows?.[0].ok).toBe(false);
  });

  it("a bed with a Hub address already: nothing is written, and the writes are not run, saying why", () => {
    const r = runGate("hubSet");
    expect(r.error).toBeUndefined();
    expect(r.rows?.[2]).toMatchObject({
      ok: null,
      skip: "needs-no-hub-address",
    });
    expect(r.rows?.[3]).toMatchObject({
      ok: null,
      skip: "needs-no-hub-address",
    });
    expect(r.rows?.[5]).toMatchObject({
      ok: null,
      skip: "needs-no-hub-address",
    });
    expect(r.after.url).toBe("https://hub.example.test");
  });

  it("held writes turned off: hub_connect's clause is not run, saying why", () => {
    expect(runGate("heldOff").rows?.[8]).toMatchObject({
      ok: null,
      skip: "needs-held-writes-on",
    });
  });
});
