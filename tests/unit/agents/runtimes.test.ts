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
import { stateDirDenyRules } from "../../../src/shared/agents/den-claude.js";
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
    expect(out.env).toEqual({});
    expect(Object.keys(out.files ?? {})).toEqual([mcpFile, settingsFile]);
    // SEC-1 §6c.1: Den's state dir is denied to the agent (binds a
    // cooperating agent only): Read, and any command naming web.secret or
    // sessions/.
    expect(JSON.parse(out.files![settingsFile])).toEqual({
      permissions: { deny: stateDirDenyRules("/home/someone/.acme") },
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
