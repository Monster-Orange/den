/**
 * `<cli> sessions start|list|kill` and `<cli> agents list` (AG-3a) in
 * process, against a real session host on a temp socket with a scripted
 * PTY: workspace scoping, --json, the cap from agents.max_concurrent, the
 * den-pty unavailable reason, and what start hands the host.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { SessionHost } from "../../../src/shared/sessions/host.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { PtyLoad } from "../../../src/shared/sessions/pty.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";
import {
  cmdAgents,
  cmdSessions,
  type SessionsDeps,
} from "../../../src/ui/cli/sessions-command.js";
import { scriptedFactory, type ScriptedPty } from "./helpers/fake-pty.js";

const tmps: string[] = [];
const hosts: SessionHost[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

interface Rig {
  deps: SessionsDeps;
  made: ScriptedPty[];
  out: string[];
  err: string[];
  connects: number;
}

async function rig(over: Partial<SessionsDeps> = {}): Promise<Rig> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-sesscmd-"));
  tmps.push(dir);
  const { factory, made } = scriptedFactory();
  const load: PtyLoad = { available: true, factory };
  const h = new SessionHost({
    stateDir: dir,
    pty: () => load,
    flushMs: 0,
    log: () => undefined,
  });
  hosts.push(h);
  await h.listen();
  const r: Rig = { made, out: [], err: [], connects: 0, deps: {} };
  r.deps = {
    dist: "acme",
    cli: "acme",
    connect: async () => {
      r.connects++;
      return connectHost(sessionPaths(dir).socket);
    },
    pty: () => load,
    workspaceExists: (ws) => ["smb", "enterprise"].includes(ws),
    maxConcurrent: () => 4,
    invokeCwd: () => dir,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/someone",
      DEN_INVOKE_CWD: "/x",
      DEN_ENGINE_ROOT: "/y",
      DEN_WORKSPACE_OVERRIDE: "z",
    },
    out: (l) => r.out.push(l),
    err: (l) => r.err.push(l),
    ...over,
  };
  return r;
}

const start = (r: Rig, ws: string, name: string, ...argv: string[]) =>
  cmdSessions(
    [
      "start",
      "--workspace",
      ws,
      "--name",
      name,
      "--",
      ...(argv.length ? argv : ["sh"]),
    ],
    r.deps,
  );

describe("sessions start", () => {
  it("names the session <dist>-<ws>:<name> and hands the host argv, cwd and env", async () => {
    const r = await rig();
    expect(await start(r, "smb", "planner", "sh", "-c", "echo hi")).toBe(0);
    expect(r.out.join("\n")).toMatch(/started acme-smb:planner/);
    const p = r.made[0];
    expect([p.file, ...p.args]).toEqual(["sh", "-c", "echo hi"]);
    expect(p.opts.cwd).toBe(r.deps.invokeCwd!());
    expect(p.opts.env.PATH).toBe("/usr/bin:/bin");
    expect(p.opts.env.TERM).toBe("xterm-256color");
    // Den's own plumbing stays out of the session.
    for (const k of [
      "DEN_INVOKE_CWD",
      "DEN_ENGINE_ROOT",
      "DEN_WORKSPACE_OVERRIDE",
    ])
      expect(p.opts.env[k]).toBeUndefined();
  });

  it("--cwd sets the working directory", async () => {
    const r = await rig();
    const cwd = os.tmpdir();
    await cmdSessions(
      ["start", "-w", "smb", "--name", "p", "--cwd", cwd, "--", "sh"],
      r.deps,
    );
    expect(r.made[0].opts.cwd).toBe(path.resolve(cwd));
  });

  it("is capped by agents.max_concurrent", async () => {
    const r = await rig({ maxConcurrent: () => 1 });
    expect(await start(r, "smb", "a")).toBe(0);
    expect(await start(r, "smb", "b")).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /1 session is running.*agents\.max_concurrent is 1/,
    );
    expect(r.made).toHaveLength(1);
  });

  it("says why den-pty is unavailable, and starts no host", async () => {
    const r = await rig({
      pty: () => ({
        available: false,
        reason: "@lydell/node-pty is not installed",
      }),
    });
    expect(await start(r, "smb", "a")).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /den-pty is unavailable: @lydell\/node-pty is not installed/,
    );
    expect(r.connects).toBe(0);
  });
});

describe("sessions list", () => {
  it("-w shows only that workspace's sessions", async () => {
    const r = await rig();
    await start(r, "smb", "planner");
    await start(r, "enterprise", "planner");
    r.out.length = 0;
    expect(await cmdSessions(["list", "-w", "smb"], r.deps)).toBe(0);
    const text = r.out.join("\n");
    expect(text).toMatch(/acme-smb:planner/);
    expect(text).not.toMatch(/enterprise/);
  });

  it("--json prints SessionInfo records", async () => {
    const r = await rig();
    await start(r, "smb", "planner");
    await start(r, "enterprise", "planner");
    r.out.length = 0;
    await cmdSessions(["list", "--workspace", "enterprise", "--json"], r.deps);
    const rows = JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["name", "pid", "ref", "startedAt"].sort(),
    );
    expect(rows[0].name).toBe("acme-enterprise:planner");
  });
});

describe("sessions kill", () => {
  it("sends TERM by default and --signal otherwise", async () => {
    const r = await rig();
    await start(r, "smb", "planner");
    expect(await cmdSessions(["kill", "planner"], r.deps)).toBe(0);
    expect(
      await cmdSessions(["kill", "smb:planner", "--signal", "KILL"], r.deps),
    ).toBe(0);
    await new Promise((res) => setTimeout(res, 50));
    expect(r.made[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("removes a session that has exited", async () => {
    const r = await rig();
    await start(r, "smb", "planner");
    r.made[0].exit(0);
    await new Promise((res) => setTimeout(res, 200));
    expect(await cmdSessions(["kill", "acme-smb:planner"], r.deps)).toBe(0);
    expect(r.out.join("\n")).toMatch(/removed acme-smb:planner/);
    r.out.length = 0;
    await cmdSessions(["list", "--json"], r.deps);
    expect(JSON.parse(r.out.join("\n"))).toEqual([]);
  });

  it("an unknown session is an error (exit 1)", async () => {
    const r = await rig();
    expect(await cmdSessions(["kill", "nope"], r.deps)).toBe(1);
    expect(r.err.join("\n")).toMatch(/no session "nope"/);
  });
});

describe("agents list", () => {
  it("lists the workspace's sessions, persona and runtime blank until AG-2a", async () => {
    const r = await rig();
    await start(r, "smb", "planner");
    await start(r, "enterprise", "reviewer");
    r.out.length = 0;
    expect(await cmdAgents(["list", "-w", "smb"], r.deps)).toBe(0);
    const [header, ...rows] = r.out.join("\n").split("\n").filter(Boolean);
    expect(header).toMatch(/AGENT\s+PERSONA\s+RUNTIME\s+STATE/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^planner\s+-\s+-\s+running/);
  });

  it("says when a workspace has no agents", async () => {
    const r = await rig();
    expect(await cmdAgents(["list", "-w", "smb"], r.deps)).toBe(0);
    expect(r.out.join("\n")).toMatch(/no agents in smb/);
  });
});

describe("agents.max_concurrent", () => {
  it("defaults to 4", () => {
    expect(readAgentsConfig({ environments: [] }).maxConcurrent).toBe(4);
  });

  it("takes a whole number of at least 1", () => {
    expect(
      readAgentsConfig({ environments: [], agents: { max_concurrent: 9 } })
        .maxConcurrent,
    ).toBe(9);
    for (const bad of [0, -1, 2.5, "4", null])
      expect(() =>
        readAgentsConfig({
          environments: [],
          agents: { max_concurrent: bad as unknown as number },
        }),
      ).toThrow(/agents\.max_concurrent/);
  });
});
