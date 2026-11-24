/**
 * Runtimes (AG-2a, AG spec §4): den-claude and generic, registered as
 * strategy kind `runtime`. `claude` is a PATH shim that records any run, so
 * the test proves detect and launch never run it.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Persona } from "../../../src/shared/agents/personas.js";
import {
  getRuntime,
  RUNTIME_KIND,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";
import {
  ownFilesDenyRules,
  stateDirDenyRules,
} from "../../../src/shared/agents/den-claude.js";
import { HUB_HEADERS_HELPER } from "../../../src/ui/cli/agent-ops.js";
import { denied, readDenied } from "./helpers/claude-rules.js";
import {
  getStrategy,
  strategyIds,
} from "../../../src/shared/strategies/registry.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-rt-")));
  tmps.push(d);
  return d;
}

/** A `claude` on PATH that only records that it ran. */
function shim(layout: "native" | "npm" | "plain" = "native"): {
  env: NodeJS.ProcessEnv;
  bin: string;
  ran: string;
} {
  const dir = tmp();
  const ran = path.join(dir, "ran");
  const script = `#!/bin/sh\necho "$@" >> "${ran}"\nexit 1\n`;
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  let target: string;
  if (layout === "native") {
    target = path.join(dir, "share", "claude", "versions", "9.8.7");
  } else if (layout === "npm") {
    const pkg = path.join(
      dir,
      "lib",
      "node_modules",
      "@anthropic-ai",
      "claude-code",
    );
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@anthropic-ai/claude-code", version: "1.2.3" }),
    );
    target = path.join(pkg, "cli.js");
  } else target = path.join(binDir, "claude");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, script, { mode: 0o755 });
  const bin = path.join(binDir, "claude");
  if (target !== bin) fs.symlinkSync(target, bin);
  return { env: { PATH: `${binDir}:/usr/bin:/bin` }, bin, ran };
}

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: "planner",
  role: "Writes stories.",
  prompt: "You plan the work.",
  standing: true,
  tools: [],
  context: ["docs/specs"],
  source: "/pack/planner.md",
  ...over,
});

function input(over: Partial<LaunchInput> = {}): LaunchInput {
  const filesDir = path.join(tmp(), "agent-files", "planner");
  return {
    persona: persona(),
    workspace: { name: "north", dir: "/w/north" },
    agentId: "planner",
    worktree: "/w/north",
    mcp: {
      name: "acme",
      command: [
        "/dist/bin/acme",
        "mcp",
        "--workspace",
        "north",
        "--actor",
        "agent:planner",
      ],
      env: { PATH: "/usr/bin:/bin" },
      scope: "north",
    },
    filesDir,
    stateDir: "/home/someone/.acme",
    env: {},
    ...over,
  };
}

describe("registry", () => {
  it("den-claude and generic are strategies of kind runtime", () => {
    expect(RUNTIME_KIND).toBe("runtime");
    expect(strategyIds("runtime")).toEqual(
      expect.arrayContaining(["den-claude", "generic"]),
    );
    expect(getStrategy("runtime", "den-claude")?.capabilities).toBe(
      getRuntime("den-claude"),
    );
  });
});

describe("den-claude detect", () => {
  it("finds claude on PATH and reads its version from the install, running nothing", () => {
    const native = shim("native");
    const found = (s: { env: NodeJS.ProcessEnv; bin: string }) => ({
      available: true,
      path: s.bin,
      source: "PATH",
      searched: [path.dirname(s.bin), "/usr/bin", "/bin"],
    });
    expect(getRuntime("den-claude")!.detect(native.env, { bin: null })).toEqual(
      { ...found(native), version: "9.8.7" },
    );
    const npm = shim("npm");
    expect(getRuntime("den-claude")!.detect(npm.env, { bin: null })).toEqual({
      ...found(npm),
      version: "1.2.3",
    });
    const plain = shim("plain");
    expect(getRuntime("den-claude")!.detect(plain.env, { bin: null })).toEqual(
      found(plain),
    );
    for (const s of [native, npm, plain])
      expect(fs.existsSync(s.ran)).toBe(false);
  });

  it("without claude on PATH it says so, and where it looked", () => {
    const dir = tmp();
    expect(
      getRuntime("den-claude")!.detect({ PATH: dir }, { bin: null }),
    ).toEqual({
      available: false,
      why: "claude not found (searched 1 directory)",
      searched: [dir],
    });
    expect(getStrategy("runtime", "den-claude")!.detect({ PATH: dir })).toEqual(
      { available: false, reason: "claude not found (searched 1 directory)" },
    );
  });
});

describe("den-claude launch", () => {
  it("D24: names the Claude session for peers, on launch and on resume", () => {
    const s = shim();
    const rt = getRuntime("den-claude")!;
    const out = rt.launch(
      input({ env: s.env, sessionLabel: "acme-north:planner" }),
    );
    expect(out.argv.slice(1, 5)).toEqual([
      "--session-id",
      out.resumeToken,
      "--name",
      "acme-north:planner",
    ]);
    const back = rt.resume!(
      input({
        env: s.env,
        resumeToken: out.resumeToken,
        sessionLabel: "acme-north:Night watch",
      }),
    )!;
    expect(back.argv.slice(1, 5)).toEqual([
      "--resume",
      out.resumeToken,
      "--name",
      "acme-north:Night watch",
    ]);
    // Without a label, no --name.
    expect(rt.launch(input({ env: s.env })).argv).not.toContain("--name");
  });

  it("den#265: with claude.ai connectors on, no --strict-mcp-config, and every other MCP server stays out", () => {
    const s = shim();
    const home = tmp();
    const work = tmp();
    // The person's own MCP servers: user scope, and local scope for this folder.
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { stray: { command: "x" }, acme: { command: "y" } },
        projects: {
          [work]: { mcpServers: { "local-one": { command: "z" } } },
          "/elsewhere": { mcpServers: { "not-here": { command: "q" } } },
        },
      }),
    );
    // A project's own .mcp.json.
    fs.writeFileSync(
      path.join(work, ".mcp.json"),
      JSON.stringify({ mcpServers: { "proj-one": { command: "p" } } }),
    );
    const env = { ...s.env, HOME: home };
    const on = getRuntime("den-claude")!.launch(
      input({ env, worktree: work, claudeAiConnectors: true }),
    );
    expect(on.argv).not.toContain("--strict-mcp-config");
    const settingsFile = on.argv[on.argv.indexOf("--settings") + 1];
    const st = JSON.parse(on.files![settingsFile]) as Record<string, unknown>;
    expect("disableClaudeAiConnectors" in st).toBe(false);
    // Den's own server keeps its name; the rest are denied by name.
    expect(st.deniedMcpServers).toEqual([
      { serverName: "local-one" },
      { serverName: "stray" },
    ]);
    expect(st.enableAllProjectMcpServers).toBe(false);
    expect(st.disabledMcpjsonServers).toEqual(["proj-one"]);
    // Off: strict as before, and nothing else changes.
    const off = getRuntime("den-claude")!.launch(
      input({ env, worktree: work }),
    );
    expect(off.argv).toContain("--strict-mcp-config");
    const offSt = JSON.parse(
      off.files![off.argv[off.argv.indexOf("--settings") + 1]],
    ) as Record<string, unknown>;
    expect(offSt.disableClaudeAiConnectors).toBe(true);
    expect("deniedMcpServers" in offSt).toBe(false);
  });

  it("points Claude Code at Den's scoped MCP and passes the role prompt", () => {
    const s = shim();
    const inp = input({ env: s.env, model: "opus" });
    const out = getRuntime("den-claude")!.launch(inp);
    const mcpFile = path.join(inp.filesDir, "mcp.json");
    const settingsFile = path.join(inp.filesDir, "settings.json");
    expect(out.argv[0]).toBe(s.bin);
    expect(out.argv).toEqual([
      s.bin,
      "--session-id",
      out.resumeToken,
      "--mcp-config",
      mcpFile,
      "--strict-mcp-config",
      "--settings",
      settingsFile,
      "--permission-mode",
      "default",
      "--model",
      "opus",
      "--append-system-prompt",
      expect.stringContaining("You plan the work."),
    ]);
    expect(out.resumeToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const prompt = out.argv[out.argv.length - 1];
    expect(prompt).toMatch(/agent planner in project north/);
    expect(prompt).toMatch(/docs\/specs/);
    // NT-1: how it asks its person for a decision.
    expect(prompt).toMatch(/call ask_human .* then end your turn/);
    // Issue 1371: a setting is asked for, never handed over as a YAML edit.
    expect(prompt).toMatch(
      /When one of Den's settings needs changing, ask for it with setting_change.*Never hand your person a YAML edit/,
    );
    expect(out.env).toEqual({});
    expect(Object.keys(out.files ?? {})).toEqual([mcpFile, settingsFile]);
    // SEC-1 §6c.1: Den's state dir is denied to the agent (binds a
    // cooperating agent only): Read, and any command naming web.secret or
    // sessions/.
    expect(JSON.parse(out.files![settingsFile])).toEqual({
      permissions: {
        deny: [
          // Issue 362: the files it was launched with.
          ...ownFilesDenyRules([settingsFile, mcpFile]),
          ...stateDirDenyRules("/home/someone/.acme"),
        ],
      },
      // den#3: the account's claude.ai connectors stay out.
      disableClaudeAiConnectors: true,
    });
    expect(stateDirDenyRules("/home/someone/.acme")).toEqual(
      expect.arrayContaining([
        "Read(//home/someone/.acme/web.secret)",
        "Read(//home/someone/.acme/sessions/**)",
        // Any command naming the path (Claude Code's wildcard form).
        "Bash(*/home/someone/.acme/web.secret*)",
        "Bash(*/home/someone/.acme/sessions/*)",
        "Bash(head */home/someone/.acme/web.secret*)",
        // The legacy prefix form, for versions before wildcards.
        "Bash(cat /home/someone/.acme/web.secret:*)",
        "Bash(cat /home/someone/.acme/sessions/:*)",
      ]),
    );

    expect(JSON.parse(out.files![mcpFile])).toEqual({
      mcpServers: {
        acme: {
          command: "/dist/bin/acme",
          args: ["mcp", "--workspace", "north", "--actor", "agent:planner"],
          env: { PATH: "/usr/bin:/bin" },
        },
      },
    });
    expect(fs.existsSync(s.ran)).toBe(false);
  });

  it("no model: no --model flag (Claude Code's own default)", () => {
    const s = shim();
    const out = getRuntime("den-claude")!.launch(input({ env: s.env }));
    expect(out.argv).not.toContain("--model");
  });

  it("refuses when claude is not found", () => {
    expect(() =>
      getRuntime("den-claude")!.launch(input({ env: { PATH: tmp() } })),
    ).toThrow(/den-claude: claude not found \(searched 1 directory\)/);
  });

  it("resume continues the same Claude Code session, with the same MCP", () => {
    const s = shim();
    const rt = getRuntime("den-claude")!;
    const inp = input({ env: s.env });
    const out = rt.resume!({ ...inp, resumeToken: "abc-123" });
    expect(out?.argv.slice(0, 6)).toEqual([
      s.bin,
      "--resume",
      "abc-123",
      "--mcp-config",
      path.join(inp.filesDir, "mcp.json"),
      "--strict-mcp-config",
    ]);
    expect(rt.resume!({ ...inp })).toBeNull();
    expect(rt.approvals).toBe("terminal");
  });

  it("issue 728: the deny rules leave what the agent's own start uses alone", () => {
    const s = shim();
    const state = path.join(tmp(), ".acme");
    const filesDir = path.join(state, "agent-files", "planner");
    const inp = input({
      env: { ...s.env, HOME: path.dirname(state) },
      stateDir: state,
      filesDir,
      mcp: {
        ...input().mcp,
        hub: {
          name: "hub",
          url: "http://den.test/hub",
          headersHelper: HUB_HEADERS_HELPER,
        },
      },
    });
    const out = getRuntime("den-claude")!.launch(inp);
    const settingsFile = path.join(filesDir, "settings.json");
    const deny = (
      JSON.parse(out.files![settingsFile]) as {
        permissions: { deny: string[] };
      }
    ).permissions.deny;
    // Its credential files are denied (the rules did widen)…
    expect(readDenied(deny, path.join(state, "hub", "token"))).toBe(true);
    // …but not its own MCP config and settings, which Claude Code reads.
    for (const f of [path.join(filesDir, "mcp.json"), settingsFile])
      expect([f, readDenied(deny, f)]).toEqual([f, false]);
    // Nor the commands its start runs: Den's MCP server and the Hub
    // headers helper (its token comes from
    // DEN_ACTOR_TOKEN_FILE, never a path in the command).
    const mcp = JSON.parse(out.files![path.join(filesDir, "mcp.json")]) as {
      mcpServers: Record<
        string,
        { command?: string; args?: string[]; headersHelper?: string }
      >;
    };
    // (Claude Code's own argv is not a Bash tool call, so it's left out:
    // it names the agent's settings file, which issue 362 denies to Bash.)
    const commands = [
      ...Object.values(mcp.mcpServers).map(
        (x) => x.headersHelper ?? [x.command, ...(x.args ?? [])].join(" "),
      ),
    ];
    expect(commands).toContain(HUB_HEADERS_HELPER);
    for (const c of commands) expect([c, denied(deny, c)]).toEqual([c, false]);
  });

  it("issue 728: other installs' entries only add denials: every rule stays, nothing is allowed", () => {
    const state = path.join(tmp(), ".acme");
    const filesDir = path.join(state, "agent-files", "planner");
    const env = { ...shim().env, HOME: path.dirname(state) };
    const settingsOf = (over: Partial<LaunchInput>) =>
      JSON.parse(
        getRuntime("den-claude")!.launch(
          input({ env, stateDir: state, filesDir, ...over }),
        ).files![path.join(filesDir, "settings.json")],
      ) as {
        permissions: { allow?: string[]; ask?: string[]; deny: string[] };
      };
    const base = settingsOf({}).permissions;
    // A poisoned entry naming this install's own folders, its worktree and /.
    const worktree = input().worktree;
    const poisoned = settingsOf({
      otherStateDirs: [state, worktree, "/"],
      edgeKeyDirs: [filesDir, worktree],
    }).permissions;
    for (const r of base.deny)
      expect([r, poisoned.deny.includes(r)]).toEqual([r, true]);
    expect(poisoned.allow).toEqual(base.allow);
    expect(poisoned.ask).toEqual(base.ask);
  });

  it("issue 728: a symlinked state folder and edge folder are denied by their real paths too", () => {
    const base = fs.realpathSync(tmp());
    const realState = path.join(base, "real-state");
    fs.mkdirSync(realState);
    const state = path.join(base, ".acme");
    fs.symlinkSync(realState, state);
    const realEdge = path.join(base, "real-edge");
    fs.mkdirSync(path.join(realEdge, "ca"), { recursive: true });
    const edge = path.join(base, "edge");
    fs.symlinkSync(realEdge, edge);
    const filesDir = path.join(state, "agent-files", "planner");
    const deny = (
      JSON.parse(
        getRuntime("den-claude")!.launch(
          input({
            env: { ...shim().env, HOME: base },
            stateDir: state,
            filesDir,
            edgeKeyDirs: [path.join(edge, "ca")],
          }),
        ).files![path.join(filesDir, "settings.json")],
      ) as { permissions: { deny: string[] } }
    ).permissions.deny;
    for (const f of [
      path.join(state, "web.secret"),
      path.join(realState, "web.secret"),
      path.join(realState, "hub", "token"),
      path.join(edge, "ca", "rootCA-key.pem"),
      path.join(realEdge, "ca", "rootCA-key.pem"),
    ]) {
      expect([f, readDenied(deny, f)]).toEqual([f, true]);
      expect([f, denied(deny, `cat ${f}`)]).toEqual([f, true]);
    }
  });

  it("issue 728: the edge folder's proof, Traefik file and stack secrets are denied", () => {
    const state = path.join(tmp(), ".acme");
    const filesDir = path.join(state, "agent-files", "planner");
    const edge = path.join(path.dirname(state), "share", "acme", "edge");
    const deny = (
      JSON.parse(
        getRuntime("den-claude")!.launch(
          input({
            env: { ...shim().env, HOME: path.dirname(state) },
            stateDir: state,
            filesDir,
            edgeKeyDirs: [edge],
          }),
        ).files![path.join(filesDir, "settings.json")],
      ) as { permissions: { deny: string[] } }
    ).permissions.deny;
    for (const f of [
      "den-edge-proof",
      "dynamic/edge.yml",
      "stacks/db/generated.env",
      "ca/rootCA-key.pem",
      "certs/edge-key.pem",
    ]) {
      const abs = path.join(edge, f);
      expect([f, readDenied(deny, abs)]).toEqual([f, true]);
      expect([f, denied(deny, `cat ${abs}`)]).toEqual([f, true]);
    }
    // Edit too: Traefik reloads dynamic/, and ca/ and certs/ carry TLS.
    expect(deny).toContain(`Edit(/${edge}/**)`);
  });

  it("issue 728: the install registry is denied to Read, Edit and Bash", () => {
    const state = path.join(tmp(), ".acme");
    const filesDir = path.join(state, "agent-files", "planner");
    const reg = path.join(path.dirname(state), "reg", "den", "installs");
    const deny = (
      JSON.parse(
        getRuntime("den-claude")!.launch(
          input({
            env: { ...shim().env, HOME: path.dirname(state) },
            stateDir: state,
            filesDir,
            installRegistryDir: reg,
          }),
        ).files![path.join(filesDir, "settings.json")],
      ) as { permissions: { deny: string[] } }
    ).permissions.deny;
    const entry = path.join(reg, "0123456789abcdef.json");
    expect(readDenied(deny, entry)).toBe(true);
    expect(deny).toContain(`Edit(/${reg}/**)`);
    expect(denied(deny, `ls ${reg}`)).toBe(true);
    expect(denied(deny, `cat ${entry}`)).toBe(true);
  });

  it("issue 728: the activity trail (audit.jsonl) is denied to Read, Edit and Bash", () => {
    const state = path.join(tmp(), ".acme");
    const filesDir = path.join(state, "agent-files", "planner");
    const deny = (
      JSON.parse(
        getRuntime("den-claude")!.launch(
          input({
            env: { ...shim().env, HOME: path.dirname(state) },
            stateDir: state,
            filesDir,
          }),
        ).files![path.join(filesDir, "settings.json")],
      ) as { permissions: { deny: string[] } }
    ).permissions.deny;
    const trail = path.join(state, "audit.jsonl");
    expect(readDenied(deny, trail)).toBe(true);
    expect(deny).toContain(`Edit(/${trail})`);
    expect(denied(deny, `tail ${trail}`)).toBe(true);
  });

  it("issue 728: the install registry is denied by its real path too (a symlink in it)", () => {
    const state = path.join(tmp(), ".acme");
    const filesDir = path.join(state, "agent-files", "planner");
    const realReg = path.join(path.dirname(state), "real", "installs");
    fs.mkdirSync(realReg, { recursive: true });
    const reg = path.join(path.dirname(state), "linked-installs");
    fs.symlinkSync(realReg, reg);
    const deny = (
      JSON.parse(
        getRuntime("den-claude")!.launch(
          input({
            env: { ...shim().env, HOME: path.dirname(state) },
            stateDir: state,
            filesDir,
            installRegistryDir: reg,
          }),
        ).files![path.join(filesDir, "settings.json")],
      ) as { permissions: { deny: string[] } }
    ).permissions.deny;
    const realEntry = path.join(
      fs.realpathSync(realReg),
      "0123456789abcdef.json",
    );
    expect(readDenied(deny, path.join(reg, "0123456789abcdef.json"))).toBe(
      true,
    );
    expect(readDenied(deny, realEntry)).toBe(true);
    expect(denied(deny, `cat ${realEntry}`)).toBe(true);
  });

  it("issue 728: the edge's key folders are denied, from the launch input", () => {
    const state = path.join(tmp(), ".acme");
    const filesDir = path.join(state, "agent-files", "planner");
    const edge = path.join(path.dirname(state), "edge");
    const out = getRuntime("den-claude")!.launch(
      input({
        env: { ...shim().env, HOME: path.dirname(state) },
        stateDir: state,
        filesDir,
        edgeKeyDirs: [path.join(edge, "ca"), path.join(edge, "certs")],
      }),
    );
    const deny = (
      JSON.parse(out.files![path.join(filesDir, "settings.json")]) as {
        permissions: { deny: string[] };
      }
    ).permissions.deny;
    for (const f of ["ca/rootCA-key.pem", "certs/edge-key.pem"]) {
      const abs = path.join(edge, f);
      expect([f, readDenied(deny, abs)]).toEqual([f, true]);
      expect([f, denied(deny, `cat ${abs}`)]).toEqual([f, true]);
    }
    expect(readDenied(deny, path.join(filesDir, "mcp.json"))).toBe(false);
  });
});

describe("generic", () => {
  const generic = () => getRuntime("generic")!;

  it("substitutes {model} and {mcp_config} in the persona's argv template", () => {
    const inp = input({
      persona: persona({
        argv: ["sh", "-c", "run", "--model={model}", "--mcp", "{mcp_config}"],
      }),
      model: "m-1",
    });
    const out = generic().launch(inp);
    const mcpFile = path.join(inp.filesDir, "mcp.json");
    expect(out.argv).toEqual([
      "sh",
      "-c",
      "run",
      "--model=m-1",
      "--mcp",
      mcpFile,
    ]);
    expect(JSON.parse(out.files![mcpFile]).mcpServers.acme.args).toContain(
      "agent:planner",
    );
  });

  it("no MCP config when the template does not reference it", () => {
    const out = generic().launch(
      input({ persona: persona({ argv: ["sh", "{model}"] }), model: "x" }),
    );
    expect(out.argv).toEqual(["sh", "x"]);
    expect(out.files).toBeUndefined();
  });

  it("refuses a persona without argv, and {model} without a model", () => {
    expect(() => generic().launch(input())).toThrow(
      /generic: persona planner has no argv template/,
    );
    expect(() =>
      generic().launch(input({ persona: persona({ argv: ["x", "{model}"] }) })),
    ).toThrow(/uses \{model\}.*--model/);
    expect(generic().resume).toBeUndefined();
  });
});
