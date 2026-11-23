/**
 * Issue 1264: Den's PreToolUse hook (guardrails/pretooluse.mjs), run as
 * Claude Code runs it, rewrites an agent's heavy Bash command to go
 * through the gate. It prints one JSON object with the whole tool input
 * and the new command, and no permission decision, so the agent's own
 * permission rules still apply to the rewritten command. With routing off
 * in the gate's settings, the command runs as it is.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hookCommands } from "../../../src/shared/agents/guardrails.js";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const dir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-route-")),
);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const settings = path.join(dir, "settings.json");
const GATE = "/opt/den/bin/den";

function run(
  tool_input: Record<string, unknown>,
  args: string[] = ["--gate", GATE, "--gate-settings", settings],
): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    input: JSON.stringify({ tool_name: "Bash", tool_input, cwd: dir }),
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("issue 1264: the hook sends an agent's heavy run through the gate", () => {
  it("npx jest: the whole input back, its command gated, no permission decision", () => {
    fs.rmSync(settings, { force: true });
    const r = run({
      command: "npx jest a.test.ts",
      description: "Run one test",
      timeout: 600000,
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    const u = out.hookSpecificOutput.updatedInput;
    expect(u.description).toBe("Run one test");
    expect(u.timeout).toBe(600000);
    expect(u.command).toMatch(
      /^\/opt\/den\/bin\/den gate run --kind cpu --label 'agent: jest' -- bash -c 'npx jest --maxWorkers=\$\{DEN_GATE_WORKERS:-1\} a\.test\.ts'$/,
    );
  });

  it("npx playwright test is a browser run", () => {
    const u = JSON.parse(run({ command: "npx playwright test e" }).stdout)
      .hookSpecificOutput.updatedInput;
    expect(u.command).toContain("gate run --kind browser ");
  });

  it("already gated, or nothing heavy: no output, the command as it is", () => {
    for (const command of [
      "ops gate run -- npx jest a.test.ts",
      "git status",
    ]) {
      const r = run({ command });
      expect([r.code, r.stdout]).toEqual([0, ""]);
    }
  });

  it("routing off in the gate's settings: the command runs as it is", () => {
    fs.writeFileSync(settings, JSON.stringify({ route_agents: false }));
    const r = run({ command: "npx jest a.test.ts" });
    expect([r.code, r.stdout]).toEqual([0, ""]);
    fs.rmSync(settings, { force: true });
  });

  it("the settings' list is the one used", () => {
    fs.writeFileSync(settings, JSON.stringify({ route_commands: ["tsc"] }));
    expect(run({ command: "npx jest a.test.ts" }).stdout).toBe("");
    expect(run({ command: "npx tsc -p ." }).stdout).toContain("--kind cpu");
    fs.rmSync(settings, { force: true });
  });

  it("no --gate (an install with no CLI found): nothing is rewritten", () => {
    expect(run({ command: "npx jest a.test.ts" }, []).stdout).toBe("");
  });

  it("a blocked command stays blocked (the sleep rule first)", () => {
    const r = run({ command: "sleep 30 && npx jest a.test.ts" });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
  });
});

describe("issue 1264: an agent's hook is launched with the gate's arguments", () => {
  it("hookCommands passes --gate <cli> and --gate-settings <file> to the PreToolUse hook", () => {
    const h = hookCommands(
      "/g",
      "/usr/bin/node",
      undefined,
      [],
      true,
      undefined,
      undefined,
      { cli: "/opt/den/bin/den", settings: "/s/settings.json" },
    );
    expect(h.pretooluse).toBe(
      "/usr/bin/node /g/pretooluse.mjs --gate /opt/den/bin/den --gate-settings /s/settings.json",
    );
  });

  it("with no CLI found (no gate argument), the hook has none", () => {
    expect(hookCommands("/g", "/usr/bin/node").pretooluse).toBe(
      "/usr/bin/node /g/pretooluse.mjs",
    );
  });
});
