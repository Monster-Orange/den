import {
  describe,
  expect,
  it,
  jest,
  afterEach,
  beforeEach,
} from "@jest/globals";
import {
  discoverRepos,
  resolveRepoPath,
  resolveRegisteredRepoPath,
  resolvePerformanceService,
  resolveService,
} from "../../../src/pillars/smoke/discover.js";
import {
  buildPerformanceFixtureEnv,
  resolvePerformanceStorageFixture,
  buildSmokeFixtureEnv,
  resolveSmokeCleanupFixture,
  resolveSmokeStorageFixture,
  smokeStorageFixtureHashInput,
} from "../../../src/pillars/smoke/fixtures.js";
import type {
  DiscoveredRepo,
  RawManifest,
} from "../../../src/shared/types/index.js";

function makeDiscoveredRepo(repoPath = "/work/sample-service"): DiscoveredRepo {
  const manifest: RawManifest = {
    name: "sample-service",
    smoke: {
      api: {
        testDir: "tests/den-smoke",
        testMatch: "**/*.smoke.ts",
        baseUrlKey: "api",
        auth: [],
        fixtures: {
          storage: {
            local: {
              endpoint: "http://localhost:9000",
              apiEndpoint: "http://host.docker.internal:9000",
              bucket: "artifacts-smoke",
              accessKey: "artifacts_admin",
              secretKey: "artifacts_pass",
              cleanupContext: {
                objectStores: {
                  app: {
                    endpoint: "http://minio:9000",
                    bucket: "artifacts-local",
                    accessKey: "artifacts_admin",
                    secretKey: "artifacts_pass",
                  },
                },
              },
              teardown: "node scripts/smoke_cleanup.mjs",
            },
          },
        },
      },
    },
    performance: {
      ingest: {
        testDir: "tests/den-perf",
        testMatch: "ingest/test.js",
        baseUrlKey: "api",
        service: "sample-service",
        tags: ["artifacts", "ingest"],
        fixtures: {
          storage: {
            local: {
              endpoint: "http://localhost:9000",
              apiEndpoint: "http://host.docker.internal:9000",
              bucket: "artifacts-smoke",
              accessKey: "artifacts_admin",
              secretKey: "artifacts_pass",
              cleanupContext: {
                objectStores: {
                  app: {
                    endpoint: "http://minio:9000",
                    bucket: "artifacts-local",
                    accessKey: "artifacts_admin",
                    secretKey: "artifacts_pass",
                  },
                },
              },
              teardown: "node scripts/smoke_cleanup.mjs",
            },
          },
        },
      },
    },
  };

  return {
    repoName: "sample-service",
    repoPath,
    manifest,
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("resolveRegisteredRepoPath", () => {
  it("always uses the registered repo checkout", () => {
    expect(resolveRegisteredRepoPath(makeDiscoveredRepo())).toBe(
      "/work/sample-service",
    );
  });
});

describe("resolveRepoPath", () => {
  it("uses the registered repo path for local smoke runs", () => {
    expect(resolveRepoPath(makeDiscoveredRepo(), "local")).toBe(
      "/work/sample-service",
    );
  });

  it("uses the registered repo path when local checkout mode is enabled", () => {
    expect(resolveRepoPath(makeDiscoveredRepo(), "sandbox", true)).toBe(
      "/work/sample-service",
    );
  });

  it("still requires the deployed clone path by default for cloud runs", () => {
    expect(() => resolveRepoPath(makeDiscoveredRepo(), "sandbox")).toThrow(
      /sample-service@sandbox/,
    );
  });
});

describe("resolveService", () => {
  it("preserves storage fixture config and lifecycle from the manifest", () => {
    const service = resolveService(makeDiscoveredRepo(), "api");
    expect(service).not.toBeNull();
    expect(service?.fixtures?.storage?.local).toEqual({
      endpoint: "http://localhost:9000",
      apiEndpoint: "http://host.docker.internal:9000",
      bucket: "artifacts-smoke",
      accessKey: "artifacts_admin",
      secretKey: "artifacts_pass",
      cleanupContext: {
        objectStores: {
          app: {
            endpoint: "http://minio:9000",
            bucket: "artifacts-local",
            accessKey: "artifacts_admin",
            secretKey: "artifacts_pass",
          },
        },
      },
      teardown: "node scripts/smoke_cleanup.mjs",
    });
    expect(service?.fixtures?.storage?.local?.setup).toBeUndefined();
  });
});

describe("resolvePerformanceService", () => {
  it("preserves performance fixture config and resolves the perf test directory", () => {
    const service = resolvePerformanceService(makeDiscoveredRepo(), "ingest");
    expect(service).not.toBeNull();
    expect(service?.testDir).toBe("/work/sample-service/tests/den-perf");
    expect(service?.testMatch).toBe("ingest/test.js");
    expect(service?.fixtures?.storage?.local?.teardown).toBe(
      "node scripts/smoke_cleanup.mjs",
    );
  });
});

describe("resolveSmokeStorageFixture", () => {
  it("resolves literal local storage fixture values from the manifest", () => {
    const resolved = resolveSmokeStorageFixture(
      makeDiscoveredRepo().manifest,
      "api",
      "local",
    );
    expect(resolved).toEqual({
      fixtureKey: "api:storage:local",
      resolvedPayload: {
        endpoint: "http://localhost:9000",
        apiEndpoint: "http://host.docker.internal:9000",
        bucket: "artifacts-smoke",
        accessKey: "artifacts_admin",
        secretKey: "artifacts_pass",
        cleanupContext: {
          objectStores: {
            app: {
              endpoint: "http://minio:9000",
              bucket: "artifacts-local",
              accessKey: "artifacts_admin",
              secretKey: "artifacts_pass",
            },
          },
        },
      },
      envVars: {
        SMOKE_STORAGE_FIXTURE_JSON: JSON.stringify({
          endpoint: "http://localhost:9000",
          apiEndpoint: "http://host.docker.internal:9000",
          bucket: "artifacts-smoke",
          accessKey: "artifacts_admin",
          secretKey: "artifacts_pass",
        }),
        SMOKE_CLEANUP_CONTEXT_JSON: JSON.stringify({
          objectStores: {
            app: {
              endpoint: "http://minio:9000",
              bucket: "artifacts-local",
              accessKey: "artifacts_admin",
              secretKey: "artifacts_pass",
            },
          },
        }),
      },
      teardown: "node scripts/smoke_cleanup.mjs",
    });
    expect(resolved.setup).toBeUndefined();
  });

  it("merges teardownEnv into envVars for repo teardown commands", () => {
    const repo = makeDiscoveredRepo();
    repo.manifest.smoke!.api.fixtures!.storage!.local!.teardownEnv = {
      PG_HOST: "127.0.0.1",
      PG_PORT: 5433,
      PG_SSL_MODE: "disable",
    };
    const resolved = resolveSmokeStorageFixture(repo.manifest, "api", "local");
    expect(resolved.envVars.PG_HOST).toBe("127.0.0.1");
    expect(resolved.envVars.PG_PORT).toBe("5433");
    expect(resolved.envVars.PG_SSL_MODE).toBe("disable");
    expect(resolved.envVars.SMOKE_STORAGE_FIXTURE_JSON).toBeDefined();
  });

  it("passes adminProbePath through when set", () => {
    const repo = makeDiscoveredRepo();
    repo.manifest.smoke!.api.fixtures!.storage!.local!.adminProbePath =
      "/api/v1/admin/ingest-queue/status";
    const resolved = resolveSmokeStorageFixture(repo.manifest, "api", "local");
    expect(resolved.adminProbePath).toBe("/api/v1/admin/ingest-queue/status");
  });

  it("rejects adminProbePath that is a full URL (contains ://)", () => {
    const repo = makeDiscoveredRepo();
    repo.manifest.smoke!.api.fixtures!.storage!.local!.adminProbePath =
      "https://admin.internal/healthz";
    expect(() =>
      resolveSmokeStorageFixture(repo.manifest, "api", "local"),
    ).toThrow(/bare path/);
  });

  it("rejects adminProbePath without a leading slash", () => {
    const repo = makeDiscoveredRepo();
    repo.manifest.smoke!.api.fixtures!.storage!.local!.adminProbePath =
      "api/v1/admin/bad";
    expect(() =>
      resolveSmokeStorageFixture(repo.manifest, "api", "local"),
    ).toThrow(/bare path/);
  });

  it("fails loudly when a non-local fixture references missing env vars", () => {
    const repo = makeDiscoveredRepo();
    repo.manifest.smoke!.api.fixtures!.storage!.sandbox = {
      endpointFromEnv: "SMOKE_S3_ENDPOINT",
      apiEndpointFromEnv: "SMOKE_S3_API_ENDPOINT",
      bucketFromEnv: "SMOKE_S3_BUCKET",
      accessKeyFromEnv: "SMOKE_S3_ACCESS_KEY",
      secretKeyFromEnv: "SMOKE_S3_SECRET_KEY",
      cleanupContext: {
        objectStores: {
          app: {
            endpointFromEnv: "APP_S3_ENDPOINT",
            bucketFromEnv: "APP_S3_BUCKET",
            accessKeyFromEnv: "APP_S3_ACCESS_KEY",
            secretKeyFromEnv: "APP_S3_SECRET_KEY",
          },
        },
      },
    };

    expect(() =>
      resolveSmokeStorageFixture(repo.manifest, "api", "sandbox", {}),
    ).toThrow(/SMOKE_S3_ENDPOINT/);
  });

  it("resolves non-local fixture values from environment variables", () => {
    const repo = makeDiscoveredRepo();
    repo.manifest.smoke!.api.fixtures!.storage!.sandbox = {
      endpointFromEnv: "SMOKE_S3_ENDPOINT",
      apiEndpointFromEnv: "SMOKE_S3_API_ENDPOINT",
      bucketFromEnv: "SMOKE_S3_BUCKET",
      accessKeyFromEnv: "SMOKE_S3_ACCESS_KEY",
      secretKeyFromEnv: "SMOKE_S3_SECRET_KEY",
      cleanupContext: {
        objectStores: {
          app: {
            endpointFromEnv: "APP_S3_ENDPOINT",
            bucketFromEnv: "APP_S3_BUCKET",
            accessKeyFromEnv: "APP_S3_ACCESS_KEY",
            secretKeyFromEnv: "APP_S3_SECRET_KEY",
          },
        },
      },
    };

    expect(
      resolveSmokeStorageFixture(repo.manifest, "api", "sandbox", {
        SMOKE_S3_ENDPOINT: "https://storage.example.com",
        SMOKE_S3_API_ENDPOINT: "https://api-storage.example.com",
        SMOKE_S3_BUCKET: "artifacts-sandbox",
        SMOKE_S3_ACCESS_KEY: "sandbox-key",
        SMOKE_S3_SECRET_KEY: "sandbox-secret",
        APP_S3_ENDPOINT: "https://app-storage.example.com",
        APP_S3_BUCKET: "artifacts-app-sandbox",
        APP_S3_ACCESS_KEY: "app-key",
        APP_S3_SECRET_KEY: "app-secret",
      }),
    ).toEqual({
      fixtureKey: "api:storage:sandbox",
      resolvedPayload: {
        endpoint: "https://storage.example.com",
        apiEndpoint: "https://api-storage.example.com",
        bucket: "artifacts-sandbox",
        accessKey: "sandbox-key",
        secretKey: "sandbox-secret",
        cleanupContext: {
          objectStores: {
            app: {
              endpoint: "https://app-storage.example.com",
              bucket: "artifacts-app-sandbox",
              accessKey: "app-key",
              secretKey: "app-secret",
            },
          },
        },
      },
      envVars: {
        SMOKE_STORAGE_FIXTURE_JSON: JSON.stringify({
          endpoint: "https://storage.example.com",
          apiEndpoint: "https://api-storage.example.com",
          bucket: "artifacts-sandbox",
          accessKey: "sandbox-key",
          secretKey: "sandbox-secret",
        }),
        SMOKE_CLEANUP_CONTEXT_JSON: JSON.stringify({
          objectStores: {
            app: {
              endpoint: "https://app-storage.example.com",
              bucket: "artifacts-app-sandbox",
              accessKey: "app-key",
              secretKey: "app-secret",
            },
          },
        }),
      },
    });
  });
});

describe("resolveSmokeCleanupFixture", () => {
  it("returns null when the service declares no cleanup fixture for the env", () => {
    const repo = makeDiscoveredRepo();
    expect(
      resolveSmokeCleanupFixture(repo.manifest, "api", "local"),
    ).toBeNull();
  });

  it("resolves teardown lifecycle + teardownEnv into envVars", () => {
    const repo = makeDiscoveredRepo();
    repo.manifest.smoke!.api.fixtures!.cleanup = {
      local: {
        teardown: "node tests/shared/test_cleanup.mjs",
        teardownEnv: { ENVIRONMENT: "local", SWEEP_PAGES: 5 },
        adminProbePath: "/healthz",
        adminProbe403Hint: "enable the thing",
      },
    };
    expect(resolveSmokeCleanupFixture(repo.manifest, "api", "local")).toEqual({
      fixtureKey: "api:cleanup:local",
      resolvedPayload: {
        environment: "local",
        teardownEnv: { ENVIRONMENT: "local", SWEEP_PAGES: "5" },
      },
      envVars: { ENVIRONMENT: "local", SWEEP_PAGES: "5" },
      teardown: "node tests/shared/test_cleanup.mjs",
      adminProbePath: "/healthz",
      adminProbe403Hint: "enable the thing",
    });
  });

  it("fails loudly when the cleanup fixture has no teardown command", () => {
    const repo = makeDiscoveredRepo();
    repo.manifest.smoke!.api.fixtures!.cleanup = {
      local: {} as never,
    };
    expect(() =>
      resolveSmokeCleanupFixture(repo.manifest, "api", "local"),
    ).toThrow(/must define a teardown command/);
  });

  it("rejects a cleanup adminProbePath that is a full URL", () => {
    const repo = makeDiscoveredRepo();
    repo.manifest.smoke!.api.fixtures!.cleanup = {
      local: {
        teardown: "node tests/shared/test_cleanup.mjs",
        adminProbePath: "https://admin.internal/healthz",
      },
    };
    expect(() =>
      resolveSmokeCleanupFixture(repo.manifest, "api", "local"),
    ).toThrow(/bare path/);
  });

  it("throws for an unknown smoke service", () => {
    const repo = makeDiscoveredRepo();
    expect(() =>
      resolveSmokeCleanupFixture(repo.manifest, "nope", "local"),
    ).toThrow(/not found in manifest/);
  });
});

describe("smokeStorageFixtureHashInput", () => {
  it("is stable for fixtureKey + resolvedPayload", () => {
    const payload = {
      endpoint: "http://localhost:9000",
      apiEndpoint: "http://host.docker.internal:9000",
      bucket: "artifacts-smoke",
      accessKey: "artifacts_admin",
      secretKey: "artifacts_pass",
    };
    expect(smokeStorageFixtureHashInput("api:storage:local", payload)).toBe(
      '{"fixtureKey":"api:storage:local","resolvedPayload":{"accessKey":"artifacts_admin","apiEndpoint":"http://host.docker.internal:9000","bucket":"artifacts-smoke","endpoint":"http://localhost:9000","secretKey":"artifacts_pass"}}',
    );
  });
});

describe("resolvePerformanceStorageFixture", () => {
  it("resolves literal local performance fixture values from the manifest", () => {
    const resolved = resolvePerformanceStorageFixture(
      makeDiscoveredRepo().manifest,
      "ingest",
      "local",
    );
    expect(resolved).toEqual({
      fixtureKey: "sample-service:perf:ingest:storage:local",
      resolvedPayload: {
        endpoint: "http://localhost:9000",
        apiEndpoint: "http://host.docker.internal:9000",
        bucket: "artifacts-smoke",
        accessKey: "artifacts_admin",
        secretKey: "artifacts_pass",
        cleanupContext: {
          objectStores: {
            app: {
              endpoint: "http://minio:9000",
              bucket: "artifacts-local",
              accessKey: "artifacts_admin",
              secretKey: "artifacts_pass",
            },
          },
        },
      },
      envVars: {
        SMOKE_STORAGE_FIXTURE_JSON: JSON.stringify({
          endpoint: "http://localhost:9000",
          apiEndpoint: "http://host.docker.internal:9000",
          bucket: "artifacts-smoke",
          accessKey: "artifacts_admin",
          secretKey: "artifacts_pass",
        }),
        SMOKE_CLEANUP_CONTEXT_JSON: JSON.stringify({
          objectStores: {
            app: {
              endpoint: "http://minio:9000",
              bucket: "artifacts-local",
              accessKey: "artifacts_admin",
              secretKey: "artifacts_pass",
            },
          },
        }),
      },
      teardown: "node scripts/smoke_cleanup.mjs",
    });
  });
});

describe("buildSmokeFixtureEnv", () => {
  it("serializes the resolved storage fixture into one env var", () => {
    expect(
      buildSmokeFixtureEnv(makeDiscoveredRepo().manifest, "api", "local"),
    ).toEqual({
      SMOKE_STORAGE_FIXTURE_JSON: JSON.stringify({
        endpoint: "http://localhost:9000",
        apiEndpoint: "http://host.docker.internal:9000",
        bucket: "artifacts-smoke",
        accessKey: "artifacts_admin",
        secretKey: "artifacts_pass",
      }),
      SMOKE_CLEANUP_CONTEXT_JSON: JSON.stringify({
        objectStores: {
          app: {
            endpoint: "http://minio:9000",
            bucket: "artifacts-local",
            accessKey: "artifacts_admin",
            secretKey: "artifacts_pass",
          },
        },
      }),
    });
  });
});

describe("buildPerformanceFixtureEnv", () => {
  it("serializes the resolved performance storage fixture env", () => {
    expect(
      buildPerformanceFixtureEnv(
        makeDiscoveredRepo().manifest,
        "ingest",
        "local",
      ),
    ).toEqual({
      SMOKE_STORAGE_FIXTURE_JSON: JSON.stringify({
        endpoint: "http://localhost:9000",
        apiEndpoint: "http://host.docker.internal:9000",
        bucket: "artifacts-smoke",
        accessKey: "artifacts_admin",
        secretKey: "artifacts_pass",
      }),
      SMOKE_CLEANUP_CONTEXT_JSON: JSON.stringify({
        objectStores: {
          app: {
            endpoint: "http://minio:9000",
            bucket: "artifacts-local",
            accessKey: "artifacts_admin",
            secretKey: "artifacts_pass",
          },
        },
      }),
    });
  });
});

// ── discoverRepos ─────────────────────────────────────────────────────────────

jest.mock("../../../src/shared/den-config.js", () => ({
  isLocalEnabled: jest.fn(),
  readDenConfig: jest.fn(() => ({ environments: ["local"] })),
  readUserConfig: jest.fn(() => ({})),
  getReposRoot: jest.fn(() => "/repos"),
}));

jest.mock("../../../src/shared/environment-manager/workspaces.js", () => ({
  getActiveWorkspace: jest.fn(),
  listWorkspaceServices: jest.fn(),
  DEN_WORKSPACES_DIR: "/workspaces",
  DEN_SERVICES_DIR: "/services",
  readWorkspacesFile: jest.fn(() => ({
    active: ["default"],
    focus: "default",
    workspaces: {},
  })),
  readManifestAnyBranch: jest.fn(),
}));

jest.mock("../../../src/shared/environment-manager/catalog.js", () => ({
  readCatalog: jest.fn(() => ({})),
}));

jest.mock("../../../src/shared/manifest/read-manifest.js", () => ({
  readManifest: jest.fn(),
  readManifestAsync: jest.fn(),
}));

jest.mock("fs");

/* eslint-disable @typescript-eslint/no-var-requires */
const { isLocalEnabled } = require("../../../src/shared/den-config.js") as {
  isLocalEnabled: jest.Mock;
};
const { getActiveWorkspace, listWorkspaceServices } =
  require("../../../src/shared/environment-manager/workspaces.js") as {
    getActiveWorkspace: jest.Mock;
    listWorkspaceServices: jest.Mock;
  };
const { readCatalog } =
  require("../../../src/shared/environment-manager/catalog.js") as {
    readCatalog: jest.Mock;
  };
const { readManifest } =
  require("../../../src/shared/manifest/read-manifest.js") as {
    readManifest: jest.Mock;
  };
const mockFs = require("fs") as jest.Mocked<typeof import("fs")>;
/* eslint-enable @typescript-eslint/no-var-requires */

describe("discoverRepos", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockFs.realpathSync.mockImplementation((p) => String(p));
  });

  it("uses workspace services when local dev is enabled", () => {
    isLocalEnabled.mockReturnValue(true);
    getActiveWorkspace.mockReturnValue({
      name: "default",
      config: {
        services: {
          app: { mode: "dev-managed", path: "/repos/app" },
        },
      },
    });
    readCatalog.mockReturnValue({ app: { gh: "org/app" } });
    listWorkspaceServices.mockReturnValue([
      {
        address: "app/api",
        repoName: "app",
        subsystem: "api",
        repoPath: "/repos/app",
        branch: null,
        mode: "dev-managed",
      },
    ]);
    readManifest.mockReturnValue({ name: "app", services: {} });

    const repos = discoverRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].repoName).toBe("app");
    expect(repos[0].repoPath).toBe("/repos/app");
  });

  it("falls back to registry when local dev is disabled", () => {
    isLocalEnabled.mockReturnValue(false);
    mockFs.existsSync.mockReturnValue(false);

    const repos = discoverRepos();
    expect(repos).toHaveLength(0);
    expect(getActiveWorkspace).not.toHaveBeenCalled();
  });

  it("falls back to registry when local dev is enabled but no workspace exists", () => {
    isLocalEnabled.mockReturnValue(true);
    getActiveWorkspace.mockReturnValue(null);
    mockFs.existsSync.mockReturnValue(false);

    const repos = discoverRepos();
    expect(repos).toHaveLength(0);
  });

  it("deduplicates repos by repoName from workspace services", () => {
    isLocalEnabled.mockReturnValue(true);
    getActiveWorkspace.mockReturnValue({
      name: "default",
      config: { services: {} },
    });
    readCatalog.mockReturnValue({});
    listWorkspaceServices.mockReturnValue([
      {
        address: "app/api",
        repoName: "app",
        subsystem: "api",
        repoPath: "/repos/app",
        branch: null,
        mode: "dev-managed",
      },
      {
        address: "app/worker",
        repoName: "app",
        subsystem: "worker",
        repoPath: "/repos/app",
        branch: null,
        mode: "dev-managed",
      },
    ]);
    readManifest.mockReturnValue({ name: "app", services: {} });

    const repos = discoverRepos();
    expect(repos).toHaveLength(1);
  });
});
