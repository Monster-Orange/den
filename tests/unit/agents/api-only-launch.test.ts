/**
 * D47 at launch: a service whose manifest says `agents: api_only` becomes
 * a rule in Den's rules file, and every den-claude agent's PreToolUse hook
 * reads it: with Den's guardrails (the file tools seen too) or, for a
 * persona without them, a hook with the API-only check alone.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  apiOnlyService,
  readApiOnlyAudit,
  writeApiOnlyRules,
  apiOnlyEngines,
} from "../../../src/shared/agents/api-only.js";
import {
  loadPersonas,
  type Persona,
} from "../../../src/shared/agents/personas.js";
import {
  getRuntime,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";
import type { RawManifest } from "../../../src/shared/types/index.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-apionly-l-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const repo = path.join(root, "vault");
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(
  path.join(repo, "compose.yaml"),
  [
    "services:",
    "  db:",
    "    container_name: vaultdb",
    "  api: {}",
    "volumes:",
    "  store:",
    "    name: vault-store",
    "  data: {}",
    "",
  ].join("\n"),
);

const manifest = (more: Partial<RawManifest>): RawManifest =>
  ({ name: "vault", ...more }) as RawManifest;

describe("D47: a manifest's api_only becomes a rule", () => {
  it("names its project, compose names, data paths (from the repo, ~ is home) and machine", () => {
    const s = apiOnlyService(
      repo,
      manifest({
        agents: "api_only",
        data_paths: ["var/db", "~/vault-data"],
        machine: "vaultvm",
      }),
      "/home/x",
    );
    expect(s).toEqual({
      name: "vault",
      project: "vault",
      containers: ["vaultdb"],
      volumes: ["vault-store"],
      composeServices: ["db", "api"],
      composeVolumes: ["data"],
      paths: [path.join(repo, "var", "db"), "/home/x/vault-data"],
      machine: "vaultvm",
    });
  });

  it("a compose name is its project", () => {
    const s = apiOnlyService(
      repo,
      manifest({
        agents: "api_only",
        compose: { name: "vlt" },
      } as Partial<RawManifest>),
    );
    expect(s?.project).toBe("vlt");
  });

  it("agents.api_only_engines adds engines and their folders; a bad entry is left out", () => {
    expect(
      apiOnlyEngines({
        clis: ["boxer", "my-engine.2", "rm -rf", 3, ""],
        dirs: ["~/.boxer", "/opt/boxer/vols", "relative/dir", 7],
      }),
    ).toEqual({
      engines: ["boxer", "my-engine.2"],
      engineDirs: ["~/.boxer", "/opt/boxer/vols"],
    });
    for (const none of [undefined, null, "boxer", [], { clis: "boxer" }])
      expect(apiOnlyEngines(none)).toEqual({});
  });

  it("the rules file carries the extra engines for the hook", () => {
    const state = path.join(root, "state-e");
    const files = writeApiOnlyRules(state, {
      services: [apiOnlyService(repo, manifest({ agents: "api_only" }))!],
      engines: ["boxer"],
      engineDirs: ["~/.boxer"],
    })!;
    const r = JSON.parse(fs.readFileSync(files.rules, "utf-8"));
    expect(r.engines).toEqual(["boxer"]);
    expect(r.engineDirs).toEqual(["~/.boxer"]);
  });

  it("without agents: api_only, no rule", () => {
    expect(apiOnlyService(repo, manifest({}))).toBeNull();
    expect(apiOnlyService(repo, null)).toBeNull();
  });

  it("the rules file is 0600; with no service it is removed", () => {
    const state = path.join(root, "state-w");
    const files = writeApiOnlyRules(state, {
      services: [apiOnlyService(repo, manifest({ agents: "api_only" }))!],
    })!;
    expect(fs.statSync(files.rules).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(fs.readFileSync(files.rules, "utf-8")).services[0].name,
    ).toBe("vault");
    expect(writeApiOnlyRules(state, { services: [] })).toBeNull();
    expect(fs.existsSync(files.rules)).toBe(false);
  });

  it("reads the audit back, newest last, past a torn line", () => {
    const state = path.join(root, "state-a");
    fs.mkdirSync(path.join(state, "audit"), { recursive: true });
    fs.writeFileSync(
      path.join(state, "audit", "api-only.jsonl"),
      '{"service":"vault","what":"a"}\n{"torn\n{"service":"vault","what":"b"}\n',
    );
    expect(readApiOnlyAudit(state).map((r) => r.what)).toEqual(["a", "b"]);
  });
});

function launch(persona: Persona, apiOnly?: LaunchInput["apiOnly"]) {
  const inp: LaunchInput = {
    persona,
    workspace: { name: "north", dir: root },
    agentId: persona.id,
    worktree: root,
    mcp: { name: "acme", command: ["/x/acme", "mcp"], env: {}, scope: "north" },
    filesDir: path.join(root, "files", persona.id),
    stateDir: path.join(root, "state"),
    env: {},
    bin: "/nowhere/claude",
    ...(apiOnly ? { apiOnly } : {}),
  };
  const out = getRuntime("den-claude")!.launch(inp);
  const f = path.join(inp.filesDir, "settings.json");
  const settings = JSON.parse(out.files![f]) as {
    hooks?: Record<
      string,
      { matcher?: string; hooks: { command: string }[] }[]
    >;
  };
  return settings.hooks;
}

describe("D47: every den-claude agent's hook reads the rules", () => {
  const apiOnly = {
    rules: "/s/guardrails/api-only.json",
    audit: "/s/audit/api-only.jsonl",
  };
  const planner = loadPersonas([]).get("planner")!;

  it("with Den's guardrails: the same hook, given the rules, sees the file tools", () => {
    const h = launch(planner, apiOnly)!;
    const pre = h.PreToolUse[0];
    expect(pre.matcher).toBe(
      "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob",
    );
    expect(pre.hooks[0].command).toContain("--api-only");
    expect(pre.hooks[0].command).toContain(apiOnly.rules);
    expect(pre.hooks[0].command).toContain(apiOnly.audit);
    expect(pre.hooks[0].command).not.toContain("--no-guardrails");
    expect(Object.keys(h).sort()).toEqual([
      "PreCompact",
      "PreToolUse",
      "SessionStart",
      "Stop",
    ]);
  });

  it("with no rules, the hook is as before", () => {
    const pre = launch(planner)!.PreToolUse[0];
    expect(pre.matcher).toBe("Bash|Read");
    expect(pre.hooks[0].command).not.toContain("--api-only");
  });

  it("a persona without Den's hooks still gets the API-only check, and only it", () => {
    const dir = path.join(root, "pack");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "quiet.md"),
      "---\nname: quiet\nden_hooks: false\n---\nYou plan.\n",
    );
    const quiet = loadPersonas([dir]).get("quiet")!;
    expect(quiet.guardrails?.hooks).toBe(false);
    expect(launch(quiet)).toBeUndefined();
    const h = launch(quiet, apiOnly)!;
    expect(Object.keys(h)).toEqual(["PreToolUse"]);
    expect(h.PreToolUse[0].hooks[0].command).toContain("--no-guardrails");
    expect(h.PreToolUse[0].hooks[0].command).toContain(apiOnly.rules);
  });
});

describe("D47: agents doctor says what is API-only, where it's enforced, and that it's a guardrail", () => {
  it("none declared: one line saying how to declare one", async () => {
    const { apiOnlyLines } =
      await import("../../../src/ui/cli/agents-command.js");
    expect(apiOnlyLines({ services: [] }, [], [])).toEqual([
      "API-only services  none declared (a service's manifest says `agents: api_only`)",
    ]);
  });

  it("each service, den-claude enforcing as a guardrail, codex and gemini not enforced, the last denial", async () => {
    const { apiOnlyLines } =
      await import("../../../src/ui/cli/agents-command.js");
    const lines = apiOnlyLines(
      {
        services: [
          {
            name: "vault",
            project: "vault",
            containers: ["vaultdb"],
            volumes: [],
            composeServices: ["api", "db"],
            composeVolumes: ["data"],
            paths: ["/srv/vault"],
            machine: "vaultvm",
          },
        ],
      },
      [
        { id: "den-claude", available: true },
        { id: "codex", available: true },
        { id: "gemini", available: true },
        { id: "grok", available: false },
      ],
      [
        {
          at: "2026-11-11T21:00:00Z",
          agent: "planner",
          what: "docker exec vault-api-1",
          service: "vault",
        },
      ],
    );
    const text = lines.join("\n");
    expect(lines[1]).toBe(
      "  vault: project vault; containers vault-{api,db}-N, vaultdb; volumes vault_{data}; data /srv/vault; machine vaultvm (and ~/OrbStack, ~/.orbstack)",
    );
    expect(text).toMatch(/enforced +den-claude: a guardrail, not a boundary/);
    expect(text).toMatch(
      /not enforced +codex, gemini: API-only isn't enforced for this runtime/,
    );
    expect(text).not.toMatch(/grok/);
    expect(text).toMatch(
      /denied +1 recently; the last at 2026-11-11T21:00:00Z: planner, docker exec vault-api-1 \(vault\)/,
    );
  });
});
