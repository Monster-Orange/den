/**
 * A repo-level down (0.3.0-dev.38, a consumer's dev.37 finding): `down
 * <repo>` and `down -a` of a repo with no down of its own stop every
 * service record of that repo (each `up <repo>/<svc>` recorded its own
 * process group), and `up` treats a record with no process group as stale.
 * Real throwaway node processes; only marked ones are killed afterwards.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { execFileSync, type ChildProcess } from "child_process";
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
  listDaemons,
  registerDaemon,
  runServiceCommand,
  type DownOutcome,
} from "../../../src/shared/environment-manager/service-runner.js";

const mocked = <T extends (...args: never[]) => unknown>(f: T) =>
  f as unknown as jest.MockedFunction<T>;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-down-repo-"));
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
const IDLE = `node -e "setInterval(()=>{},1000)" ${MARK}`;

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

function upService(svc: string): number {
  const result = runServiceCommand({
    address: `repo/${svc}`,
    command: "up",
    onLine: () => {},
    onClose: () => {},
  });
  tails.push(result.proc);
  const record = findDaemonByAddress(`repo/${svc}`);
  expect(record?.pgid).toEqual(expect.any(Number));
  spawnedGroups.add(record!.pgid!);
  return record!.pgid!;
}

function run(
  address: string,
  command: string,
  explicit?: boolean,
): Promise<{ exitCode: number; lines: string[]; outcome: DownOutcome | null }> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let outcome: DownOutcome | null = null;
    runServiceCommand({
      address,
      command,
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
  mocked(getServiceLogPath).mockImplementation((_r, s) =>
    path.join(tmp, `${s}.log`),
  );
  mocked(readCatalog).mockReturnValue({ repo: { gh: "Globex-Corp/repo" } });
  // Two services, no up or down of the repo's own (only theirs).
  mocked(readManifest).mockReturnValue({
    services: {
      web: { commands: { local: { up: IDLE } } },
      api: { commands: { local: { up: IDLE } } },
    },
  });
  const ws = {
    name: "default",
    config: {
      services: {
        repo: { mode: "dev-managed" as const },
        "repo/web": { mode: "dev-managed" as const },
        "repo/api": { mode: "dev-managed" as const },
      },
    },
  };
  mocked(getActiveWorkspace).mockReturnValue(ws);
  mocked(getFocusedWorkspaceName).mockReturnValue("default");
  mocked(getActiveWorkspaces).mockReturnValue(["default"]);
  mocked(getWorkspaceByName).mockImplementation((name: string) =>
    name === "default" ? ws : null,
  );
  mocked(resolveServiceSource).mockImplementation((address: string) =>
    ["repo", "repo/web", "repo/api"].includes(address)
      ? resolvedAs(address)
      : null,
  );
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

describe("a repo-level down stops its services' records", () => {
  it.each([
    ["down repo", true],
    ["down -a (a workspace-wide down of the repo)", false],
  ])("%s stops both services", async (_name, explicit) => {
    const web = upService("web");
    const api = upService("api");
    expect(alive(web) && alive(api)).toBe(true);

    const r = await run("repo", "down", explicit);

    expect(alive(web)).toBe(false);
    expect(alive(api)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("stopped");
    expect(r.lines.join("\n")).not.toContain("nothing to stop");
    expect(listDaemons()).toEqual([]);
  });

  it("warns about and drops a stale service record with no process group", async () => {
    const legacy = {
      address: "repo/api",
      repoName: "repo",
      subsystem: "api",
      repoPath,
      logPath: path.join(tmp, "api.log"),
      startedAt: new Date(),
    };
    registerDaemon(legacy);

    const r = await run("repo", "down", false);

    expect(r.outcome).toBe("nothing-recorded");
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toMatch(
      /^Warning: repo\/api was recorded before 0\.3\.0-dev\.37/m,
    );
    expect(findDaemonByAddress("repo/api")).toBeUndefined();
  });

  it("with no records, still says there is nothing to stop", async () => {
    const r = await run("repo", "down");
    expect(r.exitCode).toBe(0);
    expect(r.outcome).toBe("nothing-recorded");
  });
});

describe("up and a record with no process group", () => {
  it("drops the stale record, warns once and starts the service", async () => {
    registerDaemon({
      address: "repo/api",
      repoName: "repo",
      subsystem: "api",
      repoPath,
      logPath: path.join(tmp, "api.log"),
      startedAt: new Date(),
      workspaces: ["default"],
    });

    const lines: string[] = [];
    const result = runServiceCommand({
      address: "repo/api",
      command: "up",
      onLine: (l) => lines.push(l),
      onClose: () => {},
    });
    tails.push(result.proc);

    const record = findDaemonByAddress("repo/api");
    expect(record?.pgid).toEqual(expect.any(Number));
    spawnedGroups.add(record!.pgid!);
    expect(alive(record!.pgid!)).toBe(true);
    expect(
      lines.filter((l) =>
        /^Warning: .*recorded before 0\.3\.0-dev\.37/.test(l),
      ),
    ).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("already running");
  });
});
