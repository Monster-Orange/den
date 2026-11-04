import { describe, expect, it } from "@jest/globals";
import {
  httpUrl,
  linksFor,
  openUrlFor,
  rehost,
} from "../../src/shared/open-url.js";
import type { RawManifest } from "../../src/shared/types/index.js";

const webapp: RawManifest = {
  name: "sample-webapp",
  entrypoint: "webapp",
  compose: {
    name: "webapp",
    routes: { app: "frontend:80", api: "backend:3001" },
  },
  services: { webapp: {}, frontend: {}, backend: {}, postgres: {} },
} as unknown as RawManifest;

const at = (subsystem: string, extra: Record<string, unknown> = {}) =>
  openUrlFor({
    manifest: webapp,
    subsystem,
    repoName: "sample-webapp",
    env: "local",
    edgeDomain: "globex.localhost",
    ...extra,
  });

describe("openUrlFor", () => {
  it("maps a compose container to its edge route", () => {
    expect(at("frontend")).toBe("https://app.webapp.globex.localhost/");
    expect(at("backend")).toBe("https://api.webapp.globex.localhost/");
  });

  it("gives the stack-wide entrypoint the app route", () => {
    expect(at("webapp")).toBe("https://app.webapp.globex.localhost/");
  });

  it("gives an unrouted container nothing", () => {
    expect(at("postgres")).toBeNull();
  });

  it("uses edge routes only locally", () => {
    expect(at("frontend", { env: "dev" })).toBeNull();
  });

  it("prefers a declared url over the edge route", () => {
    const m = {
      ...webapp,
      services: { frontend: { urls: { local: "https://custom.test/x" } } },
    } as unknown as RawManifest;
    expect(at("frontend", { manifest: m })).toBe("https://custom.test/x");
  });

  it("falls back to the origin of an HTTP health URL, never its path", () => {
    expect(
      at("postgres", { env: "dev", healthUrl: "https://api.dev.test/readyz" }),
    ).toBe("https://api.dev.test/");
  });

  it("ignores non-http URLs", () => {
    const m = {
      ...webapp,
      services: { frontend: { urls: { dev: "javascript:alert(1)" } } },
    } as unknown as RawManifest;
    expect(at("frontend", { manifest: m, env: "dev" })).toBeNull();
    expect(httpUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("linksFor", () => {
  it("keeps links that have an http(s) URL for the env", () => {
    const m = {
      name: "x",
      services: {
        api: {
          links: [
            { label: "Docs", urls: { local: "https://api.test/docs" } },
            { label: "Prod only", urls: { prod: "https://p.test" } },
            { label: "Bad", urls: { local: "ftp://x" } },
          ],
        },
      },
    } as unknown as RawManifest;
    expect(linksFor(m, "api", "local")).toEqual([
      { label: "Docs", url: "https://api.test/docs" },
    ]);
  });
});

describe("rehost", () => {
  const primary = "globex.localhost";
  const aliases = ["globex.internal"];
  const url = "https://app.webapp.globex.localhost/";

  it("swaps to the alias the viewer is on", () => {
    expect(rehost(url, primary, "den.globex.internal", aliases)).toBe(
      "https://app.webapp.globex.internal/",
    );
  });

  it("leaves links alone for a viewer on the primary or a bare port", () => {
    expect(rehost(url, primary, "den.globex.localhost", aliases)).toBe(url);
    expect(rehost(url, primary, "127.0.0.1:7791", aliases)).toBe(url);
  });

  it("doesn't touch URLs off the edge", () => {
    expect(
      rehost("https://api.dev.test/", primary, "den.globex.internal", aliases),
    ).toBe("https://api.dev.test/");
  });
});
