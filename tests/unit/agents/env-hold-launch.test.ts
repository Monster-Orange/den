import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_ENV_HOLD,
  ENV_HOLD_FILE,
  PERSON_CREDENTIAL_NAMES,
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
const hold = {
  on: true,
  hold: [...DEFAULT_ENV_HOLD],
  allow: [],
  own: [],
  guard: true,
};

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

  it("its PreToolUse hook gets the masked set from env-hold.ts, on its own and with a persona's guardrails off", () => {
    const mask = [
      "--env-mask",
      "*_TOKEN,DEN_PERSON_TOKEN",
      "--env-mask-values",
      "*den_pt_*",
    ];
    for (const p of [planner, bare]) {
      const cmd = launch(p, { ...hold, mask }).pretool.join(" ");
      expect(cmd).toContain("'--env-mask' '*_TOKEN,DEN_PERSON_TOKEN'");
      expect(cmd).toContain("'--env-mask-values' '*den_pt_*'");
    }
    expect(
      launch(planner, { ...hold, mask, guard: false }).pretool.join(" "),
    ).not.toContain("--env-mask");
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

describe("an agent from before the hold", () => {
  it("gets an env-hold.sh that holds back only a person's credential, and keeps the guard", () => {
    const l = launch(planner, { ...hold, on: false, hold: [] });
    const file = path.join(root, "files", "planner", ENV_HOLD_FILE);
    expect(l.env.CLAUDE_ENV_FILE).toBe(file);
    expect(l.pretool.length).toBeGreaterThan(0);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, l.files[file]);
    const person = PERSON_CREDENTIAL_NAMES[0];
    for (const shell of ["/bin/bash", "/bin/zsh"].filter((x) =>
      fs.existsSync(x),
    )) {
      const r = spawnSync(
        shell,
        [
          "-c",
          `export ${person}=den_pt_x GH_TOKEN=gh-kept; . ${file}; echo "\${${person}-gone} $GH_TOKEN"`,
        ],
        {
          encoding: "utf-8",
          env: { PATH: "/usr/bin:/bin", HOME: root, ZDOTDIR: root },
        },
      );
      expect([shell, r.stdout.trim()]).toEqual([shell, "gone gh-kept"]);
    }
  });
});
