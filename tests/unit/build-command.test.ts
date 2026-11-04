/**
 * buildCommand() and buildSyntheticPlaywrightArgs() unit tests
 *
 * Guards the module-selection logic that controls which tests actually run.
 * Regressions here cause expensive wrong test runs (all tests instead of the
 * selected ones, or the wrong pillar's command structure).
 *
 * Key invariants:
 *  - No modules selected → no path args, no --no-deps (run everything)
 *  - One module selected → one path arg + --no-deps (skip project deps)
 *  - Multiple modules → multiple path args + --no-deps
 *  - smoke/perf: one CommandStep emitted per selected module
 */

import { describe, it, expect } from "@jest/globals";
import { TestRunner } from "../../src/ui/cli/test-runner.js";
import { getDistRoot } from "../../src/shared/paths.js";
import * as path from "path";
import { enginePath as ENG, tsxBin } from "../../src/shared/engine.js";

// k6 paths are den-root anchored (absolute) so children with an arbitrary
// inherited cwd write/read the right place.
const anchored = (p: string) => path.resolve(getDistRoot(), p);

const runner = new TestRunner();

// Helper: extract the "Run Playwright" step args from a synthetic buildCommand result
function syntheticRunArgs(modules?: string[]): string[] {
  const steps = runner.buildCommand({
    pillar: "synthetic",
    environment: "local",
    modules,
  });
  // Step[0] = "Stage tests" (setup.ts), Step[1] = "Run Playwright"
  const runStep = steps.find((s) => s.label === "Run Playwright");
  if (!runStep) throw new Error("Run Playwright step not found");
  return runStep.args;
}

// ─── synthetic ────────────────────────────────────────────────────────────────

describe("buildCommand – synthetic pillar", () => {
  it("no modules: no path args and no --no-deps", () => {
    const args = syntheticRunArgs(undefined);
    expect(args).not.toContain("--no-deps");
    expect(args.some((a) => a.startsWith(".synth-run/"))).toBe(false);
  });

  it("empty modules array: same as no modules", () => {
    const args = syntheticRunArgs([]);
    expect(args).not.toContain("--no-deps");
    expect(args.some((a) => a.startsWith(".synth-run/"))).toBe(false);
  });

  it("one module: adds module name arg and --no-deps", () => {
    const args = syntheticRunArgs(["items"]);
    expect(args).toContain("items");
    expect(args).toContain("--no-deps");
  });

  it("multiple modules: adds one arg per module with --no-deps", () => {
    const args = syntheticRunArgs(["items", "storage", "settings-admin"]);
    expect(args).toContain("items");
    expect(args).toContain("storage");
    expect(args).toContain("settings-admin");
    expect(args).toContain("--no-deps");
    // --no-deps appears exactly once
    expect(args.filter((a) => a === "--no-deps")).toHaveLength(1);
  });

  it("produces exactly two steps (stage + run)", () => {
    const steps = runner.buildCommand({
      pillar: "synthetic",
      environment: "local",
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].label).toBe("Stage tests");
    expect(steps[1].label).toBe("Run Playwright");
  });
});

// ─── integration ─────────────────────────────────────────────────────────────

describe("buildCommand – integration pillar", () => {
  it("no modules: no path args added", () => {
    const steps = runner.buildCommand({
      pillar: "integration",
      environment: "local",
    });
    expect(steps).toHaveLength(1);
    const args = steps[0].args;
    expect(args.some((a) => a.startsWith(ENG("src/pillars/api/tests/")))).toBe(
      false,
    );
  });

  it("one module: adds correct path arg", () => {
    const steps = runner.buildCommand({
      pillar: "integration",
      environment: "local",
      modules: ["items"],
    });
    expect(steps[0].args).toContain(ENG("src/pillars/api/tests/items/"));
  });

  it("multiple modules: adds one path arg per module", () => {
    const steps = runner.buildCommand({
      pillar: "integration",
      environment: "local",
      modules: ["items", "users"],
    });
    const args = steps[0].args;
    expect(args).toContain(ENG("src/pillars/api/tests/items/"));
    expect(args).toContain(ENG("src/pillars/api/tests/users/"));
  });
});

// ─── smoke ────────────────────────────────────────────────────────────────────

describe("buildCommand – smoke pillar", () => {
  it("no modules: stage-global + run-global playwright + teardown verify", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "local",
    });
    expect(steps).toHaveLength(3);
    expect(steps[0].label).toBe("Stage all smoke tests");
    expect(steps[1].args).toContain(
      `--config=${ENG("src/pillars/smoke/playwright-global.config.ts")}`,
    );
    expect(steps[2].label).toBe("Verify smoke storage teardown");
  });

  it("one module: setup step + combined playwright step + teardown verify", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "local",
      modules: ["shop/api"],
    });
    expect(steps).toHaveLength(3);
    expect(steps[0].label).toBe("Stage api smoke tests");
    expect(steps[0].env).toMatchObject({
      SMOKE_SERVICE: "api",
      SMOKE_REPO: "shop",
      SMOKE_SERVICES: "api",
    });
    expect(steps[1].args).toContain(
      `--config=${ENG("src/pillars/smoke/playwright-all.config.ts")}`,
    );
    expect(steps[1].env).toMatchObject({
      SMOKE_REPO: "shop",
      SMOKE_SERVICES: "api",
    });
    expect(steps[2].label).toBe("Verify smoke storage teardown");
  });

  it("module with smokeCollection: setup + playwright with suite dir + teardown verify", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "local",
      modules: ["shop/api"],
      smokeCollection: "items",
    });
    expect(steps).toHaveLength(3);
    expect(steps[0].label).toBe("Stage api smoke tests");
    expect(steps[1].args).toContain(".smoke-run/shop-api/items");
    expect(steps[1].args).toContain(
      `--config=${ENG("src/pillars/smoke/playwright.config.ts")}`,
    );
    expect(steps[2].label).toBe("Verify smoke storage teardown");
  });

  it("multiple modules: setup per service + one combined playwright step + teardown verify", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "local",
      modules: ["shop/api", "shop/worker"],
    });
    expect(steps).toHaveLength(4);
    expect(steps[0].label).toBe("Stage api smoke tests");
    expect(steps[1].label).toBe("Stage worker smoke tests");
    expect(steps[2].args).toContain(
      `--config=${ENG("src/pillars/smoke/playwright-all.config.ts")}`,
    );
    expect(steps[2].env).toMatchObject({
      SMOKE_REPO: "shop",
      SMOKE_SERVICES: "api,worker",
    });
    expect(steps[3].label).toBe("Verify smoke storage teardown");
  });

  it("threads an explicit smoke API override into staging and run steps", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "local",
      modules: ["files-api/api"],
      baseApiUrl: "http://localhost:8080",
    });

    expect(steps).toHaveLength(3);
    expect(steps[0].env).toMatchObject({
      SMOKE_REPO: "files-api",
      SMOKE_SERVICE: "api",
      BASE_API_URL: "http://localhost:8080",
    });
    expect(steps[1].env).toMatchObject({
      SMOKE_REPO: "files-api",
      SMOKE_SERVICES: "api",
      BASE_API_URL: "http://localhost:8080",
    });
    expect(steps[2].label).toBe("Verify smoke storage teardown");
  });

  it("prepends deployed-clone setup for non-local smoke runs by default", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "sandbox",
      modules: ["files-api/api"],
    });

    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatchObject({
      command: tsxBin(),
      args: [
        ENG("src/pillars/smoke/setup-env.ts"),
        "--env",
        "sandbox",
        "--repo",
        "files-api",
      ],
      label: "Resolve deployed branch (sandbox)",
    });
    expect(steps[1].label).toBe("Stage api smoke tests");
    expect(steps[3].label).toBe("Verify smoke storage teardown");
  });

  it("skips deployed-clone setup for non-local smoke runs with local checkout override", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "sandbox",
      modules: ["files-api/api"],
      useLocalCheckout: true,
    });

    expect(steps).toHaveLength(3);
    expect(steps[0].label).toBe("Stage api smoke tests");
    expect(steps[0].env).toMatchObject({
      USE_LOCAL_CHECKOUT: "1",
      SMOKE_REPO: "files-api",
      SMOKE_SERVICE: "api",
    });
    expect(steps[2].label).toBe("Verify smoke storage teardown");
  });

  it("does not inherit BASE_API_URL for cloud smoke runs without an explicit override", () => {
    const previousBaseApiUrl = process.env.BASE_API_URL;
    process.env.BASE_API_URL = "http://localhost:8080";

    try {
      const steps = runner.buildCommand({
        pillar: "smoke",
        environment: "sandbox",
        modules: ["files-api/api"],
      });

      expect(steps[0].env.BASE_API_URL).toBeUndefined();
      expect(steps[1].env.BASE_API_URL).toBeUndefined();
      expect(steps[2].env.BASE_API_URL).toBeUndefined();
    } finally {
      if (previousBaseApiUrl === undefined) {
        delete process.env.BASE_API_URL;
      } else {
        process.env.BASE_API_URL = previousBaseApiUrl;
      }
    }
  });
});

// ─── journeys ────────────────────────────────────────────────────────────────

describe("buildCommand – journeys pillar", () => {
  it("no modules: one step running all journeys against the selected env", () => {
    const steps = runner.buildCommand({
      pillar: "journeys",
      environment: "local",
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      command: tsxBin(),
      args: [ENG("src/pillars/journeys/run.ts"), "--env=local"],
      label: "Run all journeys",
    });
    expect(steps[0].env.E2E_ENVIRONMENT).toBe("local");
  });

  it("one module: keeps the repo-qualified '<repo>/<name>' identity in --journey (review finding 10)", () => {
    const steps = runner.buildCommand({
      pillar: "journeys",
      environment: "local",
      modules: ["shop-web/user-first-item"],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].args).toEqual([
      ENG("src/pillars/journeys/run.ts"),
      "--env=local",
      "--journey=shop-web/user-first-item",
    ]);
    expect(steps[0].label).toBe("Run journey shop-web/user-first-item");
  });

  it("multiple modules: one run step per journey, in order", () => {
    const steps = runner.buildCommand({
      pillar: "journeys",
      environment: "local",
      modules: [
        "shop-web/user-first-item",
        "shop-web/connection-create-and-browse",
      ],
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].args).toContain("--journey=shop-web/user-first-item");
    expect(steps[1].args).toContain(
      "--journey=shop-web/connection-create-and-browse",
    );
  });

  it("environment selection flows into --env exactly like other pillars", () => {
    const steps = runner.buildCommand({
      pillar: "journeys",
      environment: "staging",
      modules: ["shop-web/user-first-item"],
    });
    expect(steps[0].args).toContain("--env=staging");
    expect(steps[0].env.E2E_ENVIRONMENT).toBe("staging");
  });

  it("passes production through — refusal policy is owned by the entrypoint", () => {
    const steps = runner.buildCommand({
      pillar: "journeys",
      environment: "production",
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].args).toContain("--env=production");
  });
});

// ─── performance ─────────────────────────────────────────────────────────────

describe("buildCommand – performance pillar", () => {
  it("no modules: returns empty steps", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "local",
    });
    expect(steps).toHaveLength(0);
  });

  it("one module: single k6 step running the distribution's test file", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "local",
      modules: ["api-health"],
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].command).toBe("k6");
    expect(steps[0].args).toContain("--summary-export");
    expect(steps[0].args).toContain(
      anchored(".perf-report/current/api-health.summary.json"),
    );
    expect(steps[0].args).toContain(
      anchored("tests/pillars/perf/api-health/test.js"),
    );
    expect(steps[1]).toMatchObject({
      command: tsxBin(),
      args: [ENG("src/pillars/perf/build-report.ts")],
      env: {
        PERF_ENVIRONMENT: "local",
        PERF_MODULES: "api-health",
      },
    });
  });

  it("multiple modules: one k6 step per module", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "local",
      modules: ["api-health", "api-load"],
    });
    expect(steps).toHaveLength(3);
    expect(steps[0].args).toContain(
      anchored(".perf-report/current/api-health.summary.json"),
    );
    expect(steps[0].args).toContain(
      anchored("tests/pillars/perf/api-health/test.js"),
    );
    expect(steps[1].args).toContain(
      anchored(".perf-report/current/api-load.summary.json"),
    );
    expect(steps[1].args).toContain(
      anchored("tests/pillars/perf/api-load/test.js"),
    );
    expect(steps[2]).toMatchObject({
      command: tsxBin(),
      args: [ENG("src/pillars/perf/build-report.ts")],
      env: {
        PERF_ENVIRONMENT: "local",
        PERF_MODULES: "api-health,api-load",
      },
    });
  });

  it("repo-backed perf module: wraps the run via the perf harness", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "local",
      modules: ["files-api/ingest"],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].command).toBe(tsxBin());
    expect(steps[0].args).toEqual([
      ENG("src/pillars/perf/run.ts"),
      "--env",
      "local",
      "--repo",
      "files-api",
      "--module",
      "ingest",
    ]);
    expect(steps[0].env.BASE_URL).toBeUndefined();
    expect(steps[0].env.BASE_API_URL).toBeUndefined();
  });

  it("repo-backed perf modules from the same repo share one wrapper step", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "local",
      modules: ["files-api/ingest", "files-api/tree"],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].args).toEqual([
      ENG("src/pillars/perf/run.ts"),
      "--env",
      "local",
      "--repo",
      "files-api",
      "--module",
      "ingest",
      "--repo",
      "files-api",
      "--module",
      "tree",
    ]);
  });

  it("repo-backed cloud perf runs add the repo clone setup step", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "sandbox",
      modules: ["files-api/ingest"],
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].args).toEqual([
      ENG("src/pillars/smoke/setup-env.ts"),
      "--env",
      "sandbox",
      "--repo",
      "files-api",
    ]);
    expect(steps[1].args).toContain(ENG("src/pillars/perf/run.ts"));
  });

  it("targets the selected cloud API URL for perf runs", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "dev",
      modules: ["api-health"],
    });

    expect(steps).toHaveLength(2);
    expect(steps[0].env).toMatchObject({
      BASE_URL: "https://api.dev.example.com",
    });
    expect(steps[1].label).toBe("Build perf report");
  });

  it("lets an explicit API override win for perf runs", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "dev",
      modules: ["api-health"],
      baseApiUrl: "https://override.example.test",
    });

    expect(steps).toHaveLength(2);
    expect(steps[0].env).toMatchObject({
      BASE_URL: "https://override.example.test",
    });
    expect(steps[1].label).toBe("Build perf report");
  });

  it("does not inherit BASE_API_URL for perf runs without an explicit override", () => {
    const previousBaseApiUrl = process.env.BASE_API_URL;
    process.env.BASE_API_URL = "http://localhost:8080";

    try {
      const steps = runner.buildCommand({
        pillar: "performance",
        environment: "dev",
        modules: ["api-health"],
      });

      expect(steps[0].env.BASE_API_URL).toBe("https://api.dev.example.com");
      expect(steps[0].env.BASE_URL).toBe("https://api.dev.example.com");
    } finally {
      if (previousBaseApiUrl === undefined) {
        delete process.env.BASE_API_URL;
      } else {
        process.env.BASE_API_URL = previousBaseApiUrl;
      }
    }
  });
});

// ─── security ────────────────────────────────────────────────────────────────

describe("buildCommand – security pillar", () => {
  it("no modules: one step running all security scans against the selected env", () => {
    const steps = runner.buildCommand({
      pillar: "security",
      environment: "staging",
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      command: tsxBin(),
      args: [ENG("src/pillars/security/run.ts"), "--env=staging"],
      label: "Run all security scans",
    });
    expect(steps[0].env.E2E_ENVIRONMENT).toBe("staging");
  });

  it("modules: one step per target, repo-qualified, never forcing a stronger mode", () => {
    const steps = runner.buildCommand({
      pillar: "security",
      environment: "local",
      modules: ["sample-webapp/api", "rag-server/app"],
    });
    expect(steps.map((s) => s.args)).toEqual([
      [
        ENG("src/pillars/security/run.ts"),
        "--env=local",
        "--service=sample-webapp/api",
      ],
      [
        ENG("src/pillars/security/run.ts"),
        "--env=local",
        "--service=rag-server/app",
      ],
    ]);
    expect(steps.flatMap((s) => s.args).join(" ")).not.toMatch(/--mode/);
  });
});
