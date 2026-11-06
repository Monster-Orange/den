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
import { PassThrough } from "stream";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { SessionHost } from "../../../src/shared/sessions/host.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { PtyLoad } from "../../../src/shared/sessions/pty.js";
import { readAgentsConfig } from "../../../src/shared/den-config.js";
import {
  cmdSessions,
  type SessionsDeps,
} from "../../../src/ui/cli/sessions-command.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
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
  /** The host's log lines. */
  hostLog: string[];
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
    log: (l) => hostLog.push(l),
  });
  const hostLog: string[] = [];
  hosts.push(h);
  await h.listen();
  const r: Rig = { made, hostLog, out: [], err: [], connects: 0, deps: {} };
  r.deps = {
    dist: "acme",
    cli: "acme",
    connect: async () => {
      r.connects++;
      return connectHost(sessionPaths(dir).socket);
    },
    pty: () => load,
    // Agent records are read from here: never the developer's state dir.
    stateDir: () => dir,
    workspaceExists: (ws) => ["north", "south"].includes(ws),
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
    expect(await start(r, "north", "planner", "sh", "-c", "echo hi")).toBe(0);
    expect(r.out.join("\n")).toMatch(/started acme-north:planner/);
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

  it("starts from the allowlist: no Claude Code plumbing, no credentials, nothing else of the caller's; the dropped names are listed", async () => {
    const r = await rig();
    r.deps.env = {
      ...r.deps.env,
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "parent-session",
      CLAUDE_CODE_CHILD_SESSION: "1",
      FAKE_PROBE_TOKEN: "probe-value-xyz",
      FOO: "bar",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
    };
    expect(await start(r, "north", "planner")).toBe(0);
    // Key names only: a failure never prints a value.
    const keys = Object.keys(r.made[0].opts.env).sort();
    expect(keys).toEqual(["HOME", "LANG", "LC_CTYPE", "PATH", "TERM"]);
    const line = r.out.filter((l) => /dropped from its environment/.test(l));
    expect(line).toHaveLength(1);
    for (const k of [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION",
      "FAKE_PROBE_TOKEN",
      "FOO",
    ])
      expect(line[0]).toContain(k);
    const all = [...r.out, ...r.err, ...r.hostLog].join("\n");
    expect(all).not.toContain("probe-value-xyz");
    // A long environment: the first eight names, then a count.
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `VAR_${String(i).padStart(2, "0")}`,
        "x",
      ]),
    );
    r.deps.env = { ...r.deps.env, ...many };
    r.out.length = 0;
    expect(await start(r, "north", "planner2")).toBe(0);
    const long = r.out.find((l) => /dropped from its environment/.test(l))!;
    expect(long.split(",").length).toBe(8);
    expect(long).toMatch(/ and \d+ more \(keep one with --keep-env NAME\)$/);
    expect(all).not.toContain("parent-session");
  });

  it("--keep-env NAME (exact, repeatable) adds a variable, audited by name with the actor, never the value", async () => {
    const r = await rig();
    r.deps.env = {
      ...r.deps.env,
      USER: "someone",
      FAKE_PROBE_TOKEN: "probe-value-xyz",
      FOO: "foo-value-qq",
      CLAUDE_CODE_SESSION_ID: "parent-session",
    };
    expect(
      await cmdSessions(
        [
          "start",
          "-w",
          "north",
          "--name",
          "p",
          "--keep-env",
          "FAKE_PROBE_TOKEN",
          "--keep-env=FOO",
          // A runtime's scrubEnv wins, even over --keep-env.
          "--keep-env",
          "CLAUDE_CODE_SESSION_ID",
          "--",
          "sh",
        ],
        r.deps,
      ),
    ).toBe(0);
    const keys = Object.keys(r.made[0].opts.env);
    expect(keys).toContain("FAKE_PROBE_TOKEN");
    expect(keys).toContain("FOO");
    expect(keys).not.toContain("CLAUDE_CODE_SESSION_ID");
    const audit = r.hostLog.filter((l) => /--keep-env/.test(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatch(
      /--keep-env FAKE_PROBE_TOKEN \(credential-shaped\), FOO · by user someone/,
    );
    const all = [...r.out, ...r.err, ...r.hostLog].join("\n");
    expect(all).not.toContain("probe-value-xyz");
    // A long environment: the first eight names, then a count.
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [
        `VAR_${String(i).padStart(2, "0")}`,
        "x",
      ]),
    );
    r.deps.env = { ...r.deps.env, ...many };
    r.out.length = 0;
    expect(await start(r, "north", "planner2")).toBe(0);
    const long = r.out.find((l) => /dropped from its environment/.test(l))!;
    expect(long.split(",").length).toBe(8);
    expect(long).toMatch(/ and \d+ more \(keep one with --keep-env NAME\)$/);
    expect(all).not.toContain("foo-value-qq");
    // One exact name per flag: no globs, no lists.
    for (const bad of ["CLAUDE_*", "A,B", "a b"])
      expect(
        await cmdSessions(
          [
            "start",
            "-w",
            "north",
            "--name",
            "q",
            "--keep-env",
            bad,
            "--",
            "sh",
          ],
          r.deps,
        ),
      ).toBe(2);
  });

  it("--keep-env is refused for an agent actor", async () => {
    const r = await rig();
    r.deps.env = { ...r.deps.env, DEN_AGENT: "agent:planner", FOO: "bar" };
    expect(
      await cmdSessions(
        [
          "start",
          "-w",
          "north",
          "--name",
          "p",
          "--keep-env",
          "FOO",
          "--",
          "sh",
        ],
        r.deps,
      ),
    ).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /--keep-env is refused for an agent \(agent:planner\)/,
    );
    expect(r.made).toHaveLength(0);
  });

  it("--cwd sets the working directory", async () => {
    const r = await rig();
    const cwd = os.tmpdir();
    await cmdSessions(
      ["start", "-w", "north", "--name", "p", "--cwd", cwd, "--", "sh"],
      r.deps,
    );
    expect(r.made[0].opts.cwd).toBe(path.resolve(cwd));
  });

  it("is capped by agents.max_concurrent", async () => {
    const r = await rig({ maxConcurrent: () => 1 });
    expect(await start(r, "north", "a")).toBe(0);
    expect(await start(r, "north", "b")).toBe(1);
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
    expect(await start(r, "north", "a")).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /den-pty is unavailable: @lydell\/node-pty is not installed/,
    );
    expect(r.connects).toBe(0);
  });
});

describe("sessions list", () => {
  it("-w shows only that workspace's sessions", async () => {
    const r = await rig();
    await start(r, "north", "planner");
    await start(r, "south", "planner");
    r.out.length = 0;
    expect(await cmdSessions(["list", "-w", "north"], r.deps)).toBe(0);
    const text = r.out.join("\n");
    expect(text).toMatch(/acme-north:planner/);
    expect(text).not.toMatch(/south/);
  });

  it("--json prints SessionInfo records", async () => {
    const r = await rig();
    await start(r, "north", "planner");
    await start(r, "south", "planner");
    r.out.length = 0;
    await cmdSessions(["list", "--workspace", "south", "--json"], r.deps);
    const rows = JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["name", "pid", "ref", "startedAt"].sort(),
    );
    expect(rows[0].name).toBe("acme-south:planner");
  });
});

describe("sessions kill", () => {
  it("sends TERM by default and --signal otherwise", async () => {
    const r = await rig();
    await start(r, "north", "planner");
    expect(await cmdSessions(["kill", "planner"], r.deps)).toBe(0);
    expect(
      await cmdSessions(["kill", "north:planner", "--signal", "KILL"], r.deps),
    ).toBe(0);
    await new Promise((res) => setTimeout(res, 50));
    expect(r.made[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("removes a session that has exited", async () => {
    const r = await rig();
    await start(r, "north", "planner");
    r.made[0].exit(0);
    await new Promise((res) => setTimeout(res, 200));
    expect(await cmdSessions(["kill", "acme-north:planner"], r.deps)).toBe(0);
    expect(r.out.join("\n")).toMatch(/removed acme-north:planner/);
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

describe("sessions attach", () => {
  it("prints the [attached to …] banner before replaying the scrollback", async () => {
    const r = await rig();
    await start(r, "north", "planner");
    r.made[0].emit("earlier output\r\n");
    const order: string[] = [];
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = {
      isTTY: false,
      write: (d: unknown) => {
        order.push(`out ${String(d)}`);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const run = cmdSessions(["attach", "planner"], {
      ...r.deps,
      stdin,
      stdout,
      err: (l) => order.push(`err ${l}`),
    });
    await new Promise((res) => setTimeout(res, 200));
    (stdin as unknown as PassThrough).end();
    expect(await run).toBe(0);
    const banner = order.findIndex((l) => l.includes("[attached to"));
    const replay = order.findIndex((l) => l.includes("earlier output"));
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(replay).toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(replay);
  });
});

describe("agents list", () => {
  it("lists agents only: a plain session (no agent record) is left out", async () => {
    const r = await rig();
    await start(r, "north", "planner");
    await start(r, "south", "reviewer");
    r.out.length = 0;
    expect(await cmdAgents(["list", "-w", "north"], r.deps)).toBe(0);
    expect(r.out.join("\n")).toMatch(/no agents in north/);
    r.out.length = 0;
    expect(await cmdAgents(["list", "-w", "north", "--json"], r.deps)).toBe(0);
    expect(JSON.parse(r.out.join("\n"))).toEqual([]);
  });

  it("says when a workspace has no agents", async () => {
    const r = await rig();
    expect(await cmdAgents(["list", "-w", "north"], r.deps)).toBe(0);
    expect(r.out.join("\n")).toMatch(/no agents in north/);
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
