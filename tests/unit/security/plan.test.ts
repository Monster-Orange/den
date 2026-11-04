/**
 * Pure policy + command-building tests for the security pillar's plan.ts.
 * No docker, no network: everything asserts on returned data.
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  AUTH_HEADER_ENV,
  EXTRA_HOSTS_ENV,
  MODE_CEILING,
  allowedModes,
  buildZapPlan,
  isOwnedHost,
  ownedHostSuffixes,
  resolveOpenapi,
  resolveTargets,
  scanFailed,
  summarizeZapReport,
  type SecurityEnvConfigLike,
} from "../../../src/pillars/security/plan.js";
import { DEFAULT_SECURITY_OWNED_HOSTS } from "../../../src/shared/den-config.js";

const OWNED = ["globex.localhost", "globex.internal"];

const envConfig: SecurityEnvConfigLike = {
  baseUrls: {
    web: "https://app.staging.globex.internal/",
    api: "https://api.staging.globex.internal",
    services: {},
  },
};

describe("allowedModes", () => {
  it("defaults: dev/sandbox/staging all, production baseline", () => {
    for (const env of ["dev", "sandbox", "staging"] as const) {
      expect(allowedModes({ baseUrlKey: "api" }, env)).toEqual([
        "baseline",
        "api",
        "full",
      ]);
    }
    expect(allowedModes({ baseUrlKey: "api" }, "production")).toEqual([
      "baseline",
    ]);
  });

  it("a manifest can narrow an env's modes", () => {
    expect(
      allowedModes({ baseUrlKey: "api", modes: { dev: ["baseline"] } }, "dev"),
    ).toEqual(["baseline"]);
  });

  it("a manifest can NOT widen past the ceiling (production full -> dropped)", () => {
    expect(
      allowedModes(
        { baseUrlKey: "api", modes: { production: ["baseline", "full"] } },
        "production",
      ),
    ).toEqual(["baseline"]);
    expect(
      allowedModes(
        { baseUrlKey: "api", modes: { staging: ["full"] } },
        "staging",
      ),
    ).toEqual(["full"]);
  });

  it("local allows the full set (scanned on the engineer's own machine)", () => {
    expect(MODE_CEILING.local).toEqual(["baseline", "api", "full"]);
    expect(allowedModes({ baseUrlKey: "api" }, "local")).toEqual([
      "baseline",
      "api",
      "full",
    ]);
  });
});

describe("resolveTargets", () => {
  it("resolves baseUrlKey api/web from the env config, normalizing slashes", () => {
    expect(
      resolveTargets({ baseUrlKey: "web" }, "staging", envConfig, OWNED),
    ).toEqual(["https://app.staging.globex.internal"]);
    expect(
      resolveTargets({ baseUrlKey: "api" }, "staging", envConfig, OWNED),
    ).toEqual(["https://api.staging.globex.internal"]);
  });

  it("explicit hosts win over baseUrlKey, de-duplicated", () => {
    expect(
      resolveTargets(
        {
          baseUrlKey: "api",
          hosts: {
            staging: [
              "https://a.staging.globex.internal/",
              "https://a.staging.globex.internal",
            ],
          },
        },
        "staging",
        envConfig,
        OWNED,
      ),
    ).toEqual(["https://a.staging.globex.internal"]);
  });

  it("falls back to baseUrlKey when hosts has no entry for the env", () => {
    expect(
      resolveTargets(
        {
          baseUrlKey: "api",
          hosts: { dev: ["https://x.dev.globex.internal"] },
        },
        "staging",
        envConfig,
        OWNED,
      ),
    ).toEqual(["https://api.staging.globex.internal"]);
  });

  it("an entry with neither a host for the env nor a baseUrlKey fails loudly", () => {
    expect(() =>
      resolveTargets(
        { hosts: { dev: ["https://x.dev.globex.internal"] } },
        "staging",
        envConfig,
        OWNED,
      ),
    ).toThrow(/No security target resolvable/);
  });

  it("refuses a host we do not own, pointing at config/den.yml", () => {
    expect(() =>
      resolveTargets(
        { hosts: { dev: ["https://example.com"] } },
        "dev",
        envConfig,
        OWNED,
      ),
    ).toThrow(
      /not an owned host \(add it to security\.owned_hosts in config\/den\.yml\)/,
    );
    expect(() =>
      resolveTargets(
        {
          hosts: { dev: ["https://evil-globex.localhost.attacker.io"] },
        },
        "dev",
        envConfig,
        OWNED,
      ),
    ).toThrow(/not an owned host/);
  });

  it("enforces the allowlist in local too (no local relaxation)", () => {
    expect(() =>
      resolveTargets(
        { hosts: { local: ["https://example.com"] } },
        "local",
        envConfig,
        OWNED,
      ),
    ).toThrow(/not an owned host/);
    expect(() =>
      resolveTargets(
        { baseUrlKey: "api" },
        "local",
        {
          baseUrls: {
            web: "http://localhost:3000",
            api: "http://localhost:3001",
          },
        },
        OWNED,
      ),
    ).toThrow(/not an owned host/);
  });

  it("an empty allowlist refuses everything", () => {
    expect(() =>
      resolveTargets(
        { hosts: { local: ["https://app.webapp.globex.localhost"] } },
        "local",
        envConfig,
        [],
      ),
    ).toThrow(/not an owned host.*\(none\)/);
  });

  it("requires https outside dev/sandbox/local", () => {
    expect(() =>
      resolveTargets(
        { hosts: { staging: ["http://a.staging.globex.internal"] } },
        "staging",
        envConfig,
        OWNED,
      ),
    ).toThrow(/must be https/);
    expect(
      resolveTargets(
        { hosts: { dev: ["http://a.dev.globex.internal"] } },
        "dev",
        envConfig,
        OWNED,
      ),
    ).toEqual(["http://a.dev.globex.internal"]);
  });

  it("local accepts the local edge URLs (http or https)", () => {
    expect(
      resolveTargets(
        {
          hosts: {
            local: [
              "https://app.webapp.globex.localhost/",
              "http://api.webapp.globex.localhost",
            ],
          },
        },
        "local",
        envConfig,
        OWNED,
      ),
    ).toEqual([
      "https://app.webapp.globex.localhost",
      "http://api.webapp.globex.localhost",
    ]);
  });
});

describe("isOwnedHost / ownedHostSuffixes", () => {
  beforeEach(() => {
    delete process.env[EXTRA_HOSTS_ENV];
  });
  afterEach(() => {
    delete process.env[EXTRA_HOSTS_ENV];
  });

  it("matches the apex and subdomains, not look-alikes", () => {
    const s = ["globex.localhost"];
    expect(isOwnedHost("globex.localhost", s)).toBe(true);
    expect(isOwnedHost("app.webapp.globex.localhost", s)).toBe(true);
    expect(isOwnedHost("APP.Webapp.Globex.Localhost", s)).toBe(true);
    expect(isOwnedHost("notglobex.localhost", s)).toBe(false);
    expect(isOwnedHost("globex.localhost.evil.io", s)).toBe(false);
  });

  it("a leading dot is ignored; an empty entry matches nothing", () => {
    expect(isOwnedHost("a.globex.internal", [".globex.internal"])).toBe(true);
    expect(isOwnedHost("example.com", ["."])).toBe(false);
  });

  it("extra hosts are exact-or-subdomain, never a wildcard of their parent", () => {
    const s = ownedHostSuffixes([], "scan-me.example.test, ");
    expect(s).toEqual(["scan-me.example.test"]);
    expect(isOwnedHost("scan-me.example.test", s)).toBe(true);
    expect(isOwnedHost("other.example.test", s)).toBe(false);
  });

  it("merges configured hosts with DEN_SECURITY_EXTRA_HOSTS, de-duplicated", () => {
    process.env[EXTRA_HOSTS_ENV] = "Extra.Example.Test,globex.localhost";
    expect(ownedHostSuffixes(OWNED)).toEqual([...OWNED, "extra.example.test"]);
  });

  it("owns nothing unless the org config lists hosts", () => {
    expect([...DEFAULT_SECURITY_OWNED_HOSTS]).toEqual([]);
  });
});

describe("resolveOpenapi", () => {
  const t = "https://api.webapp.globex.localhost";
  it("expands {baseUrl} in a URL template", () => {
    expect(resolveOpenapi("{baseUrl}/openapi.json", t, "/r")).toEqual({
      url: `${t}/openapi.json`,
    });
    expect(
      resolveOpenapi("https://docs.globex.localhost/o.json", t, "/r"),
    ).toEqual({ url: "https://docs.globex.localhost/o.json" });
  });

  it("resolves a repo-relative file and rejects traversal", () => {
    expect(resolveOpenapi("docs/openapi.yaml", "https://t", "/repo")).toEqual({
      file: "/repo/docs/openapi.yaml",
    });
    expect(() =>
      resolveOpenapi("../../etc/passwd", "https://t", "/repo"),
    ).toThrow(/escapes/);
  });

  it("undefined stays undefined", () => {
    expect(resolveOpenapi(undefined, "https://t", "/r")).toEqual({});
  });
});

describe("buildZapPlan", () => {
  const base = {
    target: "https://app.staging.globex.internal",
    reportDir: "/reports/run1",
    authenticated: false,
  } as const;

  afterEach(() => {
    delete process.env.DEN_ZAP_IMAGE;
  });

  it("baseline uses zap-baseline.py with report outputs and default logout exclude", () => {
    const plan = buildZapPlan({ ...base, mode: "baseline" });
    expect(plan.command).toBe("docker");
    expect(plan.args.slice(0, 4)).toEqual([
      "run",
      "--rm",
      "-v",
      "/reports/run1:/zap/wrk:rw",
    ]);
    expect(plan.args).toContain("zap-baseline.py");
    expect(plan.args).toContain("ghcr.io/zaproxy/zaproxy:stable");
    expect(plan.args).toEqual(
      expect.arrayContaining(["-t", base.target, "-J", "report.json", "-I"]),
    );
    const zOpts = plan.args[plan.args.indexOf("-z") + 1];
    expect(zOpts).toContain("globalexcludeurl.url_list.url(0).regex=");
    expect(zOpts).toMatch(/log\|sign/);
    expect(plan.envPassthrough).toEqual([]);
    expect(plan.args).not.toContain("--add-host");
  });

  it("DEN_ZAP_IMAGE overrides the pinned image", () => {
    process.env.DEN_ZAP_IMAGE = "ghcr.io/zaproxy/zaproxy@sha256:abc";
    const plan = buildZapPlan({ ...base, mode: "baseline" });
    expect(plan.args).toContain("ghcr.io/zaproxy/zaproxy@sha256:abc");
  });

  it("maps *.localhost targets onto the docker host so ZAP reaches the local edge", () => {
    const plan = buildZapPlan({
      ...base,
      mode: "api",
      target: "https://api.webapp.globex.localhost",
      openapiUrl: "https://docs.globex.localhost/openapi.json",
    });
    expect(plan.args.slice(4, 8)).toEqual([
      "--add-host",
      "api.webapp.globex.localhost:host-gateway",
      "--add-host",
      "docs.globex.localhost:host-gateway",
    ]);
  });

  it("appends manifest excludes after the defaults, indexed", () => {
    const plan = buildZapPlan({
      ...base,
      mode: "baseline",
      exclude: ["^/admin/delete", "/danger"],
    });
    const zOpts = plan.args[plan.args.indexOf("-z") + 1];
    expect(zOpts).toContain("url(1).regex=^/admin/delete");
    expect(zOpts).toContain("url(2).regex=/danger");
    expect(zOpts).toContain("url(2).enabled=true");
  });

  it("api mode mounts a local spec read-only and overrides the host", () => {
    const plan = buildZapPlan({
      ...base,
      mode: "api",
      openapiFile: "/repo/docs/openapi.yaml",
    });
    expect(plan.args).toContain("zap-api-scan.py");
    expect(plan.args).toContain(
      "/repo/docs/openapi.yaml:/zap/spec/openapi.yaml:ro",
    );
    expect(plan.args).toEqual(
      expect.arrayContaining([
        "-t",
        "/zap/spec/openapi.yaml",
        "-f",
        "openapi",
        "-O",
        base.target,
      ]),
    );
  });

  it("api mode accepts a spec URL; without any spec it throws", () => {
    const plan = buildZapPlan({
      ...base,
      mode: "api",
      openapiUrl: "https://app.staging.globex.internal/openapi.json",
    });
    expect(plan.args).toEqual(
      expect.arrayContaining([
        "-t",
        "https://app.staging.globex.internal/openapi.json",
      ]),
    );
    expect(() => buildZapPlan({ ...base, mode: "api" })).toThrow(/openapi/);
  });

  it("full mode uses zap-full-scan.py with a longer cap than baseline", () => {
    const full = buildZapPlan({ ...base, mode: "full" });
    const baseline = buildZapPlan({ ...base, mode: "baseline" });
    expect(full.args).toContain("zap-full-scan.py");
    expect(full.timeoutMs).toBeGreaterThan(baseline.timeoutMs);
  });

  it("authenticated runs pass the header by env NAME only — value never in argv", () => {
    const plan = buildZapPlan({
      ...base,
      mode: "baseline",
      authenticated: true,
    });
    expect(plan.envPassthrough).toEqual([AUTH_HEADER_ENV]);
    expect(plan.args).toEqual(
      expect.arrayContaining([
        "-e",
        AUTH_HEADER_ENV,
        "-e",
        "ZAP_AUTH_HEADER=Authorization",
      ]),
    );
    expect(plan.args.join(" ")).not.toMatch(/Bearer/);
  });
});

describe("summarizeZapReport / scanFailed", () => {
  const report = {
    site: [
      {
        alerts: [
          { riskcode: "3" },
          { riskcode: "2" },
          { riskcode: "2" },
          { riskcode: "1" },
          { riskcode: "0" },
        ],
      },
      { alerts: [{ riskcode: 3 }] },
    ],
  };

  it("counts alerts by risk across sites (string or numeric riskcode)", () => {
    expect(summarizeZapReport(report)).toEqual({
      high: 2,
      medium: 2,
      low: 1,
      informational: 1,
    });
  });

  it("an empty site list is zero findings; a non-ZAP shape throws", () => {
    expect(summarizeZapReport({ site: [] })).toEqual({
      high: 0,
      medium: 0,
      low: 0,
      informational: 0,
    });
    expect(() => summarizeZapReport({})).toThrow(/not a ZAP/);
    expect(() => summarizeZapReport(null)).toThrow(/not a ZAP/);
  });

  it("fails only on High", () => {
    expect(scanFailed({ high: 1, medium: 0, low: 0, informational: 0 })).toBe(
      true,
    );
    expect(scanFailed({ high: 0, medium: 9, low: 9, informational: 9 })).toBe(
      false,
    );
  });
});
