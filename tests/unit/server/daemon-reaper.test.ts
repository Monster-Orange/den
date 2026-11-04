/**
 * Unit tests for the daemon-registry recovery sweep
 * (src/ui/server/daemon-reaper.ts) — review finding 11: a single
 * transient timeout/5xx must never unregister a possibly-running daemon.
 * Removal requires a missing service or TWO consecutive "error" health
 * checks separated by a retry delay.
 */

import { describe, expect, it, jest } from "@jest/globals";
import {
  reapDeadDaemons,
  type DaemonReaperDeps,
} from "../../../src/ui/server/daemon-reaper.js";
import type { ServiceHealthResult } from "../../../src/shared/environment-manager/health.js";
import type { DaemonRecord } from "../../../src/shared/environment-manager/service-runner.js";
import type { ResolvedService } from "../../../src/shared/types/index.js";

const ADDRESS = "shop/api";

function makeDaemon(address = ADDRESS): DaemonRecord {
  return {
    address,
    repoName: "shop",
    subsystem: "api",
    repoPath: "/repos/shop",
    logPath: "/tmp/shop-api.log",
    startedAt: new Date("2026-07-15T00:00:00Z"),
  };
}

const SERVICE = { address: ADDRESS } as unknown as ResolvedService;

function healthResult(
  health: ServiceHealthResult["health"],
): ServiceHealthResult {
  return {
    address: ADDRESS,
    repoName: "shop",
    subsystem: "api",
    repoPath: "/repos/shop",
    mode: "managed",
    branch: null,
    health,
  };
}

function makeDeps(
  healthSequence: Array<ServiceHealthResult["health"] | Error>,
  overrides: Partial<DaemonReaperDeps> = {},
): { deps: DaemonReaperDeps; unregister: jest.Mock; healthCalls: number[] } {
  const unregister = jest.fn();
  let call = 0;
  const healthCalls: number[] = [];
  const deps: DaemonReaperDeps = {
    listDaemons: () => [makeDaemon()],
    resolveService: () => SERVICE,
    getActiveWorkspaces: () => [],
    checkServiceHealth: async () => {
      healthCalls.push(call);
      const next = healthSequence[Math.min(call, healthSequence.length - 1)];
      call += 1;
      if (next instanceof Error) throw next;
      return healthResult(next);
    },
    unregisterDaemon: unregister as DaemonReaperDeps["unregisterDaemon"],
    delay: async () => undefined,
    retryDelayMs: 5_000,
    ...overrides,
  };
  return { deps, unregister, healthCalls };
}

describe("reapDeadDaemons", () => {
  it("keeps the daemon on a single transient error (error → ok)", async () => {
    const { deps, unregister } = makeDeps(["error", "ok"]);

    const result = await reapDeadDaemons(deps);

    expect(unregister).not.toHaveBeenCalled();
    expect(result.kept).toEqual([ADDRESS]);
    expect(result.removed).toEqual([]);
  });

  it("unregisters only after TWO consecutive error checks", async () => {
    const { deps, unregister, healthCalls } = makeDeps(["error", "error"]);

    const result = await reapDeadDaemons(deps);

    expect(healthCalls).toHaveLength(2);
    expect(unregister).toHaveBeenCalledWith(ADDRESS);
    expect(result.removed).toEqual([ADDRESS]);
  });

  it("waits the retry delay between the two confirmation checks", async () => {
    const delay = jest.fn(async () => undefined);
    const { deps } = makeDeps(["error", "error"], {
      delay: delay as DaemonReaperDeps["delay"],
    });

    await reapDeadDaemons(deps);

    expect(delay).toHaveBeenCalledWith(5_000);
  });

  it("a healthy daemon is kept with a single check", async () => {
    const { deps, unregister, healthCalls } = makeDeps(["ok"]);

    const result = await reapDeadDaemons(deps);

    expect(healthCalls).toHaveLength(1);
    expect(unregister).not.toHaveBeenCalled();
    expect(result.kept).toEqual([ADDRESS]);
  });

  it("'unknown' health deliberately keeps the entry", async () => {
    const { deps, unregister } = makeDeps(["unknown"]);

    const result = await reapDeadDaemons(deps);

    expect(unregister).not.toHaveBeenCalled();
    expect(result.kept).toEqual([ADDRESS]);
  });

  it("keeps the entry when the health check throws (err toward keeping)", async () => {
    const { deps, unregister } = makeDeps([new Error("probe crashed")]);

    const result = await reapDeadDaemons(deps);

    expect(unregister).not.toHaveBeenCalled();
    expect(result.kept).toEqual([ADDRESS]);
  });

  it("keeps the entry when the SECOND check throws after a first error", async () => {
    const { deps, unregister } = makeDeps([
      "error",
      new Error("probe crashed"),
    ]);

    const result = await reapDeadDaemons(deps);

    expect(unregister).not.toHaveBeenCalled();
    expect(result.kept).toEqual([ADDRESS]);
  });

  it("unregisters directly when the service no longer resolves", async () => {
    const { deps, unregister } = makeDeps(["ok"], {
      resolveService: () => null,
    });

    const result = await reapDeadDaemons(deps);

    expect(unregister).toHaveBeenCalledWith(ADDRESS);
    expect(result.removed).toEqual([ADDRESS]);
  });

  it("keeps a daemon owned by a workspace that isn't the focused one", async () => {
    // The focused workspace doesn't define this service (no-arg resolve fails);
    // only its owner does. Dropping it would orphan its running containers.
    const { deps, unregister } = makeDeps(["ok"], {
      listDaemons: () => [{ ...makeDaemon(), workspaces: ["files-api"] }],
      resolveService: (_address, workspace) =>
        workspace === "files-api" ? SERVICE : null,
    });

    const result = await reapDeadDaemons(deps);

    expect(unregister).not.toHaveBeenCalled();
    expect(result.kept).toEqual([ADDRESS]);
  });

  it("keeps a legacy record (no owners) whose service lives in a non-focused active workspace", async () => {
    // Pre-multi-active records carry no `workspaces`, so the owner loop has
    // nothing to try; without the active-set fallback the reaper would drop a
    // running service just because focus sits elsewhere.
    const { deps, unregister } = makeDeps(["ok"], {
      listDaemons: () => [{ ...makeDaemon(), workspaces: [] }],
      getActiveWorkspaces: () => ["focus-ws", "files-api"],
      resolveService: (_address, workspace) =>
        workspace === "files-api" ? SERVICE : null,
    });

    const result = await reapDeadDaemons(deps);

    expect(unregister).not.toHaveBeenCalled();
    expect(result.kept).toEqual([ADDRESS]);
  });

  it("unregisters when no owning workspace resolves the service either", async () => {
    const { deps, unregister } = makeDeps(["ok"], {
      listDaemons: () => [{ ...makeDaemon(), workspaces: ["gone"] }],
      resolveService: () => null,
    });

    const result = await reapDeadDaemons(deps);

    expect(unregister).toHaveBeenCalledWith(ADDRESS);
    expect(result.removed).toEqual([ADDRESS]);
  });
});
