/**
 * Issue 265's live check, run as the bed runs it (runLikeBed: setup, run,
 * expect(result), checkRows, teardown) on a fake bed
 * (tests/fixtures/gate265-fake-den.mjs). Den's half: with
 * agents.claude_ai_connectors on in den.yml, the --settings file Den wrote
 * for a stub agent lets claude.ai connectors in and keeps every other MCP
 * server out by name. The old launch (connectors disabled) fails. With the
 * switch off, or a stub not on den-claude, it is not run, saying why. The
 * account's connector itself is not run (needs-claude-account).
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

function runGate(opts: Record<string, unknown>) {
  const js = `
    const g = await import("./gate/265.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const { fakeBed } = await import("./tests/fixtures/gate265-fake-den.mjs");
    const bed = fakeBed(${JSON.stringify(opts)});
    const out = await runLikeBed("265.mjs", g, bed.ctx);
    console.log(JSON.stringify({ removed: bed.removed(), ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    removed: boolean;
    rows?: Row[];
    error?: string;
  };
}

describe("gate/265.mjs as the bed runs it", () => {
  it("switch on, Den as fixed: Den's half passes; the account's connector is not run; the agent is removed", () => {
    const r = runGate({ on: true });
    expect(r.error).toBeUndefined();
    expect(r.rows?.[0].ok).toBe(true);
    expect(r.rows?.[1]).toMatchObject({
      ok: null,
      skip: "needs-claude-account",
    });
    expect(r.removed).toBe(true);
  });

  it("switch on, the old launch (connectors disabled): fails", () => {
    expect(runGate({ on: true, den: "old" }).rows?.[0].ok).toBe(false);
  });

  it("switch off or unset: not run, saying the switch is off", () => {
    for (const on of [false, undefined]) {
      const r = runGate({ on });
      expect(r.rows?.[0]).toMatchObject({
        ok: null,
        skip: "needs-connectors-on",
      });
    }
  });

  it("a stub not on den-claude: not run, saying so", () => {
    const r = runGate({ on: true, runtime: "stub" });
    expect(r.rows?.[0]).toMatchObject({
      ok: null,
      skip: "needs-claude-runtime",
    });
  });
});
