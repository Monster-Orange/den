/**
 * Issue 974 in a den-claude launch: the script that holds secret-looking
 * variables out of each shell command is written to the agent's files
 * folder and named by CLAUDE_ENV_FILE; the env guard is in its PreToolUse
 * hook (on by default, --no-env-guard when agents.env_guard is false),
 * also for a persona whose other guardrails are off. No value reaches the
 * launch command or its prompt.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_ENV_HOLD,
  ENV_HOLD_FILE,
} from "../../../src/shared/agents/env-hold.js";
import {
  loadPersonas,
  type Persona,
} from "../../../src/shared/agents/personas.js";
import {
  getRuntime,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";

const CANARY = "canary-7f3e1d-not-a-real-secret";
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-env-launch-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function launch(
  persona: Persona,
  envHold: LaunchInput["envHold"],
): {
  argv: string[];
  env: Record<string, string>;
  files: Record<string, string>;
  pretool: string[];
} {
  const filesDir = path.join(root, "files", persona.id);
  const out = getRuntime("den-claude")!.launch({
    persona,
    workspace: { name: "north", dir: root },
    agentId: persona.id,
    worktree: root,
    mcp: { name: "acme", command: ["/x/acme", "mcp"], env: {}, scope: "north" },
    filesDir,
    env: { CANARY_TOKEN: CANARY, PATH: "/bin" },
    bin: "/nowhere/claude",
    firstPrompt: "Start.",
    envHold,
  });
  const settingsFile = path.join(filesDir, "settings.json");
  const settings = out.files?.[settingsFile]
    ? (JSON.parse(out.files[settingsFile]) as {
        hooks?: Record<
          string,
          { matcher?: string; hooks: { command: string }[] }[]
        >;
      })
    : {};
  return {
    argv: out.argv,
    env: out.env,
    files: out.files ?? {},
    pretool: (settings.hooks?.PreToolUse ?? [])
      .filter((h) => (h.matcher ?? "").split("|").includes("Bash"))
      .flatMap((h) => h.hooks.map((x) => x.command)),
  };
}

const planner = loadPersonas([]).get("planner")!;
const bare: Persona = {
  ...planner,
  id: "bare",
  guardrails: { hooks: false, instructions: false },
};
const hold = { hold: [...DEFAULT_ENV_HOLD], allow: [], guard: true };

describe("a launch with the hold", () => {
  it("writes env-hold.sh in its files folder and names it in CLAUDE_ENV_FILE", () => {
    const l = launch(planner, hold);
    const file = path.join(root, "files", "planner", ENV_HOLD_FILE);
    expect(l.env.CLAUDE_ENV_FILE).toBe(file);
    expect(l.files[file]).toMatch(/unset/);
    expect(l.files[file]).not.toContain(CANARY);
  });

  it("no canary in its command line or its first prompt", () => {
    const l = launch(planner, hold);
    expect(l.argv.join("\n")).not.toContain(CANARY);
    expect(Object.values(l.env)).not.toContain(CANARY);
  });

  it("its PreToolUse hook has the env guard on (no --no-env-guard)", () => {
    const l = launch(planner, hold);
    expect(l.pretool.length).toBeGreaterThan(0);
    expect(l.pretool.join(" ")).not.toContain("--no-env-guard");
  });

  it("agents.env_guard: false passes --no-env-guard", () => {
    const l = launch(planner, { ...hold, guard: false });
    expect(l.pretool.join(" ")).toContain("--no-env-guard");
  });

  it("a persona with its guardrails off still gets the env guard, alone", () => {
    const l = launch(bare, hold);
    expect(l.pretool).toHaveLength(1);
    expect(l.pretool[0]).toContain("pretooluse.mjs");
    expect(l.pretool[0]).toContain("--no-guardrails");
    expect(l.pretool[0]).not.toContain("--no-env-guard");
  });

  it("with its guardrails off and the guard off, no PreToolUse hook is added", () => {
    const l = launch(bare, { ...hold, guard: false });
    expect(l.pretool).toEqual([]);
  });
});
