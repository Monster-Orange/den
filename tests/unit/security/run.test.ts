/**
 * Security CLI tests: arg parsing, policy gates, exit codes, secret handling.
 * Every collaborator (docker, token minting, filesystem, result writer) is
 * an injected fake — no scan ever runs.
 */

import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  CliUsageError,
  EXIT_CLEAN,
  EXIT_FINDINGS,
  EXIT_INFRA_ERROR,
  EXIT_NO_TARGETS,
  parseCliArgs,
  runSecurityCli,
  type EntrypointDeps,
} from "../../../src/pillars/security/run.js";
import {
  discoverSecurityTargets,
  type DiscoveredSecurityTarget,
} from "../../../src/pillars/security/discover.js";
import { AUTH_HEADER_ENV } from "../../../src/pillars/security/plan.js";
import type {
  DiscoveredRepo,
  TestResult,
} from "../../../src/shared/types/index.js";

// ── parseCliArgs ─────────────────────────────────────────────────────────────

describe("parseCliArgs", () => {
  it("requires --env exactly once", () => {
    expect(() => parseCliArgs([])).toThrow(CliUsageError);
    expect(() => parseCliArgs(["--env=dev", "--env=staging"])).toThrow(
      /Exactly one --env/,
    );
  });

  it("rejects unknown environments, modes, and arguments", () => {
    expect(() => parseCliArgs(["--env=prod"])).toThrow(/Unknown environment/);
    expect(() => parseCliArgs(["--env=dev", "--mode=nuke"])).toThrow(
      /Unknown mode/,
    );
    expect(() => parseCliArgs(["--env=dev", "--bogus"])).toThrow(
      /Unrecognized/,
    );
  });

  it("defaults to baseline, not dry-run", () => {
    expect(parseCliArgs(["--env=dev"])).toEqual({
      env: "dev",
      mode: "baseline",
      dryRun: false,
    });
  });

  it("parses service, mode and dry-run", () => {
    expect(
      parseCliArgs([
        "--env=dev",
        "--service=sample-webapp/api",
        "--mode=all",
        "--dry-run",
      ]),
    ).toEqual({
      env: "dev",
      service: "sample-webapp/api",
      mode: "all",
      dryRun: true,
    });
  });
});

// ── discovery ────────────────────────────────────────────────────────────────

describe("discoverSecurityTargets", () => {
  const repo = (name: string, security?: Record<string, object>) =>
    ({
      repoName: name,
      repoPath: `/repos/${name}`,
      manifest: { name, ...(security ? { security } : {}) },
    }) as unknown as DiscoveredRepo;

  it("flattens security blocks, sorted by repo then service, skipping repos without one", () => {
    const targets = discoverSecurityTargets([
      repo("rag-server", { web: { baseUrlKey: "web" } }),
      repo("noop"),
      repo("sample-webapp", {
        b: { baseUrlKey: "api" },
        a: { baseUrlKey: "api" },
      }),
    ]);
    expect(targets.map((t) => `${t.repoName}/${t.serviceName}`)).toEqual([
      "rag-server/web",
      "sample-webapp/a",
      "sample-webapp/b",
    ]);
    expect(targets[1].repoPath).toBe("/repos/sample-webapp");
  });
});

// ── runSecurityCli ───────────────────────────────────────────────────────────

const REPORT_CLEAN = JSON.stringify({
  site: [{ alerts: [{ riskcode: "1" }] }],
});
const REPORT_HIGH = JSON.stringify({ site: [{ alerts: [{ riskcode: "3" }] }] });

function target(
  serviceName: string,
  config: DiscoveredSecurityTarget["config"],
  repoName = "sample-webapp",
): DiscoveredSecurityTarget {
  return { repoName, repoPath: `/repos/${repoName}`, serviceName, config };
}

interface Harness {
  deps: EntrypointDeps;
  logs: string[];
  errors: string[];
  rows: TestResult[];
  files: Map<string, string>;
  runZap: jest.Mock<EntrypointDeps["runZap"]>;
  getToken: jest.Mock<EntrypointDeps["getToken"]>;
  mkdirp: jest.Mock<EntrypointDeps["mkdirp"]>;
}

function harness(
  targets: DiscoveredSecurityTarget[],
  options: { report?: string; exitCode?: number; timedOut?: boolean } = {},
): Harness {
  const logs: string[] = [];
  const errors: string[] = [];
  const rows: TestResult[] = [];
  const files = new Map<string, string>();
  const runZap = jest.fn<EntrypointDeps["runZap"]>(async (plan) => {
    // Simulate ZAP writing its report into the mounted dir.
    const mount = plan.args[plan.args.indexOf("-v") + 1].split(":")[0];
    files.set(`${mount}/report.json`, options.report ?? REPORT_CLEAN);
    return {
      exitCode: options.exitCode ?? 0,
      timedOut: options.timedOut ?? false,
    };
  });
  const getToken = jest.fn<EntrypointDeps["getToken"]>(
    async () => "tok-secret-123",
  );
  const mkdirp = jest.fn<EntrypointDeps["mkdirp"]>();
  const deps: EntrypointDeps = {
    discoverTargets: () => targets,
    ownedHosts: () => ["globex.localhost", "globex.internal"],
    loadEnvironment: async () => ({
      baseUrls: {
        web: "https://app.staging.globex.internal",
        api: "https://api.staging.globex.internal",
        services: {},
      },
    }),
    getToken,
    runZap,
    mkdirp,
    readFileIfExists: (p) => files.get(p),
    writeFile: (p, c) => {
      files.set(p, c);
    },
    writeResult: async (row) => {
      rows.push(row);
    },
    reportsRoot: "/reports/security",
    now: () => new Date("2026-10-26T00:00:00.000Z"),
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
  };
  return { deps, logs, errors, rows, files, runZap, getToken, mkdirp };
}

describe("runSecurityCli — policy gates", () => {
  const OLD_ALLOW = process.env.DEN_ALLOW_PROD;
  beforeEach(() => {
    delete process.env.DEN_ALLOW_PROD;
  });
  afterAll(() => {
    if (OLD_ALLOW === undefined) delete process.env.DEN_ALLOW_PROD;
    else process.env.DEN_ALLOW_PROD = OLD_ALLOW;
  });

  it("usage errors exit 1", async () => {
    const h = harness([]);
    expect(await runSecurityCli([], h.deps)).toBe(EXIT_INFRA_ERROR);
  });

  it("supports local (dry-run plans a scan, no refusal)", async () => {
    const h = harness([
      target("api", {
        hosts: { local: ["https://app.webapp.globex.localhost/"] },
      }),
    ]);
    expect(await runSecurityCli(["--env=local", "--dry-run"], h.deps)).toBe(
      EXIT_CLEAN,
    );
    expect(h.errors.join()).not.toMatch(/not supported/);
    expect(h.logs.join("\n")).toMatch(
      /--add-host app\.webapp\.globex\.localhost:host-gateway/,
    );
    expect(h.runZap).not.toHaveBeenCalled();
  });

  it("local still enforces the owned-host allowlist (the env config's localhost is refused)", async () => {
    const h = harness([target("api", { baseUrlKey: "api" })]);
    h.deps.loadEnvironment = async () => ({
      baseUrls: { web: "http://localhost:3000", api: "http://localhost:3001" },
    });
    expect(await runSecurityCli(["--env=local", "--dry-run"], h.deps)).toBe(
      EXIT_INFRA_ERROR,
    );
    expect(h.errors.join()).toMatch(
      /not an owned host \(add it to security\.owned_hosts in config\/den\.yml\)/,
    );
    expect(h.runZap).not.toHaveBeenCalled();
  });

  it("refuses production without DEN_ALLOW_PROD=1", async () => {
    const h = harness([target("api", { baseUrlKey: "api" })]);
    expect(await runSecurityCli(["--env=production"], h.deps)).toBe(
      EXIT_INFRA_ERROR,
    );
    expect(h.errors.join()).toMatch(/DEN_ALLOW_PROD/);
    expect(h.runZap).not.toHaveBeenCalled();
  });

  it("refuses an explicit mode above the env ceiling instead of downgrading", async () => {
    process.env.DEN_ALLOW_PROD = "1";
    const h = harness([
      target("api", { baseUrlKey: "api", openapi: "o.yaml" }),
    ]);
    expect(
      await runSecurityCli(["--env=production", "--mode=full"], h.deps),
    ).toBe(EXIT_INFRA_ERROR);
    expect(
      await runSecurityCli(["--env=production", "--mode=api"], h.deps),
    ).toBe(EXIT_INFRA_ERROR);
    expect(h.runZap).not.toHaveBeenCalled();
  });

  it("production --mode=all only ever runs baseline, unauthenticated, even if manifest asks for auth", async () => {
    process.env.DEN_ALLOW_PROD = "1";
    const h = harness([
      target("api", { baseUrlKey: "api", auth: ["admin"], openapi: "o.yaml" }),
    ]);
    expect(
      await runSecurityCli(["--env=production", "--mode=all"], h.deps),
    ).toBe(EXIT_CLEAN);
    expect(h.runZap).toHaveBeenCalledTimes(1);
    expect(h.getToken).not.toHaveBeenCalled();
    const plan = h.runZap.mock.calls[0][0];
    expect(plan.args).toContain("zap-baseline.py");
    expect(plan.envPassthrough).toEqual([]);
  });

  it("a non-owned host in the manifest aborts the whole run before any scan", async () => {
    const h = harness([
      target("api", { baseUrlKey: "api" }),
      target("evil", { hosts: { dev: ["https://example.com"] } }),
    ]);
    expect(await runSecurityCli(["--env=dev"], h.deps)).toBe(EXIT_INFRA_ERROR);
    expect(h.errors.join()).toMatch(/not an owned host/);
    expect(h.runZap).not.toHaveBeenCalled();
  });
});

describe("runSecurityCli — selection", () => {
  it("zero discovered targets exits 3", async () => {
    const h = harness([]);
    expect(await runSecurityCli(["--env=dev"], h.deps)).toBe(EXIT_NO_TARGETS);
  });

  it("--service matches repo-qualified or bare; no match exits 3", async () => {
    const targets = [
      target("api", { baseUrlKey: "api" }, "sample-webapp"),
      target("web", { baseUrlKey: "web" }, "rag-server"),
    ];
    let h = harness(targets);
    await runSecurityCli(["--env=staging", "--service=rag-server/web"], h.deps);
    expect(h.runZap).toHaveBeenCalledTimes(1);
    expect(h.runZap.mock.calls[0][0].args).toContain(
      "https://app.staging.globex.internal",
    );

    h = harness(targets);
    await runSecurityCli(["--env=staging", "--service=api"], h.deps);
    expect(h.runZap.mock.calls[0][0].args).toContain(
      "https://api.staging.globex.internal",
    );

    h = harness(targets);
    expect(
      await runSecurityCli(["--env=staging", "--service=nope"], h.deps),
    ).toBe(EXIT_NO_TARGETS);
  });

  it("--mode=api skips services without an openapi spec; all skipped exits 3", async () => {
    const h = harness([target("api", { baseUrlKey: "api" })]);
    expect(await runSecurityCli(["--env=dev", "--mode=api"], h.deps)).toBe(
      EXIT_NO_TARGETS,
    );
    expect(h.logs.join()).toMatch(/no openapi declared/);
  });

  it("--mode=all expands to every allowed mode for the env", async () => {
    const h = harness([
      target("api", { baseUrlKey: "api", openapi: "o.yaml" }),
    ]);
    await runSecurityCli(["--env=staging", "--mode=all"], h.deps);
    const scripts = h.runZap.mock.calls.map(([plan]) =>
      plan.args.find((a) => a.startsWith("zap-")),
    );
    expect(scripts).toEqual([
      "zap-baseline.py",
      "zap-api-scan.py",
      "zap-full-scan.py",
    ]);
  });

  it("one scan per auth role; token goes in the child env, never argv", async () => {
    const h = harness([
      target("api", { baseUrlKey: "api", auth: ["admin", "user"] }),
    ]);
    await runSecurityCli(["--env=dev"], h.deps);
    expect(h.runZap).toHaveBeenCalledTimes(2);
    expect(h.getToken.mock.calls.map((c) => c[0])).toEqual(["admin", "user"]);
    for (const [plan, childEnv] of h.runZap.mock.calls) {
      expect(childEnv[AUTH_HEADER_ENV]).toBe("Bearer tok-secret-123");
      expect(plan.args.join(" ")).not.toContain("tok-secret-123");
    }
  });
});

describe("runSecurityCli — dry run", () => {
  it("prints commands, runs nothing, mints nothing, creates nothing", async () => {
    const h = harness([target("api", { baseUrlKey: "api", auth: ["admin"] })]);
    expect(await runSecurityCli(["--env=dev", "--dry-run"], h.deps)).toBe(
      EXIT_CLEAN,
    );
    expect(h.logs.join("\n")).toMatch(/\[dry-run\].*\n\s+docker run/);
    expect(h.runZap).not.toHaveBeenCalled();
    expect(h.getToken).not.toHaveBeenCalled();
    expect(h.mkdirp).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(0);
  });
});

describe("runSecurityCli — results and exit codes", () => {
  it("clean report exits 0 and writes a passed security row", async () => {
    const h = harness([target("api", { baseUrlKey: "api" })]);
    expect(await runSecurityCli(["--env=staging"], h.deps)).toBe(EXIT_CLEAN);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({
      pillar: "security",
      environment: "staging",
      test: "sample-webapp/api:baseline",
      status: "passed",
    });
    expect(h.rows[0].metadata).toMatchObject({
      mode: "baseline",
      authenticated: false,
      alerts: { high: 0, low: 1 },
    });
  });

  it("a High alert exits 2 and writes a failed row", async () => {
    const h = harness([target("api", { baseUrlKey: "api" })], {
      report: REPORT_HIGH,
    });
    expect(await runSecurityCli(["--env=staging"], h.deps)).toBe(EXIT_FINDINGS);
    expect(h.rows[0].status).toBe("failed");
    expect(h.rows[0].error).toBeUndefined();
  });

  it("ZAP crash, timeout, missing or malformed report exit 1 (never silent green)", async () => {
    for (const options of [
      { exitCode: 3 },
      { timedOut: true },
      { report: "not json" },
      { report: JSON.stringify({ nope: true }) },
    ]) {
      const h = harness([target("api", { baseUrlKey: "api" })], options);
      expect(await runSecurityCli(["--env=dev"], h.deps)).toBe(
        EXIT_INFRA_ERROR,
      );
      expect(h.rows[0].status).toBe("failed");
      expect(h.rows[0].metadata).toMatchObject({ failure_kind: "infra_error" });
    }

    const h = harness([target("api", { baseUrlKey: "api" })]);
    h.runZap.mockImplementation(async () => ({ exitCode: 0, timedOut: false }));
    expect(await runSecurityCli(["--env=dev"], h.deps)).toBe(EXIT_INFRA_ERROR);
    expect(h.rows[0].error).toMatch(/no report\.json/);
  });

  it("infra errors dominate findings", async () => {
    const h = harness([
      target("a", { baseUrlKey: "api" }),
      target("b", { baseUrlKey: "web" }),
    ]);
    h.runZap
      .mockImplementationOnce(async (plan) => {
        const mount = plan.args[plan.args.indexOf("-v") + 1].split(":")[0];
        h.files.set(`${mount}/report.json`, REPORT_HIGH);
        return { exitCode: 1, timedOut: false };
      })
      .mockImplementationOnce(async () => ({ exitCode: 3, timedOut: false }));
    expect(await runSecurityCli(["--env=dev"], h.deps)).toBe(EXIT_INFRA_ERROR);
  });

  it("redacts the bearer token if it ever appears in a persisted report", async () => {
    const h = harness([target("api", { baseUrlKey: "api", auth: ["admin"] })]);
    h.runZap.mockImplementation(async (plan) => {
      const mount = plan.args[plan.args.indexOf("-v") + 1].split(":")[0];
      h.files.set(
        `${mount}/report.json`,
        JSON.stringify({ site: [], echoed: "Bearer tok-secret-123" }),
      );
      h.files.set(`${mount}/report.html`, "<p>tok-secret-123</p>");
      return { exitCode: 0, timedOut: false };
    });
    await runSecurityCli(["--env=dev"], h.deps);
    for (const [filePath, contents] of h.files) {
      expect(contents).not.toContain("tok-secret-123");
      expect(filePath).toMatch(/\/reports\/security\/dev\//);
    }
  });
});

describe("runSecurityCli — latest run summary", () => {
  const LATEST = "/reports/security/dev/latest-baseline.json";
  const report = (...plugins: Array<[string, string]>) =>
    JSON.stringify({
      site: [
        {
          alerts: plugins.map(([pluginid, riskcode]) => ({
            pluginid,
            alert: `rule ${pluginid}`,
            riskcode,
            count: "1",
          })),
        },
      ],
    });

  it("points latest-<mode>.json at the run and marks findings new since the last one", async () => {
    const h = harness([target("api", { baseUrlKey: "api" })], {
      report: report(["10038", "2"]),
    });
    await runSecurityCli(["--env=dev"], h.deps);
    const first = JSON.parse(h.files.get(LATEST) ?? "null");
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({
      id: "sample-webapp/api",
      url: "https://api.staging.globex.internal",
      newSince: [],
    });
    expect(
      first.results[0].findings.map((f: { pluginId: string }) => f.pluginId),
    ).toEqual(["10038"]);
    expect(first.results[0].report).toMatch(/^dev\/.+\/report\.html$/);
    expect(
      [...h.files.keys()].some((k) => k.endsWith("/summary-baseline.json")),
    ).toBe(true);

    // Second run: one rule carried over, one new.
    h.runZap.mockImplementation(async (plan) => {
      const mount = plan.args[plan.args.indexOf("-v") + 1].split(":")[0];
      h.files.set(
        `${mount}/report.json`,
        report(["40012", "3"], ["10038", "2"]),
      );
      return { exitCode: 0, timedOut: false };
    });
    await runSecurityCli(["--env=dev"], h.deps);
    const second = JSON.parse(h.files.get(LATEST) ?? "null");
    expect(second.results[0].newSince).toEqual(["40012"]);
  });

  it("records a scan that could not run as findings: null", async () => {
    const h = harness([target("api", { baseUrlKey: "api" })], { exitCode: 3 });
    await runSecurityCli(["--env=dev"], h.deps);
    const latest = JSON.parse(h.files.get(LATEST) ?? "null");
    expect(latest.results[0].findings).toBeNull();
    expect(latest.results[0].error).toMatch(/exited with code 3/);
  });
});
