/**
 * Issue 974 (2): Den's PreToolUse hook refuses a shell command that prints
 * the whole environment, says why and what to run instead; a command for
 * one variable passes, and agents.env_guard: false (the hook's
 * --no-env-guard) turns the refusal off. It runs even when a persona's
 * other guardrails are off (--no-guardrails).
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");

function bash(
  command: string,
  flags: string[] = [],
): { code: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [HOOK, ...flags], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: "/",
    }),
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: "/nowhere" },
  });
  return { code: r.status, stderr: r.stderr };
}

describe("commands that print the whole environment are refused", () => {
  it.each([
    "env",
    "printenv",
    "set",
    "/usr/bin/env",
    "/usr/bin/printenv",
    "   env",
    "env;",
    "env; echo done",
    "env | grep TOKEN",
    "env | sort",
    "echo start && env",
    "env > /tmp/e.txt",
    "env -0",
    "env -u PATH",
    "printenv -0",
    "export",
    "export -p",
    "declare -x",
    "declare -p",
    "declare",
    "typeset -x",
    "typeset",
    "command env",
    "(env)",
  ])("`%s` is refused, saying why and what to run instead", (cmd) => {
    const r = bash(cmd);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/prints the whole environment/);
    expect(r.stderr).toMatch(/printenv NAME/);
  });

  it.each([
    "printenv HOME",
    "printenv PATH HOME",
    "echo $HOME",
    "env FOO=1 node -v",
    "env -i PATH=/bin ls",
    "export FOO=1",
    "export FOO",
    "declare -x FOO=1",
    "set -e",
    "set -euo pipefail; ls",
    "set -- a b",
    "git log --format=%G?",
    "cat environment.md",
  ])("`%s` passes", (cmd) => {
    expect(bash(cmd).code).toBe(0);
  });

  it("agents.env_guard: false (--no-env-guard) turns it off", () => {
    expect(bash("env", ["--no-env-guard"]).code).toBe(0);
    expect(bash("printenv", ["--no-env-guard"]).code).toBe(0);
  });

  it("it still refuses with a persona's other guardrails off (--no-guardrails)", () => {
    expect(bash("env", ["--no-guardrails"]).code).toBe(2);
    // The other guardrails are off there: a sleep passes.
    expect(bash("sleep 5", ["--no-guardrails"]).code).toBe(0);
  });
});
