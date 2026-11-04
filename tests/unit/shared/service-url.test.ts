import { describe, expect, it } from "@jest/globals";
import {
  resolveManifestBaseUrl,
  resolveServiceBaseUrl,
} from "../../../src/shared/service-url.js";
import type { RawManifest } from "../../../src/shared/types/index.js";

const artifactsManifest: RawManifest = {
  name: "files-api",
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

const multiServiceManifest: RawManifest = {
  name: "shop",
  services: {
    api: {
      health: {
        local: { url: "http://shop-api:8000/healthz" },
        staging: { url: "https://api.staging.example.dev/healthz" },
      },
    },
    web: {
      health: {
        local: { url: "http://shop-web:3000" },
        staging: { url: "https://app.staging.example.dev" },
      },
    },
  },
};

const shellHealthManifest: RawManifest = {
  name: "db-service",
  services: {
    "db-service": {
      health: {
        local: { type: "shell", cmd: "pg_isready" },
      },
    },
  },
};

/**
 * A repo whose pillar modules are named for what they test rather than for the
 * service they hit — the shape that previously resolved to null on every module.
 */
const tieredSmokeManifest: RawManifest = {
  name: "tasks-api",
  entrypoint: "api",
  services: {
    api: {
      health: {
        local: { url: "http://localhost:8080/healthz" },
        dev: { url: "https://tasks-api.internal.dev.example.dev/healthz" },
      },
    },
  },
};

const danglingEntrypointManifest: RawManifest = {
  name: "broken",
  entrypoint: "nonexistent",
  services: {
    api: { health: { local: { url: "http://localhost:8080/healthz" } } },
  },
};

describe("resolveManifestBaseUrl", () => {
  it("strips /healthz from API health URLs", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: artifactsManifest,
        repoName: "files-api",
        serviceName: "api",
        environment: "local",
        baseUrlKey: "api",
      }),
    ).toBe("http://localhost:8080");
  });

  it("falls back to repoName when serviceName has no match", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: artifactsManifest,
        repoName: "files-api",
        serviceName: "api",
        environment: "staging",
        baseUrlKey: "api",
      }),
    ).toBe("https://files-api.internal.staging.example.dev");
  });

  it("resolves by serviceName when it matches a services key", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: multiServiceManifest,
        repoName: "shop",
        serviceName: "api",
        environment: "staging",
        baseUrlKey: "api",
      }),
    ).toBe("https://api.staging.example.dev");
  });

  it("returns web URLs unchanged (no path stripping)", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: multiServiceManifest,
        repoName: "shop",
        serviceName: "web",
        environment: "staging",
        baseUrlKey: "web",
      }),
    ).toBe("https://app.staging.example.dev");
  });

  it("returns null for shell-type health checks", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: shellHealthManifest,
        repoName: "db-service",
        serviceName: "db-service",
        environment: "local",
        baseUrlKey: "api",
      }),
    ).toBeNull();
  });

  it("returns null when the environment has no health entry", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: artifactsManifest,
        repoName: "files-api",
        serviceName: "api",
        environment: "production",
        baseUrlKey: "api",
      }),
    ).toBeNull();
  });

  it("falls back to the entrypoint when neither serviceName nor repoName matches", () => {
    // `tier1` is a smoke module, not a service; the repo is `tasks-api` but the
    // service is keyed `api`. Both prior lookups miss.
    expect(
      resolveManifestBaseUrl({
        manifest: tieredSmokeManifest,
        repoName: "tasks-api",
        serviceName: "tier1",
        environment: "dev",
        baseUrlKey: "api",
      }),
    ).toBe("https://tasks-api.internal.dev.example.dev");
  });

  it("resolves every module of a tiered repo rather than only a service-named one", () => {
    for (const moduleName of [
      "tier1",
      "tier2",
      "tier3",
      "local-only",
      "readiness",
    ]) {
      expect(
        resolveManifestBaseUrl({
          manifest: tieredSmokeManifest,
          repoName: "tasks-api",
          serviceName: moduleName,
          environment: "local",
          baseUrlKey: "api",
        }),
      ).toBe("http://localhost:8080");
    }
  });

  it("prefers an exact serviceName match over the entrypoint", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: { ...multiServiceManifest, entrypoint: "api" },
        repoName: "shop",
        serviceName: "web",
        environment: "staging",
        baseUrlKey: "web",
      }),
    ).toBe("https://app.staging.example.dev");
  });

  it("returns null when the entrypoint names no existing service", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: danglingEntrypointManifest,
        repoName: "broken",
        serviceName: "tier1",
        environment: "local",
        baseUrlKey: "api",
      }),
    ).toBeNull();
  });

  it("returns null when nothing matches and no entrypoint is declared", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: multiServiceManifest,
        repoName: "shop",
        serviceName: "tier1",
        environment: "staging",
        baseUrlKey: "api",
      }),
    ).toBeNull();
  });

  it("returns null when the manifest has no services section", () => {
    expect(
      resolveManifestBaseUrl({
        manifest: { name: "bare" },
        repoName: "bare",
        serviceName: "api",
        environment: "local",
        baseUrlKey: "api",
      }),
    ).toBeNull();
  });
});

describe("resolveServiceBaseUrl", () => {
  it("prefers explicit override over manifest and configured URLs", () => {
    expect(
      resolveServiceBaseUrl({
        baseUrlKey: "api",
        configuredUrl: "http://shop-api:8000",
        manifestUrl: "http://localhost:8080",
        overrideUrl: "http://localhost:9090",
      }),
    ).toBe("http://localhost:9090");
  });

  it("prefers manifest URL over configured URL when no override", () => {
    expect(
      resolveServiceBaseUrl({
        baseUrlKey: "api",
        configuredUrl: "http://shop-api:8000",
        manifestUrl: "http://localhost:8080",
      }),
    ).toBe("http://localhost:8080");
  });

  it("falls back to configured URL when manifest is absent", () => {
    expect(
      resolveServiceBaseUrl({
        baseUrlKey: "api",
        configuredUrl: "http://shop-api:8000",
      }),
    ).toBe("http://shop-api:8000");
  });

  it("ignores override for web services", () => {
    expect(
      resolveServiceBaseUrl({
        baseUrlKey: "web",
        configuredUrl: "http://shop-web:3000",
        manifestUrl: "https://app.staging.example.dev",
        overrideUrl: "http://should-be-ignored:9090",
      }),
    ).toBe("https://app.staging.example.dev");
  });

  it("uses manifest URL for web services", () => {
    expect(
      resolveServiceBaseUrl({
        baseUrlKey: "web",
        configuredUrl: "http://shop-web:3000",
        manifestUrl: "https://app.staging.example.dev",
      }),
    ).toBe("https://app.staging.example.dev");
  });
});
