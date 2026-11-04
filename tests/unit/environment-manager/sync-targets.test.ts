/**
 * Sync only ever touches managed clones: never a dev-managed checkout, even
 * when a managed entry in some workspace resolves to the same path (sync
 * runs `git restore .` and `git pull` there).
 */
import { describe, expect, it } from "@jest/globals";
import {
  devManagedPaths,
  selectSyncTargets,
} from "../../../src/shared/environment-manager/sync-targets.js";
import type {
  ResolvedService,
  WorkspacesFile,
} from "../../../src/shared/types/index.js";

const svc = (over: Partial<ResolvedService>): ResolvedService => ({
  address: "shop",
  repoName: "shop",
  subsystem: "shop",
  repoPath: "/state/services/shop/main",
  branch: "main",
  mode: "managed",
  ...over,
});

const wsFile: WorkspacesFile = {
  active: ["default"],
  workspaces: {
    default: {
      services: {
        shop: { mode: "managed" },
        api: { mode: "dev-managed", path: "/code/api" },
      },
    },
    feature: {
      directory: "workspaces/feature",
      services: { web: { mode: "dev-managed", path: "/code/web/" } },
    },
  },
};

describe("devManagedPaths", () => {
  it("collects every workspace's dev-managed checkout, normalised", () => {
    expect([...devManagedPaths(wsFile)].sort()).toEqual([
      "/code/api",
      "/code/web",
    ]);
  });
});

describe("selectSyncTargets", () => {
  const devManaged = devManagedPaths(wsFile);

  it("keeps managed clones, deduplicated by path", () => {
    const shopApi = svc({ address: "shop/api", subsystem: "api" });
    const shopWeb = svc({ address: "shop/web", subsystem: "web" });
    const { targets, refused } = selectSyncTargets([shopApi, shopWeb], {
      devManaged,
    });
    expect(targets).toEqual([shopApi]);
    expect(refused).toEqual([]);
  });

  it("never selects a dev-managed entry", () => {
    const api = svc({
      repoName: "api",
      repoPath: "/code/api",
      mode: "dev-managed",
    });
    expect(selectSyncTargets([api], { devManaged }).targets).toEqual([]);
  });

  it("refuses a managed entry whose path is (or holds, or sits in) a dev-managed checkout", () => {
    const same = svc({ repoName: "api", repoPath: "/code/api" });
    const inside = svc({ repoName: "web", repoPath: "/code/web/sub" });
    const holds = svc({ repoName: "code", repoPath: "/code" });
    const { targets, refused } = selectSyncTargets([same, inside, holds], {
      devManaged,
    });
    expect(targets).toEqual([]);
    expect(refused.map((r) => r.repoName)).toEqual(["api", "web", "code"]);
    expect(refused[0].reason).toMatch(/dev-managed checkout/);
  });

  it("naming a dev-managed repo is refused out loud, not a silent no-op", () => {
    const api = svc({
      repoName: "api",
      repoPath: "/code/api",
      mode: "dev-managed",
    });
    const { targets, refused } = selectSyncTargets([api, svc({})], {
      onlyRepo: "api",
      devManaged,
    });
    expect(targets).toEqual([]);
    expect(refused).toEqual([
      { repoName: "api", reason: expect.stringMatching(/dev-managed/) },
    ]);
  });

  it("onlyRepo narrows to that repo", () => {
    const shop = svc({});
    const db = svc({
      repoName: "db",
      address: "db",
      repoPath: "/state/services/db/main",
    });
    expect(
      selectSyncTargets([shop, db], { onlyRepo: "db", devManaged }).targets,
    ).toEqual([db]);
  });
});
