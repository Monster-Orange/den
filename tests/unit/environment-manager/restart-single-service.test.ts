/**
 * A single-service repo's daemon answers to "<repo>" and "<repo>/<svc>"
 * (0.4.1-dev.5, a consumer's dev.4 finding): after `up <repo>` recorded
 * "<repo>", `restart <repo>/<svc>` found no record, adopted the running
 * process instead of restarting it, and daemons.json ended with two records
 * on one process group. Real throwaway node processes; only marked ones are
 * killed afterwards.
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
  reconcileDaemonAddress,
  registerDaemon,
  runServiceCommand,
} from "../../../src/shared/environment-manager/service-runner.js";

const mocked = <T extends (...args: never[]) => unknown>(f: T) =>
  f as unknown as jest.MockedFunction<T>;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-single-svc-"));
const repoPath = path.join(tmp, "repo");
fs.mkdirSync(repoPath, { recursive: true });

const resolvedAs = (address: string): ResolvedService => ({
  address,
  repoName: "repo",
  // A single-service repo: its bare address runs its one service.
  subsystem: address.includes("/") ? address.split("/")[1] : "web",
  repoPath,
  branch: null,
  mode: "dev-managed",
});

// Every process this file starts carries MARK on its command line, so the
// cleanup finds (and kills) only those, even when a test fails before down.
const MARK = path.basename(tmp);
const IDLE = `node -e "setInterval(()=>{},1000)" ${MARK}`;

/** Process groups this file spawned, killed in afterEach. */
const spawnedGroups = new Set<number>();
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

function upAt(address: string): number {
  const result = runServiceCommand({
    address,
    command: "up",
    onLine: () => {},
    onClose: () => {},
  });
  tails.push(result.proc);
  const record = findDaemonByAddress(address);
  expect(record?.pgid).toEqual(expect.any(Number));
  spawnedGroups.add(record!.pgid!);
  return record!.pgid!;
}

async function until(f: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function run(
  address: string,
  command: string,
): Promise<{ exitCode: number; lines: string[] }> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const r = runServiceCommand({
      address,
      command,
      onLine: (l) => lines.push(l),
      onClose: (exitCode) => resolve({ exitCode, lines }),
    });
    tails.push(r.proc);
  });
}

const single = { web: { commands: { local: { up: IDLE } } } };

beforeEach(() => {
  jest.resetAllMocks();
  process.env.DEN_DAEMONS_FILE = path.join(tmp, `daemons-${Date.now()}.json`);
  process.env.DEN_DOWN_GRACE_MS = "200";
  mocked(getServiceLogPath).mockImplementation((_r, s) =>
    path.join(tmp, `${s}.log`),
  );
  mocked(readCatalog).mockReturnValue({ repo: { gh: "acme/repo" } });
  mocked(readManifest).mockReturnValue({ services: single });
  const ws = {
    name: "default",
    config: { services: { repo: { mode: "dev-managed" as const } } },
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
  delete process.env.DEN_DOWN_GRACE_MS;
  for (const t of tails.splice(0)) t.kill?.("SIGTERM");
  for (const pgid of spawnedGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  spawnedGroups.clear();
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

describe("a single-service repo's two addresses are one daemon", () => {
  it("restart <repo>/<svc> after up <repo> restarts it: the old group stops, one record remains", async () => {
    const old = upAt("repo");

    const lines: string[] = [];
    tails.push(
      runServiceCommand({
        address: "repo/web",
        command: "restart",
        onLine: (l) => lines.push(l),
        onClose: () => {},
      }).proc,
    );
    await until(() => {
      const r = findDaemonByAddress("repo/web");
      return !!r?.pgid && r.pgid !== old;
    });
    const now = findDaemonByAddress("repo/web")!;
    spawnedGroups.add(now.pgid!);

    await until(() => !alive(old));
    expect(alive(now.pgid!)).toBe(true);
    expect(listDaemons().map((d) => d.address)).toEqual(["repo/web"]);
    expect(lines.join("\n")).not.toMatch(/adopted/);
  });

  it("restart <repo> after up <repo>/<svc> restarts it too", async () => {
    const old = upAt("repo/web");
    tails.push(
      runServiceCommand({
        address: "repo",
        command: "restart",
        onLine: () => {},
        onClose: () => {},
      }).proc,
    );
    await until(() => {
      const r = findDaemonByAddress("repo");
      return !!r?.pgid && r.pgid !== old;
    });
    spawnedGroups.add(findDaemonByAddress("repo")!.pgid!);
    await until(() => !alive(old));
    expect(listDaemons().map((d) => d.address)).toEqual(["repo"]);
  });

  it("the dev.4 leftover (two records on one group) is merged, and down stops it", async () => {
    const pgid = upAt("repo");
    const rec = findDaemonByAddress("repo")!;
    // What dev.4 left: the same group under both spellings.
    registerDaemon({ ...rec, address: "repo/web", workspaces: ["other"] });
    expect(listDaemons()).toHaveLength(2);

    const r = await run("repo/web", "down");

    expect(r.exitCode).toBe(0);
    await until(() => !alive(pgid));
    expect(listDaemons()).toEqual([]);
  });

  it("a repo with several services keeps <repo> and <repo>/<svc> apart", () => {
    mocked(readManifest).mockReturnValue({
      services: { ...single, api: { commands: { local: { up: IDLE } } } },
    });
    const at = (address: string) => ({
      address,
      repoName: "repo",
      subsystem: "web",
      repoPath,
      logPath: path.join(tmp, "web.log"),
      startedAt: new Date(),
      workspaces: ["default"],
    });
    registerDaemon(at("repo"));
    registerDaemon(at("repo/web"));
    reconcileDaemonAddress(resolvedAs("repo/web"));
    expect(
      listDaemons()
        .map((d) => d.address)
        .sort(),
    ).toEqual(["repo", "repo/web"]);
  });
});
