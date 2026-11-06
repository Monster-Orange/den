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
import {
  daemonStaleReason,
  type DaemonRecord,
} from "../../../src/shared/environment-manager/service-runner.js";
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
    rootOf: () => "here",
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

  // All roots of a product share one daemons file: another root's records
  // are its server's to sweep, never ours.
  it("never touches another root's daemon, resolvable or not", async () => {
    for (const resolve of [() => null, () => SERVICE]) {
      const { deps, unregister, healthCalls } = makeDeps(["error", "error"], {
        rootOf: () => "other",
        resolveService: resolve,
      });

      const result = await reapDeadDaemons(deps);

      expect(unregister).not.toHaveBeenCalled();
      expect(healthCalls).toHaveLength(0);
      expect(result.kept).toEqual([ADDRESS]);
    }
  });

  it("keeps an unstamped (legacy) record that does not resolve here", async () => {
    const { deps, unregister } = makeDeps(["ok"], {
      rootOf: () => "unstamped",
      resolveService: () => null,
    });

    const result = await reapDeadDaemons(deps);

    expect(unregister).not.toHaveBeenCalled();
    expect(result.kept).toEqual([ADDRESS]);
  });

  it("still reaps an unstamped record on two consecutive errors", async () => {
    const { deps, unregister } = makeDeps(["error", "error"], {
      rootOf: () => "unstamped",
    });

    const result = await reapDeadDaemons(deps);

    expect(unregister).toHaveBeenCalledWith(ADDRESS);
    expect(result.removed).toEqual([ADDRESS]);
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

  // A consumer's dev.32 dogfood finding: a relocated repo's record (no pid,
  // containers: []) whose service now runs as an unrelated compose
  // container. Its address resolves and that container is healthy, so the
  // health sweep kept it forever (a permanent Runs tab).
  describe("stale records (0.3.0-dev.33)", () => {
    const staleWith =
      (deps: Parameters<typeof daemonStaleReason>[2]) =>
      (d: DaemonRecord, running: Set<string> | null) =>
        daemonStaleReason(d, running, deps);

    it("removes a record whose checkout is gone, though the address resolves healthy", async () => {
      const { deps, unregister, healthCalls } = makeDeps(["ok"], {
        listDaemons: () => [{ ...makeDaemon(), containers: [] }],
        staleReason: staleWith({ exists: () => false }),
        runningContainers: async () => new Set(["shop"]),
      });

      const result = await reapDeadDaemons(deps);

      expect(unregister).toHaveBeenCalledWith(ADDRESS);
      expect(result.removed).toEqual([ADDRESS]);
      expect(healthCalls).toHaveLength(0);
    });

    it("removes a relocated record when none of its containers run (the new checkout's own container does)", async () => {
      const { deps, unregister } = makeDeps(["ok"], {
        listDaemons: () => [{ ...makeDaemon(), containers: [] }],
        staleReason: staleWith({
          exists: () => true,
          resolvedPaths: () => ["/repos/relocated/shop"],
          devOpNames: () => [],
        }),
        runningContainers: async () => new Set(["shop"]),
      });

      const result = await reapDeadDaemons(deps);

      expect(unregister).toHaveBeenCalledWith(ADDRESS);
      expect(result.removed).toEqual([ADDRESS]);
    });

    it("keeps a relocated record while one of its containers runs", async () => {
      const { deps, unregister } = makeDeps(["ok"], {
        listDaemons: () => [{ ...makeDaemon(), containers: ["shop-api"] }],
        staleReason: staleWith({
          exists: () => true,
          resolvedPaths: () => ["/repos/relocated/shop"],
          devOpNames: () => [],
        }),
        runningContainers: async () => new Set(["shop-api"]),
      });

      const result = await reapDeadDaemons(deps);

      expect(unregister).not.toHaveBeenCalled();
      expect(result.kept).toEqual([ADDRESS]);
    });

    it("keeps a record that resolves to its own checkout with nothing verifiable", async () => {
      const { deps, unregister } = makeDeps(["ok"], {
        listDaemons: () => [{ ...makeDaemon(), containers: [] }],
        staleReason: staleWith({
          exists: () => true,
          resolvedPaths: () => ["/repos/shop"],
          devOpNames: () => [],
        }),
        runningContainers: async () => new Set(),
      });

      const result = await reapDeadDaemons(deps);

      expect(unregister).not.toHaveBeenCalled();
      expect(result.kept).toEqual([ADDRESS]);
    });

    it("never removes another root's record for it", async () => {
      const { deps, unregister } = makeDeps(["ok"], {
        listDaemons: () => [
          { ...makeDaemon(), containers: [], root: "/elsewhere/root-a" },
        ],
        rootOf: () => "other",
        staleReason: staleWith({ exists: () => false }),
      });

      const result = await reapDeadDaemons(deps);

      expect(unregister).not.toHaveBeenCalled();
      expect(result.kept).toEqual([ADDRESS]);
    });
  });
});
