/**
 * `<cli> agents start|list|stop|resume` (AG-2a): an agent is a persona and
 * a workspace, run by a runtime in a session of the AG-3a host. Its record
 * (<stateDir>/agents/<id>.json, 0600) holds what it is and where, never its
 * env or argv. A real host on a temp socket, a scripted PTY, and a `claude`
 * PATH shim that must never run.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const record = (r: Rig, id: string) =>
  JSON.parse(
    fs.readFileSync(path.join(r.stateDir, "agents", `${id}.json`), "utf-8"),
  ) as Record<string, unknown>;
const mode = (f: string) => fs.statSync(f).mode & 0o777;

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
      /den-claude is unavailable: claude is not on PATH/,
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
    // And the same id twice in one workspace while it runs is refused.
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(/agent planner is running/);
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
    r.made[0].exit(0);
    await settle();
    expect(await agents(r, "resume", "planner")).toBe(0);
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
    expect(r.err.join("\n")).toMatch(/runtime generic does not declare resume/);
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
