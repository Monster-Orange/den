import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");

function bash(
  command: string,
  flags: string[] = [],
): { code: number | null; stderr: string; rewritten: string | null } {
  const r = spawnSync(process.execPath, [HOOK, ...flags], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: "/",
    }),
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: "/nowhere" },
  });
  let rewritten: string | null = null;
  try {
    rewritten =
      JSON.parse(r.stdout).hookSpecificOutput?.updatedInput?.command ?? null;
  } catch {
    rewritten = null;
  }
  return { code: r.status, stderr: r.stderr, rewritten };
}

describe("commands that print the environment run, masked", () => {
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
    "printenv HOME",
    "printenv PATH HOME",
  ])("`%s` runs through Den's masker, never refused", (cmd) => {
    const r = bash(cmd);
    expect(r.code).toBe(0);
    expect(r.rewritten).toMatch(/\} \| .*env-mask\.mjs/);
  });

  it.each([
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
  ])("`%s` is left as it is", (cmd) => {
    const r = bash(cmd);
    expect(r.code).toBe(0);
    expect(r.rewritten).toBeNull();
  });

  it("agents.env_guard: false (--no-env-guard) turns it off", () => {
    expect(bash("env", ["--no-env-guard"]).rewritten).toBeNull();
    expect(bash("printenv", ["--no-env-guard"]).rewritten).toBeNull();
  });

  it("it still masks with a persona's other guardrails off (--no-guardrails)", () => {
    expect(bash("env", ["--no-guardrails"]).rewritten).toMatch(/env-mask/);
    expect(bash("sleep 5", ["--no-guardrails"]).code).toBe(0);
  });
});
