import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

jest.mock("../../../src/pillars/smoke/discover.js", () => ({
  discoverRepos: jest.fn(),
}));

jest.mock("../../../src/shared/manifest/read-manifest.js", () => ({
  readManifestAsync: jest.fn(),
}));

import { discoverRepos } from "../../../src/pillars/smoke/discover.js";
import { readManifestAsync } from "../../../src/shared/manifest/read-manifest.js";
import { ModuleScanner } from "../../../src/shared/test-discovery/module-scanner.js";
import type {
  DiscoveredRepo,
  RawManifest,
} from "../../../src/shared/types/index.js";

const mockedDiscoverRepos = jest.mocked(discoverRepos);
const mockedReadManifestAsync = jest.mocked(readManifestAsync);

// Minimal spec passing the journeys Zod schema (schema.ts) — the module
// scanner validates specs through the real loader during discovery.
const VALID_JOURNEY_SPEC_YAML = [
  "name: first-visit",
  "persona:",
  "  role: user",
  "  brief: You are a new user visiting for the first time.",
  "surface: browser",
  "environments: [local, staging]",
  "budgets:",
  "  max_turns: 40",
  "  timeout_s: 480",
  "  max_total_tokens: 2000000",
  "success:",
  "  assertions:",
  "    - kind: http_status",
  '      request: { method: GET, path: "/api/v1/items/{item_id}" }',
  "      equals: 200",
  "",
].join("\n");

describe("ModuleScanner performance discovery", () => {
  let tempDir: string;
  let savedDistRoot: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "den-perf-modules-"));
    // ModuleScanner anchors at getDistRoot() (not cwd) — pin it to the fixture.
    // getDistRoot() validates the env points at a den checkout.
    await fs.writeFile(
      path.join(tempDir, "den.yml"),
      "product:\n  name: den\n",
    );
    savedDistRoot = process.env.DEN_ROOT;
    process.env.DEN_ROOT = tempDir;
    mockedDiscoverRepos.mockReset();
    mockedReadManifestAsync.mockReset();
  });

  afterEach(async () => {
    if (savedDistRoot === undefined) delete process.env.DEN_ROOT;
    else process.env.DEN_ROOT = savedDistRoot;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns no distribution perf modules, and no warning, when the distribution ships none", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockedDiscoverRepos.mockReturnValue([]);

    const modules = await new ModuleScanner().scanModules("performance");

    expect(modules).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns both distribution and repo-owned performance modules", async () => {
    await fs.mkdir(
      path.join(tempDir, "tests", "pillars", "perf", "api-health"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(tempDir, "tests", "pillars", "perf", "api-health", "test.js"),
      "export default function () {}\n",
    );

    const repoPath = path.join(tempDir, "repos", "sample-service");
    await fs.mkdir(path.join(repoPath, "tests", "den-perf", "search"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoPath, "tests", "den-perf", "search", "test.js"),
      "export default function () {}\n",
    );
    await fs.writeFile(
      path.join(repoPath, "tests", "den-perf", "search", "helpers.js"),
      "export const helper = true;\n",
    );

    const manifest: RawManifest = {
      name: "sample-service",
      performance: {
        search: {
          testDir: "tests/den-perf/search",
          testMatch: "test.js",
          baseUrlKey: "api",
          service: "sample-service",
          tags: ["search"],
        },
      },
      services: {
        "sample-service": {
          health: {
            local: { url: "http://localhost:8080/healthz" },
          },
        },
      },
    };

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "sample-service",
        repoPath,
        manifest,
      } satisfies DiscoveredRepo,
    ]);

    const scanner = new ModuleScanner();
    const modules = await scanner.scanModules("performance");

    expect(modules.map((module) => module.name)).toEqual([
      "api-health",
      "sample-service/search",
    ]);
    expect(modules[1]).toMatchObject({
      displayName: "sample-service — search",
      path: path.join(repoPath, "tests", "den-perf", "search"),
      testCount: 1,
      tags: ["search"],
    });
  });

  it("surfaces optionalFields declared in a distribution perf manifest.yml", async () => {
    const moduleDir = path.join(
      tempDir,
      "tests",
      "pillars",
      "perf",
      "api-load",
    );
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.writeFile(
      path.join(moduleDir, "test.js"),
      "export default function () {}\n",
    );
    await fs.writeFile(
      path.join(moduleDir, "manifest.yml"),
      [
        "name: API Load",
        "optionalFields:",
        "  - name: smoke",
        "    label: trial run (smoke)",
        "    type: boolean",
        "    env: LOAD_SMOKE",
        '    emit: "1"',
        "    default: false",
        "  - name: target",
        "    label: target load",
        "    type: select",
        "    env: LOAD_TARGET",
        '    default: "3k"',
        "    options:",
        '      - { value: "3k", label: "3k" }',
        '      - { value: "10k", label: "10k" }',
        "    disabledWhen: { field: smoke, equals: true }",
      ].join("\n"),
      "utf-8",
    );

    mockedDiscoverRepos.mockReturnValue([]);

    const modules = await new ModuleScanner().scanModules("performance");
    const apiLoad = modules.find((m) => m.name === "api-load");
    expect(apiLoad?.optionalFields).toEqual([
      {
        name: "smoke",
        label: "trial run (smoke)",
        type: "boolean",
        env: "LOAD_SMOKE",
        emit: "1",
        default: false,
      },
      {
        name: "target",
        label: "target load",
        type: "select",
        env: "LOAD_TARGET",
        default: "3k",
        options: [
          { value: "3k", label: "3k" },
          { value: "10k", label: "10k" },
        ],
        disabledWhen: { field: "smoke", equals: true },
      },
    ]);
  });

  it("surfaces optionalFields declared on a repo-owned perf config", async () => {
    const repoPath = path.join(tempDir, "repos", "sample-service");
    await fs.mkdir(path.join(repoPath, "tests", "den-perf", "search"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoPath, "tests", "den-perf", "search", "test.js"),
      "export default function () {}\n",
    );

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "sample-service",
        repoPath,
        manifest: {
          name: "sample-service",
          performance: {
            search: {
              testDir: "tests/den-perf/search",
              testMatch: "test.js",
              baseUrlKey: "api",
              service: "sample-service",
              optionalFields: [
                {
                  name: "region",
                  label: "region",
                  type: "string",
                  env: "REGION",
                },
              ],
            },
          },
        },
      } satisfies DiscoveredRepo,
    ]);

    const modules = await new ModuleScanner().scanModules("performance");
    expect(
      modules.find((m) => m.name === "sample-service/search")?.optionalFields,
    ).toEqual([
      { name: "region", label: "region", type: "string", env: "REGION" },
    ]);
  });

  it("counts repo-owned performance tests for nested **/test.js patterns", async () => {
    const repoPath = path.join(tempDir, "repos", "sample-service");
    await fs.mkdir(path.join(repoPath, "tests", "den-perf", "tree", "nested"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoPath, "tests", "den-perf", "tree", "nested", "test.js"),
      "export default function () {}\n",
    );
    await fs.writeFile(
      path.join(repoPath, "tests", "den-perf", "tree", "nested", "helpers.js"),
      "export const helper = true;\n",
    );

    const manifest: RawManifest = {
      name: "sample-service",
      performance: {
        tree: {
          testDir: "tests/den-perf/tree",
          testMatch: "**/test.js",
          baseUrlKey: "api",
          service: "sample-service",
        },
      },
      services: {
        "sample-service": {
          health: {
            local: { url: "http://localhost:8080/healthz" },
          },
        },
      },
    };

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "sample-service",
        repoPath,
        manifest,
      } satisfies DiscoveredRepo,
    ]);

    const scanner = new ModuleScanner();
    const modules = await scanner.scanModules("performance");

    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({
      name: "sample-service/tree",
      testCount: 1,
    });
  });

  it("counts repo-owned performance tests when testMatch targets a relative module path", async () => {
    const repoPath = path.join(tempDir, "repos", "sample-service");
    await fs.mkdir(path.join(repoPath, "tests", "den-perf", "search"), {
      recursive: true,
    });
    await fs.mkdir(path.join(repoPath, "tests", "den-perf", "shared"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoPath, "tests", "den-perf", "search", "test.js"),
      "export default function () {}\n",
    );
    await fs.writeFile(
      path.join(repoPath, "tests", "den-perf", "shared", "helpers.js"),
      "export const helper = true;\n",
    );

    const manifest: RawManifest = {
      name: "sample-service",
      performance: {
        search: {
          testDir: "tests/den-perf",
          testMatch: "search/test.js",
          baseUrlKey: "api",
          service: "sample-service",
        },
      },
      services: {
        "sample-service": {
          health: {
            local: { url: "http://localhost:8080/healthz" },
          },
        },
      },
    };

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "sample-service",
        repoPath,
        manifest,
      } satisfies DiscoveredRepo,
    ]);

    const scanner = new ModuleScanner();
    const modules = await scanner.scanModules("performance");

    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({
      name: "sample-service/search",
      path: path.join(repoPath, "tests", "den-perf"),
      testCount: 1,
    });
  });

  it("returns smoke services from discovered repos and counts nested smoke files", async () => {
    const repoPath = path.join(tempDir, "repos", "sample-service");
    await fs.mkdir(path.join(repoPath, "tests", "smoke", "api", "nested"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoPath, "tests", "smoke", "api", "health.smoke.ts"),
      "test('health', () => {})\n",
    );
    await fs.writeFile(
      path.join(repoPath, "tests", "smoke", "api", "nested", "search.smoke.ts"),
      "test('search', () => {})\n",
    );

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "sample-service",
        repoPath,
        manifest: {
          name: "sample-service",
          smoke: {
            api: {
              testDir: "tests/smoke/api",
              testMatch: "**/*.smoke.ts",
              baseUrlKey: "api",
              auth: ["admin"],
            },
          },
        },
      } satisfies DiscoveredRepo,
    ]);

    const modules = await new ModuleScanner().scanModules("smoke");

    expect(modules).toEqual([
      expect.objectContaining({
        name: "sample-service/api",
        displayName: "sample-service — api",
        icon: "🔗",
        testCount: 2,
        tags: ["api"],
      }),
    ]);
  });

  it("discovers synthetic modules from discovered repos and skips helper directories", async () => {
    const repoDir = path.join(tempDir, "sample-service");
    const moduleDir = path.join(
      repoDir,
      "synthetic",
      "collections",
      "search-flow",
    );
    const skippedDir = path.join(
      repoDir,
      "synthetic",
      "collections",
      "helpers",
    );
    await fs.mkdir(moduleDir, { recursive: true });
    await fs.mkdir(skippedDir, { recursive: true });
    await fs.writeFile(
      path.join(moduleDir, "manifest.yml"),
      [
        "name: Linked Search Flow",
        "description: Synthetic flow from manifest",
        "icon: 🧪",
        "tags:",
        "  - linked",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(moduleDir, "test.spec.ts"),
      "test('linked synthetic', () => {})\n",
    );

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "sample-service",
        repoPath: repoDir,
        manifest: {
          name: "sample-service",
          synthetics: {
            testDir: "synthetic/collections",
            testMatch: "**/*.spec.ts",
            baseUrlKey: "web",
            auth: ["admin"],
          },
        } as unknown as RawManifest,
      },
    ]);

    const modules = await new ModuleScanner().scanModules("synthetic");

    expect(modules).toEqual([
      expect.objectContaining({
        name: "search-flow",
        displayName: "Linked Search Flow",
        description: "Synthetic flow from manifest",
        icon: "🧪",
        testCount: 1,
        tags: ["linked"],
      }),
    ]);
  });

  it("falls back to local browser tests when no discovered repo exposes synthetics", async () => {
    const fallbackDir = path.join(
      tempDir,
      "src",
      "pillars",
      "browser",
      "tests",
      "basic-check",
    );
    await fs.mkdir(fallbackDir, { recursive: true });
    await fs.mkdir(
      path.join(tempDir, "src", "pillars", "browser", "tests", "helpers"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(fallbackDir, ".gitkeep"),
      "# Runs a basic browser check\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(fallbackDir, "smoke.spec.ts"),
      "test('fallback synthetic', () => {})\n",
    );

    mockedDiscoverRepos.mockReturnValue([]);

    const modules = await new ModuleScanner().scanModules("synthetic");

    expect(modules).toEqual([
      expect.objectContaining({
        name: "basic-check",
        displayName: "Basic Check",
        description: "Runs a basic browser check",
        icon: "📦",
        testCount: 1,
      }),
    ]);
  });

  it("returns an empty list and warns when filesystem module scanning fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const modules = await new ModuleScanner().scanModules("integration");

    expect(modules).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "Warning: Could not scan integration test modules:",
      expect.any(String),
    );

    warnSpy.mockRestore();
  });

  it("returns zero testCount when a repo-owned performance test directory is unreadable", async () => {
    const repoPath = path.join(tempDir, "repos", "sample-service");

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "sample-service",
        repoPath,
        manifest: {
          name: "sample-service",
          performance: {
            search: {
              testDir: "tests/den-perf/missing",
              testMatch: "test.js",
              baseUrlKey: "api",
              service: "sample-service",
            },
          },
        },
      } satisfies DiscoveredRepo,
    ]);

    const modules = await new ModuleScanner().scanModules("performance");

    expect(modules).toEqual([
      expect.objectContaining({
        name: "sample-service/search",
        testCount: 0,
      }),
    ]);
  });

  it("lists one journeys module per discovered journey spec", async () => {
    const repoPath = path.join(tempDir, "repos", "web");
    await fs.mkdir(path.join(repoPath, "tests", "journeys"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoPath, "tests", "journeys", "first-visit.journey.yml"),
      VALID_JOURNEY_SPEC_YAML,
      "utf-8",
    );

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "web",
        repoPath,
        manifest: {
          name: "web",
          journeys: {
            testDir: "tests/journeys",
            testMatch: "**/*.journey.yml",
          },
        } satisfies RawManifest,
      } satisfies DiscoveredRepo,
    ]);

    const modules = await new ModuleScanner().scanModules("journeys");

    expect(modules).toEqual([
      expect.objectContaining({
        name: "web/first-visit",
        displayName: "web — first-visit",
        icon: "🧭",
        testCount: 1,
        tags: ["browser"],
        path: path.join(
          repoPath,
          "tests",
          "journeys",
          "first-visit.journey.yml",
        ),
      }),
    ]);
  });

  it("returns an empty journeys list when no repos are registered", async () => {
    mockedDiscoverRepos.mockReturnValue([]);

    const modules = await new ModuleScanner().scanModules("journeys");

    expect(modules).toEqual([]);
  });

  it("warns and returns an empty journeys list when discovery fails", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const repoPath = path.join(tempDir, "repos", "web");

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "web",
        repoPath,
        manifest: {
          name: "web",
          journeys: {
            testDir: "tests/journeys-missing",
            testMatch: "**/*.journey.yml",
          },
        } satisfies RawManifest,
      } satisfies DiscoveredRepo,
    ]);

    const modules = await new ModuleScanner().scanModules("journeys");

    expect(modules).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      "Warning: Could not scan journeys modules:",
      expect.any(String),
    );

    warnSpy.mockRestore();
  });

  it("counts repo-owned performance tests for **/*.js patterns", async () => {
    const repoPath = path.join(tempDir, "repos", "sample-service");
    await fs.mkdir(path.join(repoPath, "tests", "den-perf", "tree", "nested"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoPath, "tests", "den-perf", "tree", "nested", "test.js"),
      "export default function () {}\n",
    );
    await fs.writeFile(
      path.join(repoPath, "tests", "den-perf", "tree", "nested", "helpers.js"),
      "export const helper = true;\n",
    );

    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "sample-service",
        repoPath,
        manifest: {
          name: "sample-service",
          performance: {
            tree: {
              testDir: "tests/den-perf/tree",
              testMatch: "**/*.js",
              baseUrlKey: "api",
              service: "sample-service",
            },
          },
        },
      } satisfies DiscoveredRepo,
    ]);

    const modules = await new ModuleScanner().scanModules("performance");

    expect(modules).toEqual([
      expect.objectContaining({
        name: "sample-service/tree",
        testCount: 2,
      }),
    ]);
  });
});
