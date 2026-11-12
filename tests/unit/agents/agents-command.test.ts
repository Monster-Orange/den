/**
 * `<cli> agents start|list|stop|resume` (AG-2a): an agent is a persona and
 * a workspace, run by a runtime in a session of the AG-3a host. Its record
 * (<stateDir>/agents/<id>.json, 0600) holds what it is and where, never its
 * env or argv. A real host on a temp socket, a scripted PTY, and a `claude`
 * PATH shim that must never run.
 */
import { nameSlug } from "../../../src/shared/agents/records.js";
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;
const mode = (f: string) => fs.statSync(f).mode & 0o777;

/** Type `text` into the agent's session, as an attached terminal would. */
async function typeInto(r: Rig, id: string, text: string): Promise<void> {
  const sid = (record(r, id).session as { id: string }).id;
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(sid, Buffer.from(text));
  await settle();
  c.close();
}

/** A persona pack with one persona, `name`, whose front matter adds `extra`. */
function persona(r: Rig, name: string, extra: string): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n${extra}---\nYou plan.\n`,
  );
  r.config.personaPacks = ["personas"];
}

async function listRows(r: Rig, ws: string) {
  r.out.length = 0;
  expect(await agents(r, "list", "-w", ws, "--json")).toBe(0);
  return JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>;
}

describe("agents start", () => {
  it("starts the persona's runtime in a session named <dist>-<ws>:<id>, in the workspace's dir", async () => {
    const r = await rig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(r.out.join("\n")).toMatch(
      /started agent planner \(planner, den-claude\) as acme-north:planner/,
    );
    expect(r.made).toHaveLength(1);
    const p = r.made[0];
    expect(p.file).toBe(r.claude);
    expect(p.args[0]).toBe("--session-id");
    expect(p.args).toContain("--mcp-config");
    expect(p.opts.cwd).toBe(r.wsDir("north"));
    // The caller's environment, without Den's plumbing.
    expect(p.opts.env.HOME).toBe("/home/someone");
    const [row] = await listRows(r, "north");
    expect((row.session as { name: string }).name).toBe("acme-north:planner");
    expect(fs.existsSync(r.ran)).toBe(false);
  });

  it("D24/D25: names the Claude session <cli>-<ws>:<name> for peers; a rename carries to the next resume", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const first = r.made[0].args;
    expect(
      first.slice(first.indexOf("--name"), first.indexOf("--name") + 2),
    ).toEqual(["--name", "acme-north:planner"]);
    expect(record(r, "planner").peerName).toBe("acme-north:planner");
    r.out.length = 0;
    expect(await agents(r, "rename", "planner", "Night", "watch")).toBe(0);
    expect(r.out.join("\n")).toContain(
      'renamed agent planner to "Night watch"; others see it as acme-north:Night watch',
    );
    expect(record(r, "planner").displayName).toBe("Night watch");
    r.made[0].exit(0);
    await settle();
    const rc = await agents(r, "resume", "planner");
    if (rc !== 0) throw new Error(r.err.join("\n"));
    const again = r.made[1].args;
    expect(
      again.slice(again.indexOf("--name"), again.indexOf("--name") + 2),
    ).toEqual(["--name", "acme-north:Night watch"]);
    expect(record(r, "planner").peerName).toBe("acme-north:Night watch");
    r.out.length = 0;
    expect(await agents(r, "rename", "planner", "--clear")).toBe(0);
    expect(record(r, "planner").displayName).toBeUndefined();
    expect(await agents(r, "rename", "planner")).toBe(2);
    expect(await agents(r, "rename", "nobody", "x")).toBe(1);
  });

  it("writes the agent record, 0600, with no env and no argv", async () => {
    const r = await rig();
    await agents(
      r,
      "start",
      "-w",
      "north",
      "--persona",
      "planner",
      "--model",
      "opus",
    );
    const file = path.join(r.stateDir, "agents", "planner.json");
    expect(mode(file)).toBe(0o600);
    expect(mode(path.dirname(file))).toBe(0o700);
    const rec = record(r, "planner");
    expect(Object.keys(rec).sort()).toEqual(
      [
        "id",
        "persona",
        "runtime",
        "model",
        "workspace",
        "cwd",
        "session",
        "sessionName",
        "startedAt",
        "resumeToken",
        // AG-14: the grants it started with, kept by a resume.
        "grants",
        // 0.4.8: launched on resumeToken, so a resume continues it.
        "launched",
        // AG-12: its model's version ("latest": the alias); AG-10.9: what
        // it overrides of its persona (here: the model).
        "version",
        "overrides",
        // den#3: what its subagents ran on, and where that came from.
        "subagents",
        // D24: the name its Claude session was given, for peers.
        "peerName",
      ].sort(),
    );
    expect(rec).toMatchObject({
      id: "planner",
      persona: "planner",
      runtime: "den-claude",
      model: "opus",
      workspace: "north",
      cwd: r.wsDir("north"),
      sessionName: "acme-north:planner",
      session: { backend: "den-pty" },
    });
    const text = fs.readFileSync(file, "utf-8");
    expect(text).not.toContain("secret-value-123");
    expect(text).not.toContain("SOME_TOKEN");
    expect(text).not.toContain("--mcp-config");
  });

  it("writes a per-agent MCP config, 0600, holding the scoped mcp command", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const p = r.made[0];
    const file = p.args[p.args.indexOf("--mcp-config") + 1];
    expect(file.startsWith(r.stateDir + path.sep)).toBe(true);
    expect(mode(file)).toBe(0o600);
    const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(cfg.mcpServers.acme).toEqual({
      command: "/dist/bin/acme",
      args: ["mcp", "--workspace", "north", "--actor", "agent:planner"],
      env: { PATH: "/usr/bin:/bin" },
    });
  });

  it("--id, --runtime and --model override the persona's defaults", async () => {
    const r = await rig();
    const packs = path.join(r.dir, "personas");
    fs.mkdirSync(packs);
    fs.writeFileSync(
      path.join(packs, "shell.md"),
      '---\nname: shell\nruntime: generic\nargv: ["sh", "-c", "echo {model}"]\nmodel: small\n---\nA shell.\n',
    );
    r.config.personaPacks = ["personas"];
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "shell",
        "--id",
        "sh-1",
        "--model",
        "big",
      ),
    ).toBe(0);
    expect([r.made[0].file, ...r.made[0].args]).toEqual([
      "sh",
      "-c",
      "echo big",
    ]);
    expect(record(r, "sh-1")).toMatchObject({
      persona: "shell",
      runtime: "generic",
      model: "big",
    });
    // A persona of the default pack on the generic runtime has no template.
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--runtime",
        "generic",
      ),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(/persona planner has no argv template/);
  });

  it("an unknown persona or runtime is a usage error naming what exists", async () => {
    const r = await rig();
    expect(await agents(r, "start", "-w", "north", "--persona", "nope")).toBe(
      2,
    );
    expect(r.err.join("\n")).toMatch(/no persona "nope".*planner/);
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--runtime",
        "x",
      ),
    ).toBe(2);
    expect(r.err.join("\n")).toMatch(/no runtime "x".*den-claude.*generic/);
    expect(
      await agents(r, "start", "-w", "nowhere", "--persona", "planner"),
    ).toBe(2);
    expect(r.made).toHaveLength(0);
  });

  it("refuses when the runtime is unavailable here", async () => {
    const r = await rig();
    r.deps.env = { PATH: "/usr/bin:/bin" };
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /den-claude is unavailable: claude not found \(searched 2 directories\)/,
    );
    // AG-0.1: and how to fix it, naming the user.yml to edit.
    expect(r.err.join("\n")).toMatch(
      /Install it, or set agents\.runtimes\.den-claude\.bin to its absolute path in \/.*user\.yml/,
    );
    expect(r.err.join("\n")).toMatch(
      /`acme agents doctor` shows where it looked/,
    );
  });

  it("an id is one agent in the distribution: another workspace needs its own", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    expect(
      await agents(
        r,
        "start",
        "-w",
        "south",
        "--persona",
        "planner",
        "--id",
        "planner",
      ),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /agent planner belongs to workspace north/,
    );
    // Without --id, the default id makes room for it.
    expect(
      await agents(r, "start", "-w", "south", "--persona", "planner"),
    ).toBe(0);
    expect(record(r, "planner-south").workspace).toBe("south");
    // An explicit id that is running is refused, with how to open it.
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--id",
        "planner",
      ),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(/agent planner is running/);
  });

  it("AG-10.10: one persona twice in a workspace: planner, then planner-2; a stopped one is never reused by a new start", async () => {
    const r = await rig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(record(r, "planner").workspace).toBe("north");
    expect(record(r, "planner-2").workspace).toBe("north");
    // The first one ends: a new start still takes the next free id.
    await typeInto(r, "planner", "plan the release\r");
    r.made[0].exit(0);
    await settle();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(record(r, "planner-3").workspace).toBe("north");
    // The stopped one still resumes as itself.
    const rc = await agents(r, "resume", "planner");
    if (rc !== 0) throw new Error(r.err.join("\n"));
    expect(rc).toBe(0);
  });

  it("AG-10.10b: a Name is the id as its slug; a running match is refused; a stopped one takes the next suffix; no two live titles", async () => {
    const r = await rig();
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--name",
        "API spike",
      ),
    ).toBe(0);
    expect(record(r, "api-spike")).toMatchObject({
      workspace: "north",
      displayName: "API spike",
    });
    // The same Name while it runs: refused, nothing launched.
    const made = r.made.length;
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--name",
        "api-spike",
      ),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(/agent api-spike is running/);
    // Its title, typed another way, too.
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--name",
        "API SPIKE",
      ),
    ).toBe(1);
    expect(r.made.length).toBe(made);
    // Once it has ended: the next suffix; Resume continues the first.
    await typeInto(r, "api-spike", "plan\r");
    r.made[made - 1].exit(0);
    await settle();
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--name",
        "API spike",
      ),
    ).toBe(0);
    expect(record(r, "api-spike-2").displayName).toBe("API spike");
    // A Name with no id characters: the persona's default id.
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--name",
        "!!!",
      ),
    ).toBe(0);
    expect(record(r, "planner").displayName).toBe("!!!");
  });

  it("nameSlug: lowercase, spaces to -, only id characters, at most 64", () => {
    expect(nameSlug("API spike")).toBe("api-spike");
    expect(nameSlug("  Rita's  review!  ")).toBe("ritas-review");
    expect(nameSlug("be-dev-2")).toBe("be-dev-2");
    expect(nameSlug("!!!")).toBeNull();
    expect(nameSlug("x".repeat(80))).toHaveLength(64);
  });

  it("agents.max_concurrent counts agents only: plain sessions never block an agent", async () => {
    const r = await rig();
    r.config.maxConcurrent = 1;
    const c = await r.deps.connect!();
    for (const n of ["sh1", "sh2"])
      await c.start(
        {
          name: `acme-north:${n}`,
          cwd: r.wsDir("north"),
          argv: ["sh"],
          env: {},
          cols: 80,
          rows: 24,
        },
        { limit: 8, pool: "sessions" },
      );
    c.close();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(
      await agents(r, "start", "-w", "north", "--persona", "reviewer"),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /1 agent is running and agents\.max_concurrent is 1/,
    );
  });

  it("is capped by agents.max_concurrent (the host enforces it)", async () => {
    const r = await rig();
    r.config.maxConcurrent = 1;
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    expect(
      await agents(r, "start", "-w", "north", "--persona", "reviewer"),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(/agents\.max_concurrent is 1/);
    expect(
      fs.existsSync(path.join(r.stateDir, "agents", "reviewer.json")),
    ).toBe(false);
  });

  it("has no --grant: a grant only comes from config", async () => {
    const r = await rig();
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--grant",
        "south",
      ),
    ).toBe(2);
    expect(r.err.join("\n")).toMatch(/unknown flag --grant/);
  });

  it("agents.<id>.grants reach the MCP command as --grant", async () => {
    const r = await rig();
    r.config.agents = { planner: { grants: ["south"] } };
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const p = r.made[0];
    const cfg = JSON.parse(
      fs.readFileSync(p.args[p.args.indexOf("--mcp-config") + 1], "utf-8"),
    );
    expect(cfg.mcpServers.acme.args).toEqual([
      "mcp",
      "--workspace",
      "north",
      "--actor",
      "agent:planner",
      "--grant",
      "south",
    ]);
  });

  it("a grant naming a workspace that does not exist is an error naming the key", async () => {
    const r = await rig();
    r.config.agents = { planner: { grants: ["gone"] } };
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /agents\.planner\.grants: workspace "gone" does not exist/,
    );
    expect(r.made).toHaveLength(0);
  });
});

describe("agents list", () => {
  it("fills persona, runtime and model from the record; other workspaces stay out", async () => {
    const r = await rig();
    await agents(
      r,
      "start",
      "-w",
      "north",
      "--persona",
      "planner",
      "--model",
      "opus",
    );
    await agents(r, "start", "-w", "south", "--persona", "reviewer");
    const rows = await listRows(r, "north");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent: "planner",
      persona: "planner",
      runtime: "den-claude",
      model: "opus",
      workspace: "north",
      cwd: r.wsDir("north"),
      state: "running",
    });
    r.out.length = 0;
    await agents(r, "list", "-w", "north");
    expect(r.out[1]).toMatch(
      /^planner\s+planner\s+den-claude\s+running\s+opus/,
    );
  });
});

describe("agents stop and resume", () => {
  it("stop ends the session and marks the record stopped", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    expect(await agents(r, "stop", "planner")).toBe(0);
    await settle();
    expect(r.made[0].signals).toEqual(["SIGTERM"]);
    r.made[0].exit(0);
    await settle();
    expect(typeof record(r, "planner").stoppedAt).toBe("string");
    const [row] = await listRows(r, "north");
    expect(row.state).toBe("stopped");
    expect(await agents(r, "stop", "nobody")).toBe(1);
    expect(r.err.join("\n")).toMatch(/no agent "nobody"/);
  });

  it("resume continues the runtime's session in the same cwd, once it has ended", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const token = record(r, "planner").resumeToken as string;
    expect(await agents(r, "resume", "planner")).toBe(1);
    expect(r.err.join("\n")).toMatch(/agent planner is running/);
    // It was prompted: there is a conversation to continue.
    await typeInto(r, "planner", "plan the release\r");
    r.made[0].exit(0);
    await settle();
    const rc = await agents(r, "resume", "planner");
    if (rc !== 0) throw new Error(r.err.join("\n"));
    expect(rc).toBe(0);
    const p = r.made[1];
    expect(p.args.slice(0, 2)).toEqual(["--resume", token]);
    expect(p.opts.cwd).toBe(r.wsDir("north"));
    const rows = await listRows(r, "north");
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("running");
    expect(record(r, "planner").stoppedAt).toBeUndefined();
  });

  it("resume is refused when the runtime declares none", async () => {
    const r = await rig();
    const packs = path.join(r.dir, "personas");
    fs.mkdirSync(packs);
    fs.writeFileSync(
      path.join(packs, "shell.md"),
      '---\nname: shell\nruntime: generic\nargv: ["sh"]\n---\nA shell.\n',
    );
    r.config.personaPacks = ["personas"];
    await agents(r, "start", "-w", "north", "--persona", "shell");
    r.made[0].exit(0);
    await settle();
    expect(await agents(r, "resume", "shell")).toBe(1);
    expect(r.err.join("\n")).toMatch(/generic can't resume a conversation/);
    expect(r.made).toHaveLength(1);
  });

  it("-w on stop or resume must be the agent's workspace", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    expect(await agents(r, "stop", "planner", "-w", "south")).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /agent planner is in workspace north, not south/,
    );
  });
});

describe("an agent's environment", () => {
  it("starts from an allowlist: none of the caller's Claude Code plumbing, secrets or other variables", async () => {
    const r = await rig();
    r.deps.env = {
      ...r.deps.env,
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "parent-session",
      CLAUDE_CODE_CHILD_SESSION: "1",
      FAKE_PROBE_TOKEN: "probe-value",
      FOO: "bar",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    };
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    // Key names only: a failure never prints a value.
    const keys = Object.keys(r.made[0].opts.env);
    expect(
      keys.filter((k) =>
        [
          "CLAUDECODE",
          "CLAUDE_CODE_SESSION_ID",
          "CLAUDE_CODE_CHILD_SESSION",
          "FAKE_PROBE_TOKEN",
          "SOME_TOKEN",
          "FOO",
        ].includes(k),
      ),
    ).toEqual([]);
    for (const k of ["PATH", "HOME", "TERM", "LANG", "LC_ALL"])
      expect(keys).toContain(k);
    // Only Den's own (den#3: its subagents' model), never the caller's.
    expect(
      keys.filter(
        (k) =>
          k.startsWith("CLAUDE_CODE_") &&
          k !== "CLAUDE_CODE_SUBAGENT_MODEL" &&
          k !== "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
      ),
    ).toEqual([]);
  });

  it("den#3: its subagents run on sonnet, forced, by default", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const env = r.made[0].opts.env;
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("sonnet");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE).toBe("1");
    // The list says so, and where it came from.
    expect(await listRows(r, "north")).toEqual([
      expect.objectContaining({
        agent: "planner",
        subagentModel: "sonnet",
        subagentModelFrom: "default",
      }),
    ]);
  });

  it("den#3: the org's agents.subagents.model, and a persona's subagent_model wins", async () => {
    const r = await rig();
    r.config.subagents = { model: "haiku", claudeAiConnectors: false };
    await agents(r, "start", "-w", "north", "--persona", "planner");
    expect(r.made[0].opts.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("haiku");
    persona(r, "reviewer", "subagent_model: opus\n");
    await agents(r, "start", "-w", "north", "--persona", "reviewer");
    expect(r.made[1].opts.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("opus");
  });

  it("den#3: claude.ai connectors off unless agents.claude_ai_connectors is true", async () => {
    const r = await rig();
    const settings = (i: number) => {
      const a = r.made[i].args;
      return JSON.parse(
        fs.readFileSync(a[a.indexOf("--settings") + 1], "utf-8"),
      ) as Record<string, unknown>;
    };
    await agents(r, "start", "-w", "north", "--persona", "planner");
    expect(settings(0).disableClaudeAiConnectors).toBe(true);
    r.config.subagents = { model: "sonnet", claudeAiConnectors: true };
    await agents(r, "start", "-w", "north", "--persona", "reviewer");
    expect(r.made[1].args).toContain("--settings");
    expect("disableClaudeAiConnectors" in settings(1)).toBe(false);
  });

  it("den#3: inherit (org or persona) sets none, and the caller's never leaks in", async () => {
    const r = await rig();
    r.deps.env = {
      ...r.deps.env,
      CLAUDE_CODE_SUBAGENT_MODEL: "caller-model",
      CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
    };
    r.config.subagents = { model: "inherit", claudeAiConnectors: false };
    await agents(r, "start", "-w", "north", "--persona", "planner");
    persona(r, "reviewer", "subagent_model: inherit\n");
    r.config.subagents = { model: "haiku", claudeAiConnectors: false };
    await agents(r, "start", "-w", "north", "--persona", "reviewer");
    for (const m of r.made) {
      const keys = Object.keys(m.opts.env);
      expect(keys).not.toContain("CLAUDE_CODE_SUBAGENT_MODEL");
      expect(keys).not.toContain("CLAUDE_CODE_SUBAGENT_MODEL_FORCE");
    }
    const rows = await listRows(r, "north");
    expect(rows.find((x) => x.agent === "planner")).toMatchObject({
      subagentModel: "inherit",
      subagentModelFrom: "org",
    });
    expect(rows.find((x) => x.agent === "reviewer")).toMatchObject({
      subagentModel: "inherit",
      subagentModelFrom: "persona",
    });
  });

  it("carries Den's marker DEN_AGENT=agent:<id>, and agents start takes no --keep-env", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    expect(r.made[0].opts.env.DEN_AGENT).toBe("agent:planner");
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "reviewer",
        "--keep-env",
        "FOO",
      ),
    ).toBe(2);
    expect(r.err.join("\n")).toMatch(/unknown flag --keep-env/);
  });

  it("a runtime's envPassthrough names extra variables it needs (den-claude: CLAUDE_CONFIG_DIR)", async () => {
    const r = await rig();
    r.deps.env = {
      ...r.deps.env,
      CLAUDE_CONFIG_DIR: "/home/someone/.cc",
      FOO: "bar",
    };
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const keys = Object.keys(r.made[0].opts.env);
    expect(keys).toContain("CLAUDE_CONFIG_DIR");
    // Only what it names: everything else stays behind.
    expect(keys).not.toContain("FOO");
  });
});

describe("den-claude's permission mode", () => {
  it("passes --permission-mode default unless the persona sets permission_mode", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const a = r.made[0].args;
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("default");
    persona(r, "careful", "permission_mode: plan\n");
    expect(
      await agents(r, "start", "-w", "north", "--persona", "careful"),
    ).toBe(0);
    const b = r.made[1].args;
    expect(b[b.indexOf("--permission-mode") + 1]).toBe("plan");
  });

  it("an invalid permission_mode is a config error naming the key", async () => {
    const r = await rig();
    persona(r, "odd", "permission_mode: yolo\n");
    expect(await agents(r, "start", "-w", "north", "--persona", "odd")).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /permission_mode "yolo" must be one of ask, edits, auto, all, default, acceptEdits, plan, bypassPermissions/,
    );
    expect(r.made).toHaveLength(0);
  });

  it("bypassPermissions prints a one-line warning on start", async () => {
    const r = await rig();
    persona(r, "bold", "permission_mode: bypassPermissions\n");
    expect(await agents(r, "start", "-w", "north", "--persona", "bold")).toBe(
      0,
    );
    const warn = r.err.filter((l) => /bypassPermissions/.test(l));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatch(/will not ask before/);
  });
});

describe("agents resume, never prompted", () => {
  it("a record from before 0.4.8 (no launched flag) whose session never got input starts fresh with the same conversation id", async () => {
    const r = await rig();
    await agents(r, "start", "-w", "north", "--persona", "planner");
    const token = record(r, "planner").resumeToken as string;
    // As 0.4.7 wrote it: no `launched` (resume-conversation.test.ts has 0.4.8's).
    const { launched: _l, ...old } = record(r, "planner");
    fs.writeFileSync(
      path.join(r.stateDir, "agents", "planner.json"),
      JSON.stringify(old),
    );
    r.made[0].exit(0);
    await settle();
    const rc = await agents(r, "resume", "planner");
    if (rc !== 0) throw new Error(r.err.join("\n"));
    expect(rc).toBe(0);
    expect(r.out.join("\n")).toMatch(/nothing to resume yet; started fresh/);
    const p = r.made[1];
    expect(p.args.slice(0, 2)).toEqual(["--session-id", token]);
    expect(p.args).not.toContain("--resume");
    expect(record(r, "planner").resumeToken).toBe(token);
  });
});

describe("an agent that exits at once", () => {
  it("start or resume reports a non-zero exit in the first moments, with its last lines, and exits 1", async () => {
    const r = await rig();
    r.deps.exitWatchMs = 2000;
    const run = agents(r, "start", "-w", "north", "--persona", "planner");
    for (let i = 0; i < 50 && !r.made.length; i++) await settle(20);
    r.made[0].emit(
      "\x1b[31mNo conversation found with session ID x\x1b[0m\r\n",
    );
    r.made[0].exit(1);
    expect(await run).toBe(1);
    const err = r.err.join("\n");
    expect(err).toMatch(/agent planner exited at once \(exit 1\)/);
    expect(err).toMatch(/No conversation found with session ID x/);
    expect(err).not.toContain("\x1b[");
    expect(r.out.join("\n")).not.toMatch(/started agent/);
  });
});
