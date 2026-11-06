/**
 * `down` stops what a detached `up` started (0.3.0-dev.37): the up records
 * its process group, and down signals that group (SIGTERM, grace, SIGKILL)
 * after checking the pid still belongs to the recorded process. These tests
 * spawn real throwaway node processes and check they are gone.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-down-pgid-"));
const repoPath = path.join(tmp, "repo");
fs.mkdirSync(repoPath, { recursive: true });

const resolved: ResolvedService = {
  address: "repo/api",
  repoName: "repo",
  subsystem: "api",
  repoPath,
  branch: null,
  mode: "dev-managed",
};

// Every process this file starts carries MARK on its command line, so the
// cleanup finds (and kills) only those, even when a test fails before down.
const MARK = path.basename(tmp);
const IDLE = `node -e "setInterval(()=>{},1000)" ${MARK}`;
const STUBBORN = `node -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)" ${MARK}`;

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

function manifestWith(local: Record<string, string>): void {
  mocked(readManifest).mockReturnValue({
    services: { api: { commands: { local } } },
  });
}

function up(): number {
  const result = runServiceCommand({
    address: "repo/api",
    command: "up",
    onLine: () => {},
    onClose: () => {},
  });
  tails.push(result.proc);
  const record = findDaemonByAddress("repo/api");
  expect(record?.pgid).toEqual(expect.any(Number));
  expect(record?.pgidStartedAt).toEqual(expect.any(String));
  spawnedGroups.add(record!.pgid!);
  return record!.pgid!;
}

function down(explicit?: boolean): Promise<{
  exitCode: number;
  lines: string[];
  outcome: DownOutcome | null;
}> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let outcome: DownOutcome | null = null;
    runServiceCommand({
      address: "repo/api",
      command: "down",
      explicit,
      onLine: (l) => lines.push(l),
      onDownOutcome: (o) => {
        outcome = o;
      },
      onClose: (exitCode) => resolve({ exitCode, lines, outcome }),
    });
  });
}

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
  mocked(resolveServiceSource).mockReturnValue(resolved);
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

describe("down stops what a detached up started", () => {
  it("stops a service with no down command and no container", async () => {
    manifestWith({ up: IDLE });
    const pgid = up();
    expect(alive(pgid)).toBe(true);

    const r = await down();

    expect(alive(pgid)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("stopped");
    expect(r.lines.join("\n")).toContain(`process group ${pgid} (SIGTERM)`);
    expect(r.lines.join("\n")).not.toContain("nothing to stop");
    expect(findDaemonByAddress("repo/api")).toBeUndefined();
  });

  it("stops every process in the group, not just the leader", async () => {
    manifestWith({ up: `${IDLE} & ${IDLE} & wait` });
    const pgid = up();
    await until(() => groupMembers(pgid).length >= 3);
    const members = groupMembers(pgid);
    expect(members.length).toBeGreaterThanOrEqual(3);

    const r = await down();

    expect(r.exitCode).toBe(0);
    for (const pid of members) expect(alive(pid)).toBe(false);
  });

  it("SIGKILLs a group that ignores SIGTERM after the grace period", async () => {
    process.env.DEN_DOWN_GRACE_MS = "300";
    manifestWith({ up: STUBBORN });
    const pgid = up();
    // Let node install its SIGTERM handler before down signals it.
    await new Promise((r) => setTimeout(r, 500));

    const r = await down();

    expect(alive(pgid)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain(`process group ${pgid} (SIGKILL)`);
  });

  it("stops the recorded group after a declared down too", async () => {
    manifestWith({ up: IDLE, down: "true" });
    const pgid = up();

    const r = await down();

    expect(r.exitCode).toBe(0);
    expect(alive(pgid)).toBe(false);
  });

  it("never signals a reused pid: the start time must match", async () => {
    // A process that holds the recorded pid but is not the one up started.
    const other = spawn("node", ["-e", "setInterval(()=>{},1000)", MARK], {
      stdio: "ignore",
    });
    spawnedPids.add(other.pid!);
    await until(() => alive(other.pid!));
    registerDaemon({
      address: "repo/api",
      repoName: "repo",
      subsystem: "api",
      repoPath,
      logPath: path.join(tmp, "api.log"),
      startedAt: new Date(),
      pgid: other.pid!,
      pgidStartedAt: "Thu Jan  1 00:00:00 1970",
    });
    manifestWith({ up: IDLE });

    const r = await down();

    expect(alive(other.pid!)).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("already-exited");
    expect(r.lines.join("\n")).toContain("left it alone");
    expect(findDaemonByAddress("repo/api")).toBeUndefined();
  });

  it("a record from before dev.37 that nothing running matches is dropped, never signalled", async () => {
    // 0.3.0-dev.38: such a record is adopted when its process is found
    // (down-legacy-records.test.ts), else it is stale: warned and dropped.
    manifestWith({ up: IDLE });
    const legacy = {
      address: "repo/api",
      repoName: "repo",
      subsystem: "api",
      repoPath,
      logPath: path.join(tmp, "api.log"),
      startedAt: new Date(),
    };
    registerDaemon(legacy);

    const named = await down();
    expect(named.exitCode).toBe(0);
    expect(named.outcome).toBe("nothing-recorded");
    expect(named.lines.join("\n")).toMatch(
      /^Warning: repo\/api was recorded before 0\.3\.0-dev\.37/m,
    );
    expect(findDaemonByAddress("repo/api")).toBeUndefined();
  });

  it("with no record, says there is nothing to stop", async () => {
    manifestWith({ up: IDLE });
    const r = await down();
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("nothing-recorded");
  });
});
