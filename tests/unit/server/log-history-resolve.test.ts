/**
 * Branch coverage for resolveHistorySource / searchSystemHistory /
 * isSafeServiceName — the security boundary and source-resolution tiers of
 * the log-history endpoints. All external effects (docker, fs, service
 * resolution, health) are mocked; the pure paging functions are covered by
 * log-history.test.ts with real files.
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";

jest.mock("fs");
jest.mock("child_process");
jest.mock("../../../src/shared/environment-manager/opctl.js", () => ({
  findConventionalContainer: jest.fn(),
  runningDockerNames: jest.fn(),
}));
jest.mock("../../../src/shared/environment-manager/service-runner.js", () => ({
  resolveService: jest.fn(),
  hasRunningOpctlContainers: jest.fn(),
}));
jest.mock("../../../src/shared/environment-manager/health.js", () => ({
  checkServiceHealth: jest.fn(),
}));
jest.mock("../../../src/shared/process/spawn-streaming.js", () => ({
  getServiceLogPath: jest.fn(),
}));
jest.mock("../../../src/shared/manifest/read-manifest.js", () => ({
  readManifest: jest.fn(),
}));
// No focused workspace: stacks run under the default one (`main`).
jest.mock("../../../src/shared/environment-manager/workspaces.js", () => ({
  getFocusedWorkspaceName: () => null,
}));

import * as fs from "fs";
import { EventEmitter } from "events";
import { execFile, spawn, spawnSync } from "child_process";
import {
  findConventionalContainer,
  runningDockerNames,
} from "../../../src/shared/environment-manager/opctl.js";
import {
  resolveService,
  hasRunningOpctlContainers,
} from "../../../src/shared/environment-manager/service-runner.js";
import { checkServiceHealth } from "../../../src/shared/environment-manager/health.js";
import { getServiceLogPath } from "../../../src/shared/process/spawn-streaming.js";
import { readManifest } from "../../../src/shared/manifest/read-manifest.js";
import {
  resolveHistorySource,
  searchSystemHistory,
  isSafeServiceName,
  ensureSnapshot,
  pruneDeadSnapshots,
} from "../../../src/ui/server/log-history.js";

const mockFind = findConventionalContainer as jest.MockedFunction<
  typeof findConventionalContainer
>;
const mockDockerNames = runningDockerNames as jest.MockedFunction<
  typeof runningDockerNames
>;
const mockResolve = resolveService as jest.MockedFunction<
  typeof resolveService
>;
const mockRunning = hasRunningOpctlContainers as jest.MockedFunction<
  typeof hasRunningOpctlContainers
>;
const mockHealth = checkServiceHealth as jest.MockedFunction<
  typeof checkServiceHealth
>;
const mockLogPath = getServiceLogPath as jest.MockedFunction<
  typeof getServiceLogPath
>;
const mockManifest = readManifest as jest.MockedFunction<typeof readManifest>;
const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;
const mockExecFile = execFile as unknown as jest.Mock;
const mockSpawn = spawn as unknown as jest.Mock;

/** `spawn` answers with a child that closes with `code` on the next tick. */
function spawnCloses(code: number): void {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter();
    setImmediate(() => child.emit("close", code));
    return child;
  });
}
const mockExists = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

beforeEach(() => {
  jest.resetAllMocks();
  mockResolve.mockReturnValue({
    repoName: "shop",
    subsystem: "db",
    repoPath: "/repos/shop",
    mode: "dev-managed",
  } as never);
  mockLogPath.mockReturnValue("/home/.den/logs/shop/db.log");
});

// ── isSafeServiceName ─────────────────────────────────────────────────────────

describe("isSafeServiceName", () => {
  it("accepts catalog-style names", () => {
    for (const ok of ["shop", "infra-stack", "api", "a1", "svc.v2", "A_b-c"]) {
      expect(isSafeServiceName(ok)).toBe(true);
    }
  });

  it("rejects traversal and path-ish names", () => {
    for (const bad of [
      "..",
      ".",
      "../etc",
      "a/b",
      "",
      ".hidden",
      "-flag",
      "a b",
    ]) {
      expect(isSafeServiceName(bad)).toBe(false);
    }
  });
});

// ── resolveHistorySource ──────────────────────────────────────────────────────

describe("resolveHistorySource", () => {
  it("rejects unsafe repo or service names before any resolution", async () => {
    const a = await resolveHistorySource("../../etc", "api", "local");
    expect(a).toEqual({
      kind: "unsupported",
      reason: "invalid repo/service name",
      t: { key: "lg.why.badName" },
    });
    const b = await resolveHistorySource("shop", "../creds", "local");
    expect(b.kind).toBe("unsupported");
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockLogPath).not.toHaveBeenCalled();
  });

  it("returns unsupported for non-local envs (cloudwatch is a follow-up)", async () => {
    const r = await resolveHistorySource("shop", "db", "dev");
    expect(r.kind).toBe("unsupported");
    expect((r as { reason: string }).reason).toMatch(/local only/);
  });

  it("tier 1: conventional opctl container wins", async () => {
    mockFind.mockReturnValue("opctl_shop-postgres_abc123");
    const r = await resolveHistorySource("shop", "db", "local");
    expect(r).toEqual({
      kind: "docker",
      container: "opctl_shop-postgres_abc123",
    });
  });

  it("a compose-stack service resolves to its stack's container", async () => {
    mockResolve.mockReturnValue({
      repoName: "webapp",
      subsystem: "backend",
      repoPath: "/repos/webapp",
      mode: "dev-managed",
    } as never);
    mockFind.mockReturnValue(null);
    mockManifest.mockReturnValue({
      name: "webapp",
      entrypoint: "webapp",
      services: { webapp: {}, backend: {} },
      compose: { routes: { app: "frontend:80" } },
    } as never);
    mockDockerNames.mockReturnValue([
      "webapp-main-frontend-1",
      "webapp-main-backend-1",
    ]);
    expect(await resolveHistorySource("webapp", "backend", "local")).toEqual({
      kind: "docker",
      container: "webapp-main-backend-1",
    });
  });

  it("tier 2: falls back to the manifest log command's docker filter", async () => {
    mockFind.mockReturnValue(null);
    mockManifest.mockReturnValue({
      name: "shop",
      services: {
        db: {
          logs: {
            local: {
              type: "shell",
              cmd: "docker ps --filter name=shop-postgres -q",
            },
          },
        },
      },
    } as never);
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        e: Error | null,
        out: string,
      ) => void;
      setImmediate(() => cb(null, "shop-postgres\n"));
    });
    const r = await resolveHistorySource("shop", "db", "local");
    expect(r).toEqual({ kind: "docker", container: "shop-postgres" });
    // Async (issue 131): never the blocking spawnSync.
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["ps", "--filter", "name=shop-postgres", "--format", "{{.Names}}"],
      expect.anything(),
      expect.any(Function),
    );
  });

  it("tier 2 skipped when the manifest cmd has no docker filter or no container matches", async () => {
    mockFind.mockReturnValue(null);
    mockManifest.mockReturnValue({
      name: "shop",
      services: {
        db: { logs: { local: { type: "shell", cmd: "tail -F x.log" } } },
      },
    } as never);
    mockExists.mockReturnValue(true);
    const r = await resolveHistorySource("shop", "db", "local");
    expect(r).toEqual({
      kind: "file",
      path: "/home/.den/logs/shop/db.log",
    });
  });

  it("tier 3: daemon log file for host-run services", async () => {
    mockFind.mockReturnValue(null);
    mockManifest.mockReturnValue(null);
    mockExists.mockReturnValue(true);
    const r = await resolveHistorySource("shop", "db", "local");
    expect(r).toEqual({
      kind: "file",
      path: "/home/.den/logs/shop/db.log",
    });
  });

  it("unsupported when nothing resolves", async () => {
    mockFind.mockReturnValue(null);
    mockManifest.mockReturnValue(null);
    mockExists.mockReturnValue(false);
    const r = await resolveHistorySource("shop", "db", "local");
    expect(r.kind).toBe("unsupported");
    expect((r as { reason: string }).reason).toMatch(/no running container/);
  });
});

// ── ensureSnapshot / pruneDeadSnapshots ───────────────────────────────────────

describe("ensureSnapshot", () => {
  const mockOpen = fs.openSync as jest.MockedFunction<typeof fs.openSync>;
  const mockRename = fs.renameSync as jest.MockedFunction<typeof fs.renameSync>;
  const mockRm = fs.rmSync as jest.MockedFunction<typeof fs.rmSync>;

  it("file sources are their own snapshot; unsupported yields null", async () => {
    expect(await ensureSnapshot({ kind: "file", path: "/x/y.log" })).toBe(
      "/x/y.log",
    );
    expect(
      await ensureSnapshot({ kind: "unsupported", reason: "nope" }),
    ).toBeNull();
  });

  it("reuses an existing docker snapshot without spawning", async () => {
    mockExists.mockReturnValue(true);
    const p = await ensureSnapshot({ kind: "docker", container: "opctl_x_1" });
    expect(p).toMatch(/opctl_x_1\.log$/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("dumps docker logs to a temp file then renames it into place", async () => {
    mockExists.mockReturnValue(false);
    mockOpen.mockReturnValue(7 as never);
    spawnCloses(0);
    const p = await ensureSnapshot({ kind: "docker", container: "opctl_x_1" });
    expect(p).toMatch(/opctl_x_1\.log$/);
    expect(mockSpawnSync).not.toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      ["logs", "--timestamps", "opctl_x_1"],
      expect.objectContaining({ stdio: ["ignore", 7, 7] }),
    );
    expect(mockRename).toHaveBeenCalled();
  });

  it("returns null and removes the temp when docker logs fails", async () => {
    mockExists.mockReturnValue(false);
    mockOpen.mockReturnValue(7 as never);
    spawnCloses(1);
    expect(
      await ensureSnapshot({ kind: "docker", container: "opctl_x_1" }),
    ).toBeNull();
    expect(mockRm).toHaveBeenCalledWith(
      expect.stringMatching(/opctl_x_1\.log\.tmp$/),
      { force: true },
    );
    expect(mockRename).not.toHaveBeenCalled();
  });
});

describe("pruneDeadSnapshots", () => {
  const mockReaddir = fs.readdirSync as jest.MockedFunction<
    typeof fs.readdirSync
  >;
  const mockRm = fs.rmSync as jest.MockedFunction<typeof fs.rmSync>;

  it("returns 0 when the history dir is missing or docker is unavailable", () => {
    mockReaddir.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(pruneDeadSnapshots()).toBe(0);

    mockReaddir.mockReturnValue(["a.log"] as never);
    mockSpawnSync.mockReturnValue({ status: 1 } as never);
    expect(pruneDeadSnapshots()).toBe(0);
  });

  it("removes snapshots for dead containers, keeps live ones and non-log files", () => {
    mockReaddir.mockReturnValue([
      "alive.log",
      "dead.log",
      "notes.txt",
    ] as never);
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "alive\n" } as never);
    expect(pruneDeadSnapshots()).toBe(1);
    expect(mockRm).toHaveBeenCalledTimes(1);
    expect(mockRm).toHaveBeenCalledWith(expect.stringMatching(/dead\.log$/), {
      force: true,
    });
  });
});

// ── searchSystemHistory (running-only gating) ─────────────────────────────────

describe("searchSystemHistory", () => {
  it("returns an error result for unsupported sources without grepping", async () => {
    const r = await searchSystemHistory(
      { repo: "shop", service: "db" },
      "boom",
      "dev",
    );
    expect(r.error).toMatch(/local only/);
    expect(r.matches).toEqual([]);
  });

  it("skips file-kind sources whose service is not running", async () => {
    mockFind.mockReturnValue(null);
    mockManifest.mockReturnValue(null);
    mockExists.mockReturnValue(true); // daemon file exists (stale)
    mockRunning.mockReturnValue(false);
    mockHealth.mockResolvedValue({ health: "error" } as never);
    const r = await searchSystemHistory(
      { repo: "shop", service: "db" },
      "boom",
      "local",
    );
    expect(r.skipped).toBe(true);
    expect(r.matches).toEqual([]);
  });

  it("rejects traversal names outright", async () => {
    const r = await searchSystemHistory(
      { repo: "..", service: "x" },
      "boom",
      "local",
    );
    expect(r.error).toBe("invalid repo/service name");
  });
});
