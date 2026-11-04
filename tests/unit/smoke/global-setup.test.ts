import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

jest.mock("../../../src/shared/environment/env-selector.js", () => ({
  envSelector: {
    loadEnvironment: jest.fn(),
  },
}));

jest.mock("../../../src/shared/auth/api-token.js", () => ({
  getApiToken: jest.fn(),
}));

jest.mock("../../../src/pillars/smoke/discover.js", () => ({
  discoverRepos: jest.fn(),
  findManifest: jest.fn(),
  resolveRepoPath: jest.fn(),
  resolveService: jest.fn(),
}));

jest.mock("../../../src/pillars/smoke/base-url.js", () => ({
  resolveSmokeBaseUrlForService: jest.fn(),
}));

jest.mock("../../../src/pillars/smoke/fixtures.js", () => ({
  resolveSmokeStorageFixture: jest.fn(),
  resolveSmokeCleanupFixture: jest.fn(),
}));

jest.mock("../../../src/pillars/smoke/cleanup.js", () => ({
  acquireFixture: jest.fn(),
  fixtureInstanceId: jest.fn(),
}));

jest.mock("../../../src/pillars/smoke/global-teardown.js", () => ({
  registerSmokeFixtureReleaseHandles: jest.fn(),
  smokeFixtureConsumerKey: jest.fn(),
  writeSmokeFixtureHandoff: jest.fn(),
}));

import { envSelector } from "../../../src/shared/environment/env-selector.js";
import { getApiToken } from "../../../src/shared/auth/api-token.js";
import {
  discoverRepos,
  findManifest,
  resolveRepoPath,
  resolveService,
} from "../../../src/pillars/smoke/discover.js";
import { resolveSmokeBaseUrlForService } from "../../../src/pillars/smoke/base-url.js";
import { resolveSmokeStorageFixture } from "../../../src/pillars/smoke/fixtures.js";
import {
  acquireFixture,
  fixtureInstanceId,
} from "../../../src/pillars/smoke/cleanup.js";
import {
  registerSmokeFixtureReleaseHandles,
  smokeFixtureConsumerKey,
  writeSmokeFixtureHandoff,
} from "../../../src/pillars/smoke/global-teardown.js";
import globalSetup from "../../../src/pillars/smoke/global-setup.js";
import globalSetupAll from "../../../src/pillars/smoke/global-setup-all.js";
import globalSetupGlobal from "../../../src/pillars/smoke/global-setup-global.js";

const mockedLoadEnvironment = envSelector.loadEnvironment as jest.Mock;
const mockedGetApiToken = getApiToken as jest.Mock;
const mockedDiscoverRepos = discoverRepos as jest.Mock;
const mockedFindManifest = findManifest as jest.Mock;
const mockedResolveRepoPath = resolveRepoPath as jest.Mock;
const mockedResolveService = resolveService as jest.Mock;
const mockedResolveSmokeBaseUrlForService =
  resolveSmokeBaseUrlForService as jest.Mock;
const mockedResolveSmokeStorageFixture =
  resolveSmokeStorageFixture as jest.Mock;
const mockedAcquireFixture = acquireFixture as jest.Mock;
const mockedFixtureInstanceId = fixtureInstanceId as jest.Mock;
const mockedRegisterSmokeFixtureReleaseHandles =
  registerSmokeFixtureReleaseHandles as jest.Mock;
const mockedSmokeFixtureConsumerKey = smokeFixtureConsumerKey as jest.Mock;
const mockedWriteSmokeFixtureHandoff = writeSmokeFixtureHandoff as jest.Mock;

const originalEnv = process.env;
const fetchMock = jest.fn();

function makeLifecycle() {
  return {
    fixtureKey: "api:storage:local",
    resolvedPayload: { bucket: "artifacts-smoke" },
    envVars: {
      SMOKE_STORAGE_FIXTURE_JSON: JSON.stringify({
        endpoint: "http://localhost:9000",
        apiEndpoint: "http://host.docker.internal:9000",
        bucket: "artifacts-smoke",
        accessKey: "artifacts_admin",
        secretKey: "artifacts_pass",
      }),
    },
    teardown: "node scripts/smoke_cleanup.mjs",
  };
}

function makeService() {
  return {
    baseUrlKey: "api",
    auth: [],
    fixtures: {
      storage: {
        local: {
          endpoint: "http://localhost:9000",
        },
      },
    },
  };
}

describe("smoke global setup worker-count propagation", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...originalEnv,
      E2E_ENVIRONMENT: "local",
      SMOKE_REPO: "files-api",
      SMOKE_SERVICE: "api",
      USE_LOCAL_CHECKOUT: "1",
    };

    global.fetch = fetchMock as typeof fetch;
    fetchMock.mockResolvedValue({ status: 200 } as Response);

    mockedLoadEnvironment.mockResolvedValue({
      baseUrls: {
        api: "http://localhost:8080",
        web: "http://localhost:3000",
      },
    });
    mockedGetApiToken.mockResolvedValue("token");
    mockedResolveSmokeBaseUrlForService.mockReturnValue(
      "http://localhost:8080",
    );
    mockedResolveRepoPath.mockReturnValue("/repos/files-api");
    mockedResolveSmokeStorageFixture.mockReturnValue(makeLifecycle());
    mockedAcquireFixture.mockResolvedValue(jest.fn());
    mockedFixtureInstanceId.mockReturnValue("fixture-instance-id");
    mockedSmokeFixtureConsumerKey.mockImplementation(
      (repoName: string, serviceName: string) => `${repoName}__${serviceName}`,
    );
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("single-service setup passes SMOKE_WORKER_COUNT into fixture env", async () => {
    mockedFindManifest.mockReturnValue({
      manifest: { smoke: { api: makeService() } },
      repoName: "files-api",
    });
    mockedResolveService.mockReturnValue(makeService());

    await globalSetup({ workers: 8 } as never);

    expect(mockedAcquireFixture).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          BASE_API_URL: "http://localhost:8080",
          SMOKE_BASE_URL: "http://localhost:8080",
          SMOKE_WORKER_COUNT: "8",
        }),
      }),
    );
    expect(mockedRegisterSmokeFixtureReleaseHandles).toHaveBeenCalled();
    expect(mockedWriteSmokeFixtureHandoff).toHaveBeenCalled();
  });

  it("all-services setup passes SMOKE_WORKER_COUNT into fixture env", async () => {
    mockedFindManifest.mockReturnValue({
      manifest: { smoke: { api: makeService() } },
      repoName: "files-api",
    });

    await globalSetupAll({ workers: 6 } as never);

    expect(mockedAcquireFixture).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          BASE_API_URL: "http://localhost:8080",
          SMOKE_BASE_URL: "http://localhost:8080",
          SMOKE_WORKER_COUNT: "6",
        }),
      }),
    );
  });

  it("global setup passes SMOKE_WORKER_COUNT into fixture env", async () => {
    mockedDiscoverRepos.mockReturnValue([
      {
        repoName: "files-api",
        manifest: { smoke: { api: makeService() } },
      },
    ]);

    await globalSetupGlobal({ workers: 4 } as never);

    expect(mockedAcquireFixture).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          BASE_API_URL: "http://localhost:8080",
          SMOKE_BASE_URL: "http://localhost:8080",
          SMOKE_WORKER_COUNT: "4",
        }),
      }),
    );
  });
});
