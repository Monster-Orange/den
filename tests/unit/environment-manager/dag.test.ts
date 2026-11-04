import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type {
  ServiceCatalog,
  WorkspaceConfig,
  RawManifest,
} from "../../../src/shared/types/index.js";

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock("../../../src/shared/manifest/read-manifest.js");
jest.mock("../../../src/shared/environment-manager/workspaces.js");

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
  topoSort,
  buildDependencyGraph,
  resolveStartupOrder,
  getWaitDeps,
  expandSameRepoWaitDeps,
} from "../../../src/shared/environment-manager/dag.js";
import { readManifest } from "../../../src/shared/manifest/read-manifest.js";
import {
  parseAddress,
  resolveServiceSource,
  resolveDepAddress,
} from "../../../src/shared/environment-manager/workspaces.js";

const mockReadManifest = readManifest as jest.MockedFunction<
  typeof readManifest
>;
const mockParseAddress = parseAddress as jest.MockedFunction<
  typeof parseAddress
>;
const mockResolveServiceSource = resolveServiceSource as jest.MockedFunction<
  typeof resolveServiceSource
>;
const mockResolveDepAddress = resolveDepAddress as jest.MockedFunction<
  typeof resolveDepAddress
>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCatalog(...names: string[]): ServiceCatalog {
  return Object.fromEntries(names.map((n) => [n, { gh: `Globex-Corp/${n}` }]));
}

function makeWorkspace(
  services: Record<string, { mode: string; path?: string; branch?: string }>,
): WorkspaceConfig {
  return { services } as WorkspaceConfig;
}

function makeManifest(
  dependsOn: Array<string | { service: string; wait?: boolean }> = [],
  serviceKey = "api",
): RawManifest {
  return {
    name: "test-service",
    services: {
      [serviceKey]: { depends_on: dependsOn },
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ── topoSort ──────────────────────────────────────────────────────────────────

describe("topoSort", () => {
  it("returns an empty array for an empty graph", () => {
    expect(topoSort(new Map())).toEqual([]);
  });

  it("returns a single node graph with no deps", () => {
    const graph = new Map([["api", []]]);
    expect(topoSort(graph)).toEqual(["api"]);
  });

  it("orders db before api before web (linear chain)", () => {
    // web → api → db
    const graph = new Map<string, string[]>([
      ["web", ["api"]],
      ["api", ["db"]],
      ["db", []],
    ]);
    const order = topoSort(graph);
    expect(order.indexOf("db")).toBeLessThan(order.indexOf("api"));
    expect(order.indexOf("api")).toBeLessThan(order.indexOf("web"));
  });

  it("handles multiple independent roots (no dependencies between them)", () => {
    const graph = new Map<string, string[]>([
      ["serviceA", []],
      ["serviceB", []],
      ["serviceC", []],
    ]);
    const order = topoSort(graph);
    expect(order).toHaveLength(3);
    expect(order).toEqual(
      expect.arrayContaining(["serviceA", "serviceB", "serviceC"]),
    );
  });

  it("handles a diamond dependency (db before both api and worker, both before web)", () => {
    // web → [api, worker] → db
    const graph = new Map<string, string[]>([
      ["web", ["api", "worker"]],
      ["api", ["db"]],
      ["worker", ["db"]],
      ["db", []],
    ]);
    const order = topoSort(graph);
    expect(order.indexOf("db")).toBeLessThan(order.indexOf("api"));
    expect(order.indexOf("db")).toBeLessThan(order.indexOf("worker"));
    expect(order.indexOf("api")).toBeLessThan(order.indexOf("web"));
    expect(order.indexOf("worker")).toBeLessThan(order.indexOf("web"));
  });

  it("throws an error containing 'cycle' when a cycle is detected", () => {
    // a → b → c → a
    const graph = new Map<string, string[]>([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    expect(() => topoSort(graph)).toThrow(/cycle/i);
  });

  it("throws naming the nodes involved in the cycle", () => {
    const graph = new Map<string, string[]>([
      ["alpha", ["beta"]],
      ["beta", ["alpha"]],
    ]);
    let err: Error | undefined;
    try {
      topoSort(graph);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/alpha|beta/);
  });

  it("places deps before their dependents when there are multiple dependency layers", () => {
    // d → c → b → a
    const graph = new Map<string, string[]>([
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
      ["d", ["c"]],
    ]);
    const order = topoSort(graph);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });
});

// ── buildDependencyGraph ──────────────────────────────────────────────────────

describe("buildDependencyGraph", () => {
  beforeEach(() => {
    // Default: parseAddress returns a simple bare-name split
    mockParseAddress.mockImplementation((address: string) => ({
      repoName: address.includes("/") ? address.split("/")[0] : address,
      subsystem: address.includes("/") ? address.split("/")[1] : address,
    }));
    // resolveDepAddress is a pass-through in tests — normalization is unit-tested separately.
    mockResolveDepAddress.mockImplementation((dep: string) => dep);
  });

  it("returns a graph with no deps when the seed service has no depends_on", () => {
    const catalog = makeCatalog("api");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });

    mockResolveServiceSource.mockReturnValue({
      address: "api",
      repoName: "api",
      subsystem: "api",
      repoPath: "/repos/api",
      branch: null,
      mode: "dev-managed",
    });
    mockReadManifest.mockReturnValue(makeManifest([]));

    const graph = buildDependencyGraph(["api"], catalog, workspace, "default");

    expect(graph.has("api")).toBe(true);
    expect(graph.get("api")).toEqual([]);
  });

  it("seeds with no catalog entry are still added to the graph with empty deps when resolveServiceSource returns null", () => {
    const catalog = makeCatalog("api");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });

    // resolveServiceSource returns null → deps = []
    mockResolveServiceSource.mockReturnValue(null);

    const graph = buildDependencyGraph(["api"], catalog, workspace, "default");
    expect(graph.get("api")).toEqual([]);
  });

  it("follows transitive deps: api depends on db, db is in workspace and catalog", () => {
    const catalog = makeCatalog("api", "db");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
      db: { mode: "managed", branch: "main" },
    });

    mockResolveServiceSource.mockImplementation((address: string) => ({
      address,
      repoName: address,
      subsystem: address,
      repoPath: `/repos/${address}`,
      branch: null,
      mode: "dev-managed" as const,
    }));

    mockReadManifest.mockImplementation((repoPath: string) => {
      if (repoPath === "/repos/api") return makeManifest(["db"]);
      return makeManifest([]);
    });

    const graph = buildDependencyGraph(["api"], catalog, workspace, "default");

    expect(graph.has("api")).toBe(true);
    expect(graph.get("api")).toContain("db");
    expect(graph.has("db")).toBe(true);
    expect(graph.get("db")).toEqual([]);
  });

  it("filters out deps that are NOT in the catalog", () => {
    const catalog = makeCatalog("api"); // "external-svc" not in catalog
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });

    mockResolveServiceSource.mockReturnValue({
      address: "api",
      repoName: "api",
      subsystem: "api",
      repoPath: "/repos/api",
      branch: null,
      mode: "dev-managed",
    });
    mockReadManifest.mockReturnValue(makeManifest(["external-svc"]));

    const graph = buildDependencyGraph(["api"], catalog, workspace, "default");

    expect(graph.get("api")).toEqual([]); // external-svc filtered out (not in catalog)
    expect(graph.has("external-svc")).toBe(false);
  });

  it("filters out deps that are NOT in the workspace services", () => {
    const catalog = makeCatalog("api", "db"); // db in catalog
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
      // db intentionally absent from workspace
    });

    mockResolveServiceSource.mockReturnValue({
      address: "api",
      repoName: "api",
      subsystem: "api",
      repoPath: "/repos/api",
      branch: null,
      mode: "dev-managed",
    });
    mockReadManifest.mockReturnValue(makeManifest(["db"]));

    const graph = buildDependencyGraph(["api"], catalog, workspace, "default");

    expect(graph.get("api")).toEqual([]); // db filtered out (not in workspace)
  });

  it("does not re-process a node already in the graph (avoids infinite loops)", () => {
    const catalog = makeCatalog("api", "db");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
      db: { mode: "dev-managed", path: "/repos/db" },
    });

    mockResolveServiceSource.mockImplementation((address: string) => ({
      address,
      repoName: address,
      subsystem: address,
      repoPath: `/repos/${address}`,
      branch: null,
      mode: "dev-managed" as const,
    }));
    mockReadManifest.mockImplementation((repoPath: string) => {
      if (repoPath === "/repos/api") return makeManifest(["db"]);
      return makeManifest([]);
    });

    // Pass "api" twice in seeds — should not duplicate or loop
    const graph = buildDependencyGraph(
      ["api", "api"],
      catalog,
      workspace,
      "default",
    );
    expect([...graph.keys()].filter((k) => k === "api")).toHaveLength(1);
  });

  it("handles dep matching via bare repo-name key in workspace (shop/api resolved via shop)", () => {
    const catalog = makeCatalog("shop", "db");
    const workspace = makeWorkspace({
      "shop/api": { mode: "dev-managed", path: "/repos/shop" },
      db: { mode: "dev-managed", path: "/repos/db" },
    });

    // parseAddress: "shop/api" → repoName=shop, subsystem=api
    mockParseAddress.mockImplementation((address: string) => {
      if (address === "shop/api") return { repoName: "shop", subsystem: "api" };
      return { repoName: address, subsystem: address };
    });

    mockResolveServiceSource.mockImplementation((address: string) => {
      if (address === "shop/api")
        return {
          address: "shop/api",
          repoName: "shop",
          subsystem: "api",
          repoPath: "/repos/shop",
          branch: null,
          mode: "dev-managed" as const,
        };
      return {
        address,
        repoName: address,
        subsystem: address,
        repoPath: `/repos/${address}`,
        branch: null,
        mode: "dev-managed" as const,
      };
    });

    mockReadManifest.mockImplementation((repoPath: string) => {
      if (repoPath === "/repos/shop") return makeManifest(["db"]);
      return makeManifest([]);
    });

    const graph = buildDependencyGraph(
      ["shop/api"],
      catalog,
      workspace,
      "default",
    );
    expect(graph.get("shop/api")).toContain("db");
  });

  it("handles multiple seed addresses", () => {
    const catalog = makeCatalog("web", "api", "db");
    const workspace = makeWorkspace({
      web: { mode: "dev-managed", path: "/repos/web" },
      api: { mode: "dev-managed", path: "/repos/api" },
      db: { mode: "dev-managed", path: "/repos/db" },
    });

    mockResolveServiceSource.mockImplementation((address: string) => ({
      address,
      repoName: address,
      subsystem: address,
      repoPath: `/repos/${address}`,
      branch: null,
      mode: "dev-managed" as const,
    }));
    mockReadManifest.mockImplementation((repoPath: string) => {
      if (repoPath === "/repos/web") return makeManifest(["api"], "web");
      if (repoPath === "/repos/api") return makeManifest(["db"], "api");
      return makeManifest([]);
    });

    const graph = buildDependencyGraph(
      ["web", "api"],
      catalog,
      workspace,
      "default",
    );
    expect(graph.has("web")).toBe(true);
    expect(graph.has("api")).toBe(true);
    expect(graph.has("db")).toBe(true);
    expect(graph.get("web")).toContain("api");
    expect(graph.get("api")).toContain("db");
  });
});

// ── resolveStartupOrder ───────────────────────────────────────────────────────

describe("resolveStartupOrder", () => {
  beforeEach(() => {
    mockParseAddress.mockImplementation((address: string) => ({
      repoName: address.includes("/") ? address.split("/")[0] : address,
      subsystem: address.includes("/") ? address.split("/")[1] : address,
    }));
    mockResolveDepAddress.mockImplementation((dep: string) => dep);
  });

  it("returns seed addresses in order when they have no deps", () => {
    const catalog = makeCatalog("api");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });

    mockResolveServiceSource.mockReturnValue(null);

    const order = resolveStartupOrder(["api"], catalog, workspace, "default");
    expect(order).toEqual(["api"]);
  });

  it("returns db before api before web for a three-level chain", () => {
    const catalog = makeCatalog("web", "api", "db");
    const workspace = makeWorkspace({
      web: { mode: "dev-managed", path: "/repos/web" },
      api: { mode: "dev-managed", path: "/repos/api" },
      db: { mode: "dev-managed", path: "/repos/db" },
    });

    mockResolveServiceSource.mockImplementation((address: string) => ({
      address,
      repoName: address,
      subsystem: address,
      repoPath: `/repos/${address}`,
      branch: null,
      mode: "dev-managed" as const,
    }));
    mockReadManifest.mockImplementation((repoPath: string) => {
      if (repoPath === "/repos/web") return makeManifest(["api"], "web");
      if (repoPath === "/repos/api") return makeManifest(["db"], "api");
      return makeManifest([]);
    });

    const order = resolveStartupOrder(["web"], catalog, workspace, "default");
    expect(order.indexOf("db")).toBeLessThan(order.indexOf("api"));
    expect(order.indexOf("api")).toBeLessThan(order.indexOf("web"));
  });

  it("passes workspaceName through to buildDependencyGraph", () => {
    const catalog = makeCatalog("svc");
    const workspace = makeWorkspace({
      svc: { mode: "dev-managed", path: "/repos/svc" },
    });

    mockResolveServiceSource.mockReturnValue(null);

    // Should not throw — workspaceName is forwarded
    expect(() =>
      resolveStartupOrder(["svc"], catalog, workspace, "my-feature-ws"),
    ).not.toThrow();
  });

  it("includes transitively discovered deps in the result", () => {
    const catalog = makeCatalog("app", "cache", "postgres");
    const workspace = makeWorkspace({
      app: { mode: "dev-managed", path: "/repos/app" },
      cache: { mode: "managed", branch: "main" },
      postgres: { mode: "managed", branch: "main" },
    });

    mockResolveServiceSource.mockImplementation((address: string) => ({
      address,
      repoName: address,
      subsystem: address,
      repoPath: `/repos/${address}`,
      branch: null,
      mode: "dev-managed" as const,
    }));
    mockReadManifest.mockImplementation((repoPath: string) => {
      if (repoPath === "/repos/app")
        return makeManifest(["cache", "postgres"], "app");
      return makeManifest([]);
    });

    const order = resolveStartupOrder(["app"], catalog, workspace, "default");
    expect(order).toContain("cache");
    expect(order).toContain("postgres");
    expect(order).toContain("app");
    expect(order.indexOf("cache")).toBeLessThan(order.indexOf("app"));
    expect(order.indexOf("postgres")).toBeLessThan(order.indexOf("app"));
  });

  it("accepts mixed string + object depends_on entries in buildDependencyGraph", () => {
    // Mirrors a manifest where only one dep opts into wait:true.
    const catalog = makeCatalog("api", "db", "cache");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
      db: { mode: "dev-managed", path: "/repos/db" },
      cache: { mode: "dev-managed", path: "/repos/cache" },
    });

    mockResolveServiceSource.mockImplementation((address: string) => ({
      address,
      repoName: address,
      subsystem: address,
      repoPath: `/repos/${address}`,
      branch: null,
      mode: "dev-managed" as const,
    }));
    mockReadManifest.mockImplementation((repoPath: string) => {
      if (repoPath === "/repos/api")
        return makeManifest(["cache", { service: "db", wait: true }], "api");
      return makeManifest([]);
    });

    const graph = buildDependencyGraph(["api"], catalog, workspace, "default");
    expect(graph.get("api")).toEqual(expect.arrayContaining(["cache", "db"]));
  });
});

// ── getWaitDeps ───────────────────────────────────────────────────────────────

describe("getWaitDeps", () => {
  beforeEach(() => {
    mockParseAddress.mockImplementation((address: string) => ({
      repoName: address.includes("/") ? address.split("/")[0] : address,
      subsystem: address.includes("/") ? address.split("/")[1] : address,
    }));
    mockResolveDepAddress.mockImplementation((dep: string) => dep);
  });

  it("returns [] when the service has no depends_on", () => {
    const catalog = makeCatalog("api");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });
    mockResolveServiceSource.mockReturnValue({
      address: "api",
      repoName: "api",
      subsystem: "api",
      repoPath: "/repos/api",
      branch: null,
      mode: "dev-managed",
    });
    mockReadManifest.mockReturnValue(makeManifest([]));

    expect(getWaitDeps("api", catalog, workspace, "default")).toEqual([]);
  });

  it("returns [] when no deps are flagged wait: true", () => {
    const catalog = makeCatalog("api", "db");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });
    mockResolveServiceSource.mockReturnValue({
      address: "api",
      repoName: "api",
      subsystem: "api",
      repoPath: "/repos/api",
      branch: null,
      mode: "dev-managed",
    });
    // string form and object form without wait — both default wait:false
    mockReadManifest.mockReturnValue(
      makeManifest(["cache", { service: "db" }]),
    );

    expect(getWaitDeps("api", catalog, workspace, "default")).toEqual([]);
  });

  it("returns only deps flagged wait: true, resolved via resolveDepAddress", () => {
    const catalog = makeCatalog("api", "db", "cache");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });
    mockResolveServiceSource.mockReturnValue({
      address: "api",
      repoName: "api",
      subsystem: "api",
      repoPath: "/repos/api",
      branch: null,
      mode: "dev-managed",
    });
    mockReadManifest.mockReturnValue(
      makeManifest([
        "cache",
        { service: "db", wait: true },
        { service: "queue", wait: false },
      ]),
    );
    // Simulate entrypoint resolution: bare "db" → "db/api"
    mockResolveDepAddress.mockImplementation((dep: string) =>
      dep === "db" ? "db/api" : dep,
    );

    expect(getWaitDeps("api", catalog, workspace, "default")).toEqual([
      "db/api",
    ]);
  });

  it("returns [] when the service cannot be resolved (no manifest)", () => {
    const catalog = makeCatalog("api");
    const workspace = makeWorkspace({
      api: { mode: "dev-managed", path: "/repos/api" },
    });
    mockResolveServiceSource.mockReturnValue(null);

    expect(getWaitDeps("api", catalog, workspace, "default")).toEqual([]);
  });
});

// ── expandSameRepoWaitDeps ────────────────────────────────────────────────────
//
// Regression: card ▶ up on links-api/api deadlocked — the exec runner
// waited on the health of links-api/localstack (a `wait: true` sibling),
// but only that sibling's own `up` provisions the KMS alias its health check
// asserts. Explicit starts must prepend failing same-repo wait-deps.

describe("expandSameRepoWaitDeps", () => {
  const repoOf = (addr: string): string => addr.split("/")[0];

  function harness(opts: {
    waitDeps: Record<string, string[]>;
    failing: string[];
  }) {
    const healthChecked: string[] = [];
    return {
      healthChecked,
      deps: {
        repoOf,
        waitDepsOf: (addr: string) => opts.waitDeps[addr] ?? [],
        isFailing: async (addr: string) => {
          healthChecked.push(addr);
          return opts.failing.includes(addr);
        },
      },
    };
  }

  it("prepends a failing same-repo wait-dep before its dependent (the bug)", async () => {
    const { deps } = harness({
      waitDeps: {
        "links-api/api": [
          "links-api/pg",
          "links-api/localstack",
          "infra-stack/localstack",
        ],
      },
      failing: ["links-api/localstack", "infra-stack/localstack"],
    });

    const res = await expandSameRepoWaitDeps(["links-api/api"], deps);

    expect(res.ordered).toEqual(["links-api/localstack", "links-api/api"]);
    expect(res.added).toEqual(["links-api/localstack"]);
  });

  it("never expands cross-repo deps, even failing ones", async () => {
    const { deps, healthChecked } = harness({
      waitDeps: { "a/api": ["infra-stack/postgres"] },
      failing: ["infra-stack/postgres"],
    });

    const res = await expandSameRepoWaitDeps(["a/api"], deps);

    expect(res.ordered).toEqual(["a/api"]);
    expect(res.added).toEqual([]);
    // Cross-repo deps are excluded before any health check runs.
    expect(healthChecked).toEqual([]);
  });

  it("leaves healthy and unknown deps alone", async () => {
    const { deps } = harness({
      waitDeps: { "a/api": ["a/pg", "a/redis"] },
      failing: [], // both report not-failing (ok or unknown)
    });

    const res = await expandSameRepoWaitDeps(["a/api"], deps);

    expect(res.ordered).toEqual(["a/api"]);
    expect(res.added).toEqual([]);
  });

  it("expands transitive same-repo deps, deps-first", async () => {
    const { deps } = harness({
      waitDeps: { "a/api": ["a/worker"], "a/worker": ["a/pg"] },
      failing: ["a/worker", "a/pg"],
    });

    const res = await expandSameRepoWaitDeps(["a/api"], deps);

    expect(res.ordered).toEqual(["a/pg", "a/worker", "a/api"]);
    expect(res.added).toEqual(["a/pg", "a/worker"]);
  });

  it("tolerates dependency cycles without looping", async () => {
    const { deps } = harness({
      waitDeps: { "a/x": ["a/y"], "a/y": ["a/x"] },
      failing: ["a/x", "a/y"],
    });

    const res = await expandSameRepoWaitDeps(["a/x"], deps);

    expect(res.ordered).toEqual(["a/y", "a/x"]);
    expect(res.added).toEqual(["a/y"]);
  });

  // #68: whole-workspace starts pass EVERY service, so the expansion can only
  // reorder — but two address spellings can name one service, and treating
  // them as distinct would start it twice.
  it("collapses two spellings of the same service via identityOf", async () => {
    // Manifest dep written as "R/R" while the listed address is bare "R".
    const { deps, healthChecked } = harness({
      waitDeps: { "R/api": ["R/R"] },
      failing: ["R/R"],
    });

    const res = await expandSameRepoWaitDeps(["R", "R/api"], {
      ...deps,
      // Both "R" and "R/R" resolve to the repo-root service.
      identityOf: (a: string) => (a === "R" || a === "R/R" ? "R/root" : a),
    });

    expect(res.ordered).toEqual(["R", "R/api"]);
    expect(res.added).toEqual([]);
    // Already queued under its other spelling — must not cost a probe either.
    expect(healthChecked).toEqual([]);
  });

  it("still reorders when the duplicate spelling comes after its dependent", async () => {
    const { deps } = harness({
      waitDeps: { "R/api": ["R/R"] },
      failing: ["R/R"],
    });

    const res = await expandSameRepoWaitDeps(["R/api", "R"], {
      ...deps,
      identityOf: (a: string) => (a === "R" || a === "R/R" ? "R/root" : a),
    });

    // Hoisted under the CALLER's spelling ("R"), not the manifest's ("R/R").
    // Downstream keys off the exact string — isPrimaryAddr compares the full
    // address — so emitting a dep-only spelling would stop the live log
    // auto-attaching for the repo's primary service.
    expect(res.ordered).toEqual(["R", "R/api"]);
    expect(res.added).toEqual([]);
  });

  // A dep already in the run list is hoisted regardless of health. `restart`
  // takes every listed service down and back up in order, so leaving a
  // currently-HEALTHY dep after its dependent means it is torn down and
  // recreated underneath a service already restarted against it.
  it("hoists a healthy dep that is already in the run list", async () => {
    const { deps, healthChecked } = harness({
      waitDeps: { "a/api": ["a/pg"] },
      failing: [], // healthy right now — irrelevant, it is going down anyway
    });

    const res = await expandSameRepoWaitDeps(["a/api", "a/pg"], deps);

    expect(res.ordered).toEqual(["a/pg", "a/api"]);
    expect(res.added).toEqual([]);
    // Listed deps are hoisted on the strength of the manifest alone — no probe.
    expect(healthChecked).toEqual([]);
  });

  it("still requires a probe before ADDING a dep the caller did not list", async () => {
    const { deps, healthChecked } = harness({
      waitDeps: { "a/api": ["a/pg"] },
      failing: [], // healthy and unlisted → must not be pulled into the run
    });

    const res = await expandSameRepoWaitDeps(["a/api"], deps);

    expect(res.ordered).toEqual(["a/api"]);
    expect(res.added).toEqual([]);
    expect(healthChecked).toEqual(["a/pg"]);
  });

  it("is a pure no-op when every manifest already reads deps-first", async () => {
    // The real shape of this workspace: deps precede dependents, so nothing is
    // probed and the order is returned untouched.
    const { deps, healthChecked } = harness({
      waitDeps: { "a/api": ["a/pg"], "b/api": ["b/db"] },
      failing: ["a/pg", "b/db"],
    });

    const input = ["a/pg", "a/api", "b/db", "b/api"];
    const res = await expandSameRepoWaitDeps(input, deps);

    expect(res.ordered).toEqual(input);
    expect(res.added).toEqual([]);
    expect(healthChecked).toEqual([]);
  });

  it("keeps a hoist inside its own repo block (whole-workspace shape)", async () => {
    const { deps } = harness({
      waitDeps: { "b/api": ["b/localstack"] },
      failing: ["b/localstack"],
    });

    const res = await expandSameRepoWaitDeps(
      ["a/svc", "b/api", "b/localstack", "c/svc"],
      deps,
    );

    // b's dep moves ahead of b/api only — a and c keep their positions.
    expect(res.ordered).toEqual(["a/svc", "b/localstack", "b/api", "c/svc"]);
    expect(res.added).toEqual([]);
  });

  it("reorders a dep the caller listed AFTER its dependent (added is empty)", async () => {
    // The helper both ADDS and REORDERS. When every failing dep is already in
    // the explicit list, `added` is empty but the reorder is still the thing
    // that prevents the deadlock — a caller that gates on `added` drops it.
    const { deps } = harness({
      waitDeps: { "a/api": ["a/localstack"] },
      failing: ["a/localstack"],
    });

    const res = await expandSameRepoWaitDeps(["a/api", "a/localstack"], deps);

    expect(res.ordered).toEqual(["a/localstack", "a/api"]);
    expect(res.added).toEqual([]);
  });

  it("never probes a dep it has already queued or is mid-cycle on", async () => {
    const { deps, healthChecked } = harness({
      waitDeps: { "a/x": ["a/y"], "a/y": ["a/x"] },
      failing: ["a/x", "a/y"],
    });

    await expandSameRepoWaitDeps(["a/x"], deps);

    // a/y probed once; a/x is in-stack, so it must not cost a live check.
    expect(healthChecked).toEqual(["a/y"]);
  });

  it("does not duplicate a dep the caller already listed explicitly", async () => {
    const { deps } = harness({
      waitDeps: { "a/api": ["a/localstack"] },
      failing: ["a/localstack"],
    });

    const res = await expandSameRepoWaitDeps(["a/localstack", "a/api"], deps);

    expect(res.ordered).toEqual(["a/localstack", "a/api"]);
    expect(res.added).toEqual([]);
  });
});
