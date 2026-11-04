import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { EventEmitter } from "events";
import * as path from "path";
import { getDistRoot } from "../../src/shared/paths.js";

// k6 summary paths are den-root anchored (absolute) since the cwd audit.
const anchored = (p: string) => path.resolve(getDistRoot(), p);

const spawnMock = jest.fn();
const findManifestMock = jest.fn();
const resolveRepoPathMock = jest.fn();
const acquireFixtureMock = jest.fn() as jest.MockedFunction<
  (...args: unknown[]) => Promise<() => Promise<void>>
>;
const releaseFixturesForConsumerMock = jest.fn() as jest.MockedFunction<
  (releases: ReadonlyArray<() => Promise<void>>) => Promise<void>
>;
const resolvePerformanceStorageFixtureMock = jest.fn();

jest.mock("child_process", () => ({
  spawn: spawnMock,
}));

jest.mock("../../src/pillars/smoke/discover.js", () => ({
  findManifest: findManifestMock,
  resolveRepoPath: resolveRepoPathMock,
}));

jest.mock("../../src/pillars/smoke/fixture-manager.js", () => ({
  acquireFixture: acquireFixtureMock,
  releaseFixturesForConsumer: releaseFixturesForConsumerMock,
}));

jest.mock("../../src/pillars/smoke/fixtures.js", () => ({
  resolvePerformanceStorageFixture: resolvePerformanceStorageFixtureMock,
}));

/** Mocked k6 never writes summary JSON; real writeCurrentPerfRunReport would throw and warn. */
jest.mock("../../src/shared/perf/report-store.js", () => ({
  resetCurrentPerfRunReport: jest.fn(),
  writeCurrentPerfRunReport: jest.fn(() => ({
    pillar: "performance",
    environment: "local",
    status: "passed",
    modules: [],
    rawArtifacts: [],
  })),
}));

import {
  runPerfModules,
  resolveBaseUrlFromManifest,
} from "../../src/pillars/perf/run.js";

/** Generic registered repo + perf modules — must not mirror any real product repo. */
const SAMPLE_REPO = "sample-repo";
const SAMPLE_SERVICE = "sample-service";
const SAMPLE_ROOT = `/work/${SAMPLE_REPO}`;

function mockSpawnExit(exitCode: number) {
  spawnMock.mockImplementationOnce(() => {
    const proc = new EventEmitter();
    setImmediate(() => {
      proc.emit("close", exitCode);
    });
    return proc;
  });
}

const manifest = {
  name: SAMPLE_REPO,
  performance: {
    alpha: {
      testDir: "tests/perf",
      testMatch: "alpha/test.js",
      baseUrlKey: "api",
      service: SAMPLE_SERVICE,
      fixtures: { storage: { local: { bucket: "smoke-bucket" } } },
    },
    beta: {
      testDir: "tests/perf",
      testMatch: "beta/test.js",
      baseUrlKey: "api",
      service: SAMPLE_SERVICE,
      fixtures: { storage: { local: { bucket: "smoke-bucket" } } },
    },
  },
};

describe("runPerfModules", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findManifestMock.mockReturnValue({
      repoName: SAMPLE_REPO,
      repoPath: SAMPLE_ROOT,
      manifest,
    });
    resolveRepoPathMock.mockReturnValue(SAMPLE_ROOT);
    resolvePerformanceStorageFixtureMock.mockImplementation(
      (_manifest: unknown, moduleName: string) => ({
        fixtureKey: `${SAMPLE_SERVICE}:perf:${moduleName}:storage:local`,
        resolvedPayload: {
          endpoint: "http://localhost:9000",
          apiEndpoint: "http://127.0.0.1:9000",
          bucket: "smoke-bucket",
          accessKey: "access",
          secretKey: "secret",
        },
        envVars: {
          SMOKE_STORAGE_FIXTURE_JSON: '{"bucket":"smoke-bucket"}',
          SMOKE_CLEANUP_CONTEXT_JSON: '{"objectStores":{}}',
        },
        teardown: "node scripts/cleanup.mjs",
      }),
    );
    releaseFixturesForConsumerMock.mockResolvedValue(undefined);
  });

  it("acquires perf fixtures, injects cleanup env, and releases in order", async () => {
    const release1 = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const release2 = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    acquireFixtureMock
      .mockResolvedValueOnce(release1)
      .mockResolvedValueOnce(release2);
    mockSpawnExit(0);
    mockSpawnExit(0);

    const result = await runPerfModules({
      modules: [
        { repoName: SAMPLE_REPO, moduleName: "alpha" },
        { repoName: SAMPLE_REPO, moduleName: "beta" },
      ],
      environment: "local",
      baseUrl: "http://localhost:8080",
    });

    expect(result).toEqual({ success: true, exitCode: 0 });
    expect(acquireFixtureMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fixtureKey: `${SAMPLE_SERVICE}:perf:alpha:storage:local`,
        cwd: SAMPLE_ROOT,
        env: expect.objectContaining({
          BASE_URL: "http://localhost:8080",
          BASE_API_URL: "http://localhost:8080",
          PERF_TEST_ID: `${SAMPLE_REPO}/alpha`,
          SMOKE_STORAGE_FIXTURE_JSON: '{"bucket":"smoke-bucket"}',
        }),
      }),
    );
    expect(acquireFixtureMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fixtureKey: `${SAMPLE_SERVICE}:perf:beta:storage:local`,
        env: expect.objectContaining({
          PERF_TEST_ID: `${SAMPLE_REPO}/beta`,
          SMOKE_CLEANUP_CONTEXT_JSON: '{"objectStores":{}}',
        }),
      }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "k6",
      [
        "run",
        "--summary-export",
        anchored(".perf-report/current/sample-repo-alpha.summary.json"),
        `${SAMPLE_ROOT}/tests/perf/alpha/test.js`,
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          PERF_TEST_ID: `${SAMPLE_REPO}/alpha`,
        }),
        stdio: "inherit",
      }),
    );
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "k6",
      [
        "run",
        "--summary-export",
        anchored(".perf-report/current/sample-repo-beta.summary.json"),
        `${SAMPLE_ROOT}/tests/perf/beta/test.js`,
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          PERF_TEST_ID: `${SAMPLE_REPO}/beta`,
        }),
        stdio: "inherit",
      }),
    );
    expect(releaseFixturesForConsumerMock).toHaveBeenCalledWith([
      release1,
      release2,
    ]);
  });

  it("GETs adminProbePath before acquireFixture when the manifest sets it", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    const prevFetch = global.fetch;
    global.fetch = fetchMock as typeof fetch;
    resolvePerformanceStorageFixtureMock.mockImplementation(
      (_manifest: unknown, moduleName: string) => ({
        fixtureKey: `${SAMPLE_SERVICE}:perf:${moduleName}:storage:local`,
        adminProbePath: "/api/v1/admin/ingest-queue/status",
        resolvedPayload: {
          endpoint: "http://localhost:9000",
          apiEndpoint: "http://127.0.0.1:9000",
          bucket: "smoke-bucket",
          accessKey: "access",
          secretKey: "secret",
        },
        envVars: {
          SMOKE_STORAGE_FIXTURE_JSON: '{"bucket":"smoke-bucket"}',
        },
        teardown: "node scripts/cleanup.mjs",
      }),
    );
    acquireFixtureMock.mockResolvedValue(
      jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    );
    mockSpawnExit(0);
    try {
      await runPerfModules({
        modules: [{ repoName: SAMPLE_REPO, moduleName: "alpha" }],
        environment: "local",
        baseUrl: "http://localhost:8080",
      });
    } finally {
      global.fetch = prevFetch;
    }
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/admin/ingest-queue/status",
      expect.objectContaining({ method: "GET" }),
    );
    expect(acquireFixtureMock).toHaveBeenCalled();
  });

  it("releases acquired fixtures when a perf module fails", async () => {
    const release1 = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const release2 = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    acquireFixtureMock
      .mockResolvedValueOnce(release1)
      .mockResolvedValueOnce(release2);
    mockSpawnExit(0);
    mockSpawnExit(7);

    const result = await runPerfModules({
      modules: [
        { repoName: SAMPLE_REPO, moduleName: "alpha" },
        { repoName: SAMPLE_REPO, moduleName: "beta" },
      ],
      environment: "local",
      baseUrl: "http://localhost:8080",
    });

    expect(result).toEqual({ success: false, exitCode: 7 });
    expect(releaseFixturesForConsumerMock).toHaveBeenCalledWith([
      release1,
      release2,
    ]);
  });

  it("fails the run when fixture teardown fails after k6 succeeds", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const release1 = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    acquireFixtureMock.mockResolvedValueOnce(release1);
    mockSpawnExit(0);
    releaseFixturesForConsumerMock.mockRejectedValueOnce(
      new Error("fixture teardown failed"),
    );

    try {
      const result = await runPerfModules({
        modules: [{ repoName: SAMPLE_REPO, moduleName: "alpha" }],
        environment: "local",
        baseUrl: "http://localhost:8080",
      });

      expect(result).toEqual({ success: false, exitCode: 1 });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("preserves k6 exit code when teardown fails after k6 already failed", async () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const release1 = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    acquireFixtureMock.mockResolvedValueOnce(release1);
    mockSpawnExit(9);
    releaseFixturesForConsumerMock.mockRejectedValueOnce(
      new Error("fixture teardown failed"),
    );

    try {
      const result = await runPerfModules({
        modules: [{ repoName: SAMPLE_REPO, moduleName: "alpha" }],
        environment: "local",
        baseUrl: "http://localhost:8080",
      });

      expect(result).toEqual({ success: false, exitCode: 9 });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("skips disabled modules and runs the rest", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const manifestWithSkip = structuredClone(manifest);
    Object.assign(manifestWithSkip.performance.alpha, { enabled: false });

    findManifestMock.mockReturnValue({
      repoName: SAMPLE_REPO,
      repoPath: SAMPLE_ROOT,
      manifest: manifestWithSkip,
    });

    const release1 = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    acquireFixtureMock.mockResolvedValueOnce(release1);
    mockSpawnExit(0);

    try {
      const result = await runPerfModules({
        modules: [
          { repoName: SAMPLE_REPO, moduleName: "alpha" },
          { repoName: SAMPLE_REPO, moduleName: "beta" },
        ],
        environment: "local",
        baseUrl: "http://localhost:8080",
      });

      expect(result).toEqual({ success: true, exitCode: 0 });
      expect(acquireFixtureMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(
        "k6",
        [
          "run",
          "--summary-export",
          anchored(".perf-report/current/sample-repo-beta.summary.json"),
          `${SAMPLE_ROOT}/tests/perf/beta/test.js`,
        ],
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("throws when every requested module is disabled", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const m = structuredClone(manifest);
    Object.assign(m.performance.alpha, { enabled: false });
    Object.assign(m.performance.beta, { enabled: false });
    findManifestMock.mockReturnValue({
      repoName: SAMPLE_REPO,
      repoPath: SAMPLE_ROOT,
      manifest: m,
    });

    try {
      await expect(
        runPerfModules({
          modules: [
            { repoName: SAMPLE_REPO, moduleName: "alpha" },
            { repoName: SAMPLE_REPO, moduleName: "beta" },
          ],
          environment: "local",
          baseUrl: "http://localhost:8080",
        }),
      ).rejects.toThrow(/All requested performance modules are disabled/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("resolveBaseUrlFromManifest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves URL from manifest services.*.health entry", () => {
    const manifestWithHealth = {
      name: SAMPLE_REPO,
      performance: {
        alpha: {
          testDir: "tests/perf",
          testMatch: "alpha/test.js",
          baseUrlKey: "api" as const,
          service: SAMPLE_SERVICE,
        },
      },
      services: {
        [SAMPLE_SERVICE]: {
          health: {
            local: { url: "http://localhost:8080/healthz" },
          },
        },
      },
    };
    findManifestMock.mockReturnValue({
      repoName: SAMPLE_REPO,
      repoPath: SAMPLE_ROOT,
      manifest: manifestWithHealth,
    });

    const url = resolveBaseUrlFromManifest(SAMPLE_REPO, "alpha", "local");

    expect(url).toBe("http://localhost:8080");
  });

  it("falls back to repoName when service key has no match", () => {
    const manifestWithRepoKey = {
      name: SAMPLE_REPO,
      performance: {
        alpha: {
          testDir: "tests/perf",
          testMatch: "alpha/test.js",
          baseUrlKey: "api" as const,
          service: "nonexistent-service",
        },
      },
      services: {
        [SAMPLE_REPO]: {
          health: {
            local: { url: "http://localhost:9090/healthz" },
          },
        },
      },
    };
    findManifestMock.mockReturnValue({
      repoName: SAMPLE_REPO,
      repoPath: SAMPLE_ROOT,
      manifest: manifestWithRepoKey,
    });

    const url = resolveBaseUrlFromManifest(SAMPLE_REPO, "alpha", "local");

    expect(url).toBe("http://localhost:9090");
  });

  it("returns null when manifest is not found", () => {
    findManifestMock.mockReturnValue(null);

    const url = resolveBaseUrlFromManifest("unknown-repo", "alpha", "local");

    expect(url).toBeNull();
  });

  it("returns null when module is not found in manifest", () => {
    findManifestMock.mockReturnValue({
      repoName: SAMPLE_REPO,
      repoPath: SAMPLE_ROOT,
      manifest: { name: SAMPLE_REPO, performance: {} },
    });

    const url = resolveBaseUrlFromManifest(
      SAMPLE_REPO,
      "missing-module",
      "local",
    );

    expect(url).toBeNull();
  });

  it("returns null when no health entry exists for the environment and no service-specific config", () => {
    const manifestNoLocalHealth = {
      name: SAMPLE_REPO,
      performance: {
        alpha: {
          testDir: "tests/perf",
          testMatch: "alpha/test.js",
          baseUrlKey: "api" as const,
          service: SAMPLE_SERVICE,
        },
      },
      services: {
        [SAMPLE_SERVICE]: {
          health: {
            staging: { url: "https://api.staging.example.com/healthz" },
          },
        },
      },
    };
    findManifestMock.mockReturnValue({
      repoName: SAMPLE_REPO,
      repoPath: SAMPLE_ROOT,
      manifest: manifestNoLocalHealth,
    });

    const url = resolveBaseUrlFromManifest(SAMPLE_REPO, "alpha", "local");

    // No service-specific config entry → null, so CLI --base-url takes effect
    expect(url).toBeNull();
  });
});
