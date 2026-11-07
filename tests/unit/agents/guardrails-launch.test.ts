/**
 * Guardrails reach a launch (den#5): a default-pack persona's den-claude
 * launch carries Den's hooks in its own --settings file (PreToolUse on Bash
 * and Read, and Stop), and its role prompt carries the shared persona
 * instructions. A distribution's pack gets neither unless it opts in, and
 * any persona or pack can turn either off.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  guardrailHooks,
  sharedInstructions,
} from "../../../src/shared/agents/guardrails.js";
import {
  DEFAULT_PACK_DIR,
  loadPersonas,
  type Persona,
} from "../../../src/shared/agents/personas.js";
import {
  getRuntime,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-guard-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function pack(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files))
    fs.writeFileSync(path.join(dir, f), body);
  return dir;
}

function input(persona: Persona, stateDir?: string): LaunchInput {
  return {
    persona,
    workspace: { name: "north", dir: root },
    agentId: persona.id,
    worktree: root,
    mcp: { name: "acme", command: ["/x/acme", "mcp"], env: {}, scope: "north" },
    filesDir: path.join(root, "files", persona.id),
    ...(stateDir ? { stateDir } : {}),
    env: {},
    bin: "/nowhere/claude",
  };
}

function launch(persona: Persona, stateDir?: string) {
  const inp = input(persona, stateDir);
  const out = getRuntime("den-claude")!.launch(inp);
  const settings = path.join(inp.filesDir, "settings.json");
  return {
    argv: out.argv,
    prompt: out.argv[out.argv.length - 1],
    settings: out.files?.[settings]
      ? (JSON.parse(out.files[settings]) as Record<string, unknown>)
      : null,
  };
}

describe("a default-pack persona's launch", () => {
  const planner = loadPersonas([]).get("planner")!;

  it("has both guardrails on", () => {
    expect(planner.source.startsWith(DEFAULT_PACK_DIR)).toBe(true);
    expect(planner.guardrails).toEqual({ hooks: true, instructions: true });
  });

  it("passes Den's hooks in its own settings file, beside the deny rules", () => {
    const l = launch(planner, path.join(root, "state"));
    const hooks = l.settings!.hooks as Record<
      string,
      { matcher?: string; hooks: { type: string; command: string }[] }[]
    >;
    expect(Object.keys(hooks).sort()).toEqual(["PreToolUse", "Stop"]);
    expect(hooks.PreToolUse[0].matcher).toBe("Bash|Read");
    expect(hooks.PreToolUse[0].hooks[0].type).toBe("command");
    expect(hooks.PreToolUse[0].hooks[0].command).toContain(
      path.join("guardrails", "pretooluse.mjs"),
    );
    expect(hooks.Stop[0].hooks[0].command).toContain(
      path.join("guardrails", "stop-hook"),
    );
    expect(l.settings!.permissions).toBeDefined();
    expect(hooks).toEqual(guardrailHooks());
    // Never the user's own Claude Code config.
    expect(JSON.stringify(l.settings)).not.toContain(".claude/settings");
  });

  it("writes the settings file for the hooks even with no state dir", () => {
    const l = launch(planner);
    expect(l.argv).toContain("--settings");
    expect(l.settings).toEqual({ hooks: guardrailHooks() });
  });

  it("appends the shared persona instructions to the role prompt", () => {
    const l = launch(planner);
    expect(l.prompt).toContain(planner.prompt);
    expect(l.prompt.endsWith(sharedInstructions())).toBe(true);
    for (const s of [
      "Use short sentences.",
      "numbered yes/no question",
      "No caveat sections.",
      "- URL:",
      "- Machine:",
      "- Branch:",
      "- What changed:",
      "- What to click:",
      "- Decisions:",
    ])
      expect(l.prompt).toContain(s);
  });
});

describe("the hook commands in the settings file run as Claude Code runs them", () => {
  const hooks = guardrailHooks() as Record<
    string,
    { hooks: { command: string }[] }[]
  >;
  const sh = (command: string, input: unknown) =>
    spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: root },
    });

  it("PreToolUse blocks a polling loop (exit 2, reason on stderr)", () => {
    const r = sh(hooks.PreToolUse[0].hooks[0].command, {
      tool_name: "Bash",
      tool_input: { command: "until curl -s localhost:3000; do sleep 2; done" },
      cwd: root,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/run_in_background/);
  });

  it("Stop blocks an incomplete hand-back with Claude Code's decision JSON", () => {
    const r = sh(hooks.Stop[0].hooks[0].command, {
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "## Hand-back\n- URL: https://x.example\n",
    });
    expect(r.status).toBe(0);
    const o = JSON.parse(r.stdout) as { decision: string; reason: string };
    expect(o.decision).toBe("block");
    expect(o.reason).toMatch(/Missing "Machine:"/);
  });
});

describe("turning guardrails off and on", () => {
  const own = pack("personas", {
    "writer.md": "---\nname: writer\n---\nYou write.\n",
    "quiet.md":
      "---\nname: quiet\nden_hooks: false\nden_instructions: false\n---\nYou plan.\n",
  });
  const optIn = pack("opt-in", {
    "tester.md": "---\nname: tester\n---\nYou test.\n",
    "loose.md": "---\nname: loose\nden_hooks: false\n---\nYou test.\n",
  });

  it("a distribution's pack has none unless the pack opts in", () => {
    const all = loadPersonas([own, optIn], undefined, {
      packs: [undefined, { hooks: true, instructions: true }],
    });
    expect(all.get("writer")!.guardrails).toEqual({
      hooks: false,
      instructions: false,
    });
    expect(launch(all.get("writer")!).settings).toBeNull();
    expect(launch(all.get("writer")!).prompt).not.toContain("Hand-back");
    expect(all.get("tester")!.guardrails).toEqual({
      hooks: true,
      instructions: true,
    });
  });

  it("a persona's den_hooks / den_instructions win over its pack", () => {
    const all = loadPersonas([own, optIn], undefined, {
      packs: [undefined, { hooks: true, instructions: true }],
    });
    expect(all.get("loose")!.guardrails).toEqual({
      hooks: false,
      instructions: true,
    });
    expect(launch(all.get("loose")!).settings).toBeNull();
  });

  it("agents.default_pack turns them off for Den's pack", () => {
    const all = loadPersonas([], undefined, {
      defaultPack: { hooks: false },
    });
    expect(all.get("planner")!.guardrails).toEqual({
      hooks: false,
      instructions: true,
    });
    expect(launch(all.get("planner")!).settings).toBeNull();
  });

  it("a persona_packs entry that overrides a default persona has its pack's", () => {
    const over = pack("override", {
      "planner.md": "---\nname: planner\n---\nOur planner.\n",
    });
    expect(loadPersonas([over]).get("planner")!.guardrails).toEqual({
      hooks: false,
      instructions: false,
    });
  });

  it("den_hooks must be true or false", () => {
    const bad = pack("bad", {
      "x.md": "---\nname: x\nden_hooks: maybe\n---\nx\n",
    });
    expect(() => loadPersonas([bad])).toThrow(
      /den_hooks must be true or false/,
    );
  });
});

describe("agents: config for guardrails", () => {
  const cfg = (agents: unknown) =>
    readAgentsConfig({ environments: [], agents } as never);

  it("reads default_pack and persona_packs mappings", () => {
    const r = cfg({
      default_pack: { hooks: false },
      persona_packs: ["personas", { path: "more", hooks: true }],
    });
    expect(r.defaultPackGuardrails).toEqual({ hooks: false });
    expect(r.personaPacks).toEqual(["personas", "more"]);
    expect(r.packGuardrails).toEqual([undefined, { hooks: true }]);
  });

  it("refuses a typo or a non-boolean, naming the key", () => {
    expect(() => cfg({ default_pack: { hook: false } })).toThrow(
      /agents\.default_pack\.hook: unknown key/,
    );
    expect(() => cfg({ default_pack: { hooks: "no" } })).toThrow(
      /agents\.default_pack\.hooks: must be true or false/,
    );
    expect(() => cfg({ persona_packs: [{ hooks: true }] })).toThrow(
      /agents\.persona_packs\[0\]: must be a non-empty path/,
    );
    expect(() =>
      cfg({ persona_packs: [{ path: "p", instructions: 1 }] }),
    ).toThrow(
      /agents\.persona_packs\[0\]\.instructions: must be true or false/,
    );
  });
});
