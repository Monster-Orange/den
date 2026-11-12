/**
 * Records from before 0.3.0-dev.37 (0.3.0-dev.38, a consumer's dev.37
 * finding): no process group, often no pid, while the service still runs.
 * `up` and `down` share one rule (legacy-adopt.ts): the listener on the
 * service's known port with its cwd in the repo is adopted; else a recorded
 * pid whose group shows every token of the up command is adopted; else the
 * record is stale (dropped, nothing signalled). And a restart is a down
 * step then a detached up step, so the recorded group is only the up's.
 * Real throwaway processes, marked, cleaned up after each test.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import * as net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import type { ResolvedService } from "../../../src/shared/types/index.js";

jest.mock("../../../src/shared/manifest/read-manifest.js");
jest.mock("../../../src/shared/environment-manager/catalog.js");
jest.mock("../../../src/shared/environment-manager/workspaces.js");
jest.mock("../../../src/shared/den-config.js");
jest.mock("../../../src/shared/terminal/tabs.js");
jest.mock("../../../src/shared/cli-tabs.js");
jest.mock("../../../src/shared/environment-manager/opctl.js");
jest.mock("../../../src/shared/process/spawn-streaming.js", () => {
  const actual = jest.requireActual(
    "../../../src/shared/process/spawn-streaming.js",
  ) as Record<string, unknown>;
  return { ...actual, getServiceLogPath: jest.fn() };
});

import { readManifest } from "../../../src/shared/manifest/read-manifest.js";
import { readCatalog } from "../../../src/shared/environment-manager/catalog.js";
import {
  getActiveWorkspace,
  getActiveWorkspaces,
  getFocusedWorkspaceName,
  getWorkspaceByName,
  resolveServiceSource,
} from "../../../src/shared/environment-manager/workspaces.js";
import { getServiceLogPath } from "../../../src/shared/process/spawn-streaming.js";
import { readUserConfig } from "../../../src/shared/den-config.js";
import {
  devOpContainerNames,
  isOpctlAvailable,
  listRunningOpctlContainers,
} from "../../../src/shared/environment-manager/opctl.js";
import {
  findDaemonByAddress,
  registerDaemon,
  runServiceCommand,
  type DownOutcome,
} from "../../../src/shared/environment-manager/service-runner.js";

const mocked = <T extends (...args: never[]) => unknown>(f: T) =>
  f as unknown as jest.MockedFunction<T>;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-legacy-rec-"));
const repoPath = path.join(tmp, "repo");
fs.mkdirSync(repoPath, { recursive: true });

const resolvedAs = (address: string): ResolvedService => ({
  address,
  repoName: "repo",
  subsystem: address.includes("/") ? address.split("/")[1] : "repo",
  repoPath,
  branch: null,
  mode: "dev-managed",
});

// Every process this file starts carries MARK on its command line, so the
// cleanup finds (and kills) only those, even when a test fails before down.
const MARK = path.basename(tmp);

/** Pids this file spawned (group leaders and members), killed in afterEach. */
const spawnedGroups = new Set<number>();
const spawnedPids = new Set<number>();
const tails: ChildProcess[] = [];

function psRows(): { pid: number; pgid: number; zombie: boolean }[] {
  return execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], {
    encoding: "utf-8",
  })
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 3)
    .map(([pid, pgid, stat]) => ({
      pid: Number(pid),
      pgid: Number(pgid),
      zombie: stat.startsWith("Z"),
    }));
}

function alive(pid: number): boolean {
  return psRows().some((r) => r.pid === pid && !r.zombie);
}

function groupMembers(pgid: number): number[] {
  return psRows()
    .filter((r) => r.pgid === pgid && !r.zombie)
    .map((r) => r.pid);
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 50));
}

const elsewhere = path.join(tmp, "elsewhere");
fs.mkdirSync(elsewhere, { recursive: true });

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1");
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

/**
 * A detached `/bin/sh -c "<cmd> & wait"`: the shell leads its own group and
 * waits on its child, as a pre-dev.37 up's shell did. Returns the leader.
 */
function leader(cmd: string, cwd: string): number {
  const p = spawn("/bin/sh", ["-c", `${cmd} & wait`], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  p.unref();
  spawnedGroups.add(p.pid!);
  return p.pid!;
}

const server = (port: number) =>
  `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')" ${MARK}`;

function manifest(svc: Record<string, unknown>): void {
  mocked(readManifest).mockReturnValue({ services: { api: svc } });
}

function legacyRecord(extra: Record<string, unknown> = {}): void {
  registerDaemon({
    address: "repo/api",
    repoName: "repo",
    subsystem: "api",
    repoPath,
    branch: null,
    workspaces: ["default"],
    logPath: path.join(tmp, "api.log"),
    startedAt: new Date(),
    containers: [],
    ...extra,
  });
}

function run(
  command: string,
): Promise<{ exitCode: number; lines: string[]; outcome: DownOutcome | null }> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let outcome: DownOutcome | null = null;
    const r = runServiceCommand({
      address: "repo/api",
      command,
      onLine: (l) => lines.push(l),
      onDownOutcome: (o) => {
        outcome = o;
      },
      onClose: (exitCode) => resolve({ exitCode, lines, outcome }),
    });
    // A detached up's tail never closes: settle once the record has a group.
    if (r.detachable) {
      tails.push(r.proc);
      void until(() => !!findDaemonByAddress("repo/api")?.pgid).then(() =>
        resolve({ exitCode: 0, lines, outcome }),
      );
    }
  });
}

/** What a fresh up recorded: its group, tracked for cleanup. */
function freshGroup(): number {
  const pgid = findDaemonByAddress("repo/api")?.pgid;
  expect(pgid).toEqual(expect.any(Number));
  spawnedGroups.add(pgid!);
  return pgid!;
}

const IDLE_UP = `node -e "setInterval(()=>{},1000)" ${MARK}`;

beforeEach(() => {
  jest.resetAllMocks();
  process.env.DEN_DAEMONS_FILE = path.join(tmp, `daemons-${Date.now()}.json`);
  delete process.env.DEN_DOWN_GRACE_MS;
  mocked(getServiceLogPath).mockReturnValue(path.join(tmp, "api.log"));
  mocked(readCatalog).mockReturnValue({ repo: { gh: "Globex-Corp/repo" } });
  const ws = {
    name: "default",
    config: { services: { "repo/api": { mode: "dev-managed" as const } } },
  };
  mocked(getActiveWorkspace).mockReturnValue(ws);
  mocked(getFocusedWorkspaceName).mockReturnValue("default");
  mocked(getActiveWorkspaces).mockReturnValue(["default"]);
  mocked(getWorkspaceByName).mockImplementation((name: string) =>
    name === "default" ? ws : null,
  );
  mocked(resolveServiceSource).mockReturnValue(resolvedAs("repo/api"));
  mocked(isOpctlAvailable).mockReturnValue(false);
  mocked(devOpContainerNames).mockReturnValue([]);
  mocked(listRunningOpctlContainers).mockReturnValue([]);
  mocked(readUserConfig).mockReturnValue({ terminal: "iterm2" });
});

afterEach(() => {
  for (const t of tails.splice(0)) t.kill("SIGTERM");
  // Only what this file spawned.
  for (const pgid of spawnedGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  spawnedGroups.clear();
  spawnedPids.clear();
  // Anything else of ours (a run where up recorded no group).
  for (const line of execFileSync("ps", ["-A", "-o", "pid=,command="], {
    encoding: "utf-8",
  }).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || !m[2].includes(MARK)) continue;
    try {
      process.kill(Number(m[1]), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

describe("a no-pid record whose process holds the health URL's port", () => {
  // The consumer's shape: no `port:` key, 5173 only in the health URL and
  // in --port; the leader an sh -c around the listening node.
  async function setup(): Promise<{ port: number; pid: number }> {
    const port = await freePort();
    manifest({
      health: { local: { url: `http://127.0.0.1:${port}/` } },
      commands: {
        local: { up: `FOO=1 npx vite --host 127.0.0.1 --port ${port}` },
      },
    });
    const pid = leader(server(port), repoPath);
    for (let i = 0; i < 100 && !(await listening(port)); i++)
      await new Promise((r) => setTimeout(r, 50));
    legacyRecord();
    return { port, pid };
  }

  it("up adopts it, reports it running and starts nothing", async () => {
    const { port, pid } = await setup();
    const r = await run("up");
    expect(r.lines.join("\n")).toContain(`adopted pre-dev.37 process (pid `);
    expect(r.lines.join("\n")).toContain(`port ${port})`);
    expect(r.lines.join("\n")).toContain("already running");
    expect(findDaemonByAddress("repo/api")?.pgid).toBe(pid);
    expect(alive(pid)).toBe(true);
  });

  it("down adopts it and stops the group (TERM to an sh -c leader)", async () => {
    const { port, pid } = await setup();
    const r = await run("down");
    expect(r.outcome).toBe("stopped");
    expect(r.lines.join("\n")).toContain(`process group ${pid} (SIGTERM)`);
    expect(alive(pid)).toBe(false);
    expect(await listening(port)).toBe(false);
    expect(findDaemonByAddress("repo/api")).toBeUndefined();
  });
});

describe("a pid-only record with an env-prefixed, npx-shaped up", () => {
  const UP = `ENV_A=1 npx node -e "setInterval(()=>{},1000)" ${MARK}`;
  function setup(): number {
    manifest({ commands: { local: { up: UP } } });
    // As npx runs it: the binary under its own name, a child of the shell.
    const pid = leader(
      `ENV_A=1 node -e "setInterval(()=>{},1000)" ${MARK}`,
      repoPath,
    );
    legacyRecord({ pid });
    return pid;
  }

  it("up adopts it and starts nothing", async () => {
    const pid = setup();
    await until(() => groupMembers(pid).length >= 2);
    const r = await run("up");
    expect(r.lines.join("\n")).toContain(
      `adopted pre-dev.37 process (pid ${pid})`,
    );
    expect(r.lines.join("\n")).toContain("already running");
    expect(findDaemonByAddress("repo/api")?.pgid).toBe(pid);
  });

  it("down adopts it and stops the group", async () => {
    const pid = setup();
    await until(() => groupMembers(pid).length >= 2);
    const r = await run("down");
    expect(r.outcome).toBe("stopped");
    expect(alive(pid)).toBe(false);
    expect(groupMembers(pid)).toEqual([]);
  });
});

describe("a recorded pid reused by another process", () => {
  function setup(): number {
    manifest({ commands: { local: { up: IDLE_UP } } });
    const other = leader(
      `node -e "setTimeout(()=>{},30000)" ${MARK}`,
      repoPath,
    );
    legacyRecord({ pid: other });
    return other;
  }

  it("up warns, drops it, never signals it and starts the service", async () => {
    const other = setup();
    await until(() => groupMembers(other).length >= 2);
    const r = await run("up");
    expect(r.lines.join("\n")).toMatch(
      /^Warning: repo\/api was recorded before 0\.3\.0-dev\.37/m,
    );
    expect(alive(other)).toBe(true);
    expect(freshGroup()).not.toBe(other);
  });

  it("down warns, drops it, never signals it: nothing to stop", async () => {
    const other = setup();
    await until(() => groupMembers(other).length >= 2);
    const r = await run("down");
    expect(r.outcome).toBe("nothing-recorded");
    expect(r.lines.join("\n")).toMatch(/^Warning: repo\/api was recorded/m);
    expect(alive(other)).toBe(true);
    expect(findDaemonByAddress("repo/api")).toBeUndefined();
  });
});

describe("the service's port held by a process outside the repo", () => {
  async function setup(): Promise<{ port: number; pid: number }> {
    const port = await freePort();
    manifest({
      health: { local: { url: `http://localhost:${port}/health` } },
      commands: { local: { up: IDLE_UP } },
    });
    const pid = leader(server(port), elsewhere);
    for (let i = 0; i < 100 && !(await listening(port)); i++)
      await new Promise((r) => setTimeout(r, 50));
    legacyRecord();
    return { port, pid };
  }

  // 0.3.0-dev.40 (a consumer's dev.39 finding): it used to start anyway,
  // and the start died on EADDRINUSE; it now refuses before spawning.
  it("up says the port is busy and whose, leaves it alone, and refuses before starting", async () => {
    const { port, pid } = await setup();
    const r = await run("up");
    const text = r.lines.join("\n");
    expect(text).toMatch(
      new RegExp(`^Warning: port ${port} is in use by pid \\d+`, "m"),
    );
    expect(text).toContain(`outside ${repoPath}`);
    expect(text).toContain("repo/api not started");
    expect(r.exitCode).toBe(1);
    expect(await listening(port)).toBe(true);
    expect(alive(pid)).toBe(true);
    expect(findDaemonByAddress("repo/api")).toBeUndefined();
  });

  it("down leaves it alone: nothing to stop", async () => {
    const { port, pid } = await setup();
    const r = await run("down");
    expect(r.outcome).toBe("nothing-recorded");
    expect(r.lines.join("\n")).toContain(`port ${port} is in use`);
    expect(alive(pid)).toBe(true);
  });
});

// D38: lsof never answers in time (a busy machine). A timed-out lookup was
// read as "no process": up started a second copy, down dropped the record.
// Now it is "couldn't tell": nothing started, nothing dropped or signalled.
describe("lsof never answers in time (D38)", () => {
  const slowBin = path.join(tmp, "slow-bin");
  const realLsof = execFileSync("sh", ["-c", "command -v lsof"], {
    encoding: "utf-8",
  }).trim();
  fs.mkdirSync(slowBin, { recursive: true });
  fs.writeFileSync(
    path.join(slowBin, "lsof"),
    `#!/bin/sh\nsleep 1\nexec ${realLsof} "$@"\n`,
    { mode: 0o755 },
  );
  const saved = {
    PATH: process.env.PATH,
    DEN_LOOKUP_TIMEOUTS_MS: process.env.DEN_LOOKUP_TIMEOUTS_MS,
  };
  beforeEach(() => {
    process.env.PATH = `${slowBin}${path.delimiter}${saved.PATH ?? ""}`;
    process.env.DEN_LOOKUP_TIMEOUTS_MS = "200,300";
  });
  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.DEN_LOOKUP_TIMEOUTS_MS === undefined)
      delete process.env.DEN_LOOKUP_TIMEOUTS_MS;
    else process.env.DEN_LOOKUP_TIMEOUTS_MS = saved.DEN_LOOKUP_TIMEOUTS_MS;
  });

  /** The service, running in the repo on its port (no health URL). */
  async function running(): Promise<{ port: number; pid: number }> {
    const port = await freePort();
    manifest({ commands: { local: { up: `${IDLE_UP} --port ${port}` } } });
    const pid = leader(server(port), repoPath);
    for (let i = 0; i < 100 && !(await listening(port)); i++)
      await new Promise((r) => setTimeout(r, 50));
    return { port, pid };
  }

  it("up with a pre-dev.37 record: couldn't tell, the record kept, nothing started; exit 1", async () => {
    const { port, pid } = await running();
    legacyRecord();
    const r = await run("up");
    const text = r.lines.join("\n");
    expect(text).toContain(
      `couldn't tell whether repo/api is running (port ${port}): lsof took too long to answer`,
    );
    expect(text).toContain("its record is kept and nothing was signalled");
    expect(text).toContain("repo/api not started");
    expect(r.exitCode).toBe(1);
    expect(findDaemonByAddress("repo/api")).toBeDefined();
    expect(findDaemonByAddress("repo/api")?.pgid).toBeUndefined();
    expect(alive(pid)).toBe(true);
  }, 30_000);

  it("up with no record: couldn't tell whose the port is, nothing started; exit 1", async () => {
    const { port, pid } = await running();
    const r = await run("up");
    const text = r.lines.join("\n");
    expect(text).toContain(
      `Warning: couldn't tell whether repo/api is running (port ${port}): lsof took too long to answer; repo/api not started`,
    );
    expect(r.exitCode).toBe(1);
    expect(findDaemonByAddress("repo/api")).toBeUndefined();
    expect(alive(pid)).toBe(true);
  }, 30_000);

  it("down with a pre-dev.37 record: couldn't tell, the record kept, nothing signalled; not a success", async () => {
    const { pid } = await running();
    legacyRecord();
    const r = await run("down");
    expect(r.lines.join("\n")).toContain(
      "its record is kept and nothing was signalled",
    );
    expect(r.outcome).toBe("unstoppable");
    expect(r.exitCode).toBe(1);
    expect(findDaemonByAddress("repo/api")).toBeDefined();
    expect(alive(pid)).toBe(true);
  }, 30_000);
});

describe("restart", () => {
  it("records only the up's process group, not the down's", async () => {
    manifest({ commands: { local: { up: IDLE_UP, down: "true" } } });
    await run("restart");
    const pgid = freshGroup();
    const leaderCmd = execFileSync(
      "ps",
      ["-p", String(pgid), "-o", "command="],
      {
        encoding: "utf-8",
        env: { PATH: process.env.PATH, LC_ALL: "C" },
      },
    );
    expect(leaderCmd).toContain(MARK);
    expect(leaderCmd).not.toContain("true &&");
  });
});
