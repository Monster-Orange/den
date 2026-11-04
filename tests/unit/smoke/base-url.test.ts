import { describe, expect, it } from "@jest/globals";
import {
  resolveManifestSmokeBaseUrl,
  resolveSmokeBaseUrl,
  resolveSmokeBaseUrlForService,
} from "../../../src/pillars/smoke/base-url.js";
import type { RawManifest } from "../../../src/shared/types/index.js";

const artifactsManifest: RawManifest = {
  name: "files-api",
  smoke: {
    api: {
      testDir: "tests/den-smoke",
      testMatch: "**/*.smoke.ts",
      baseUrlKey: "api",
      auth: [],
    },
  },
  services: {
    "files-api": {
      health: {
        local: { url: "http://localhost:8080/healthz" },
        staging: {
          url: "https://files-api.internal.staging.example.dev/healthz",
        },
      },
    },
  },
};

const appManifest: RawManifest = {
  name: "app",
  smoke: {
    api: {
      testDir: "apps/backend/tests/smoke",
      testMatch: "**/*.smoke.ts",
      baseUrlKey: "api",
      auth: ["admin"],
    },
    web: {
      testDir: "apps/web/tests/smoke",
      testMatch: "**/*.smoke.ts",
      baseUrlKey: "web",
      auth: ["user"],
    },
  },
  services: {
    api: {
      health: {
        local: { url: "http://api:8000/healthz" },
        staging: { url: "https://api.staging.example.dev/healthz" },
      },
    },
    web: {
      health: {
        local: { url: "http://web:3000" },
        staging: { url: "https://app.staging.example.dev" },
      },
    },
  },
};

describe("resolveSmokeBaseUrl", () => {
  it("uses the manifest URL for non-api services when present", () => {
    expect(
      resolveSmokeBaseUrl({
        baseUrlKey: "web",
        configuredUrl: "http://web:3000",
        manifestUrl: "https://app.staging.example.dev",
      }),
    ).toBe("https://app.staging.example.dev");
  });

  it("prefers an explicit override when provided", () => {
    expect(
      resolveSmokeBaseUrl({
        baseUrlKey: "api",
        configuredUrl: "http://api:8000",
        manifestUrl: "http://localhost:8080",
        overrideUrl: "http://localhost:9090",
      }),
    ).toBe("http://localhost:9090");
  });

  it("prefers the manifest URL over the configured env URL for api services", () => {
    expect(
      resolveSmokeBaseUrl({
        baseUrlKey: "api",
        configuredUrl: "http://api:8000",
        manifestUrl: "http://localhost:8080",
      }),
    ).toBe("http://localhost:8080");
  });

  it("falls back to the configured URL when the manifest does not provide one", () => {
    expect(
      resolveSmokeBaseUrl({
        baseUrlKey: "api",
        configuredUrl: "http://api:8000",
      }),
    ).toBe("http://api:8000");
  });
});

describe("resolveManifestSmokeBaseUrl", () => {
  it("uses the smoke service key when the manifest has a matching service entry", () => {
    expect(
      resolveManifestSmokeBaseUrl({
        manifest: appManifest,
        repoName: "app",
        serviceName: "api",
        environment: "staging",
        baseUrlKey: "api",
      }),
    ).toBe("https://api.staging.example.dev");
  });

  it("falls back to the repo service entry for single-service repos", () => {
    expect(
      resolveManifestSmokeBaseUrl({
        manifest: artifactsManifest,
        repoName: "files-api",
        serviceName: "api",
        environment: "local",
        baseUrlKey: "api",
      }),
    ).toBe("http://localhost:8080");
  });

  it("returns web URLs unchanged", () => {
    expect(
      resolveManifestSmokeBaseUrl({
        manifest: appManifest,
        repoName: "app",
        serviceName: "web",
        environment: "staging",
        baseUrlKey: "web",
      }),
    ).toBe("https://app.staging.example.dev");
  });
});

describe("resolveSmokeBaseUrlForService", () => {
  it("matches manifest-first resolution for an api smoke service", () => {
    expect(
      resolveSmokeBaseUrlForService(
        artifactsManifest,
        "files-api",
        "api",
        artifactsManifest.smoke!.api,
        "local",
        { baseUrls: { api: "http://ignored:9999", web: "http://web:3000" } },
      ),
    ).toBe("http://localhost:8080");
  });
});
