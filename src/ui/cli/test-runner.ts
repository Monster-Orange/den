/**
 * Test Runner
 * Executes tests for each pillar
 */

import { spawn } from "child_process";
import chalk from "chalk";
import { spawnStreaming as sharedSpawnStreaming } from "../../shared/process/spawn-streaming.js";
import * as fs from "fs";
import * as path from "path";
import type { Pillar, Environment } from "../../shared/types/index.js";
import { refreshAuthIfNeeded } from "../../shared/auth/token-refresh.js";
import inquirer from "inquirer";
import {
  PERF_CURRENT_REPORT_DIR,
  getPerfSummaryArtifactPath,
} from "../../shared/perf/report-paths.js";
import { resetCurrentPerfRunReport } from "../../shared/perf/report-store.js";
import { getPerfTestFile } from "../../shared/perf/test-paths.js";
import { getDistRoot } from "../../shared/paths.js";
import {
  enginePath,
  playwrightCommand,
  tsxCommand,
  type EngineCommand,
} from "../../shared/engine.js";
import { product } from "../../shared/product.js";

/** Remediation when test sessions cannot be created (no vendor assumed). */
const SETUP_SECRETS_HINT = `  make ${product().cli}-setup-secrets  - Set up the selected secrets.provider`;
const CI_CREDENTIALS_HINT =
  "  CI: E2E_<ROLE>_EMAIL / E2E_<ROLE>_PASSWORD env vars";

/** After Playwright smoke runs: fail if storage fixture handoff was left behind. */
function smokePostRunTeardownVerifyStep(env: NodeJS.ProcessEnv): CommandStep {
  return {
    ...tsxCommand("src/pillars/smoke/ensure-smoke-teardown.ts"),
    env,
    label: "Verify smoke storage teardown",
  };
}

export interface CommandStep {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  label: string;
  continueOnFailure?: boolean;
}

export interface TestRunOptions {
  pillar: Pillar;
  environment: Environment;
  headed?: boolean;
  debug?: boolean;
  grep?: string;
  /** OWASP ZAP scan for the security pillar (default baseline). */
  securityMode?: "baseline" | "api" | "full";
  modules?: string[]; // selected modules; empty/undefined = all. e.g. ['items','storage']; smoke: ['shop/api']
  smokeCollection?: string; // smoke suite within a service, e.g. 'items'
  baseApiUrl?: string;
  useLocalCheckout?: boolean;
  // Per-perf-test env overrides, keyed by module name (the same name the module
  // scanner / web UI use, e.g. "api-load" or "repo/module"). Each test's
  // declared `optionalFields` are resolved to env vars by the server (via
  // resolveFieldEnv) and injected ONLY into THAT test's k6 process — never
  // globally. Empty/undefined for tests with no optional fields.
  moduleEnv?: Record<string, Record<string, string>>;
}

export interface TestRunResult {
  success: boolean;
  exitCode: number;
  duration: number;
}

export class TestRunner {
  private getBaseRunnerEnv(): NodeJS.ProcessEnv {
    const {
      BASE_API_URL: _baseApiUrl,
      BASE_URL: _baseUrl,
      ...rest
    } = process.env;
    return rest;
  }

  /**
   * Run tests for a specific pillar
   */
  async runTests(options: TestRunOptions): Promise<TestRunResult> {
    const startTime = Date.now();

    console.log(
      chalk.cyan(
        `\n🚀 Running ${options.pillar} tests against ${options.environment}\n`,
      ),
    );

    const result = await this.executeTestCommand(options);

    const duration = Date.now() - startTime;

    if (result.success) {
      console.log(
        chalk.green(
          `\n✅ Tests completed successfully in ${this.formatDuration(duration)}\n`,
        ),
      );
    } else {
      console.log(
        chalk.red(`\n❌ Tests failed in ${this.formatDuration(duration)}\n`),
      );
    }

    return {
      ...result,
      duration,
    };
  }

  /**
   * Execute test command based on pillar
   */
  private async executeTestCommand(
    options: TestRunOptions,
  ): Promise<{ success: boolean; exitCode: number }> {
    switch (options.pillar) {
      case "synthetic":
      case "integration":
        return await this.runPlaywrightTests(options);

      case "smoke":
        return await this.runSmokeTests(options);

      case "performance":
        return await this.runK6Tests(options);

      case "journeys":
        return await this.runJourneyTests(options);

      case "security":
        return await this.runSecurityTests(options);
      case "suites": {
        const [step] = this.pillarBuilders[options.pillar](
          options,
          { ...process.env, E2E_ENVIRONMENT: options.environment },
          undefined,
          "",
        );
        return await this.spawnProcess(step.command, step.args, step.env);
      }

      default:
        throw new Error(`Unknown pillar: ${options.pillar}`);
    }
  }

  /**
   * Run Playwright tests (synthetic or integration)
   */
  private async runPlaywrightTests(
    options: TestRunOptions,
  ): Promise<{ success: boolean; exitCode: number }> {
    // 1. Check if server is up before anything else
    const serverUp = await this.checkServerHealth(
      options.environment,
      options.pillar,
    );
    if (!serverUp) {
      return { success: false, exitCode: 1 };
    }

    // 2. Check auth tokens before running tests
    const authValid = await this.checkAndRefreshAuth(options.environment);
    if (!authValid) {
      return { success: false, exitCode: 1 };
    }

    // For synthetic tests: stage from linked repo first, then run from .synth-run/
    if (options.pillar === "synthetic") {
      return this.runStagedSyntheticTests(options);
    }

    // integration is the only pillar reaching this point (synthetic exits early above)
    const config = enginePath("src/pillars/api/playwright.config.ts");
    const args = ["test", "--config", config];
    const integrationMods = options.modules ?? [];
    if (integrationMods.length > 0) {
      integrationMods.forEach((m) =>
        args.push(enginePath(`src/pillars/api/tests/${m}`) + "/"),
      );
      console.log(
        chalk.cyan(`📦 Running module(s): ${integrationMods.join(", ")}\n`),
      );
    }

    // Only run headed for manual/interactive tests or when explicitly requested
    const shouldRunHeaded =
      options.headed ||
      (options.grep &&
        (options.grep.toLowerCase().includes("manual") ||
          options.grep.toLowerCase().includes("poc") ||
          options.grep.toLowerCase().includes("multi-user")));

    // Add options
    if (shouldRunHeaded) {
      args.push("--headed");
      console.log(
        chalk.yellow("📺 Running in headed mode (browser visible)\n"),
      );
    } else {
      console.log(chalk.gray("🚀 Running in headless mode (fast!)\n"));
    }

    if (options.debug) {
      args.push("--debug");
    }

    if (options.grep) {
      args.push("--grep", options.grep);
    }

    // Set environment variables
    const env = {
      ...process.env,
      E2E_ENVIRONMENT: options.environment,
      ...(options.useLocalCheckout ? { USE_LOCAL_CHECKOUT: "1" } : {}),
    };

    console.log(chalk.gray(`Environment: ${options.environment}`));
    console.log(chalk.gray(`E2E_ENVIRONMENT set to: ${env.E2E_ENVIRONMENT}\n`));

    return await this.spawnCommand(playwrightCommand(...args), env);
  }

  /**
   * Stage synthetic tests from the linked repo, then run them.
   * Uses synth/setup.ts to copy .spec.ts files + shims to .synth-run/<repo>/
   * and then runs synth/playwright.config.ts.
   */
  /**
   * Build the playwright command for a synthetic test run.
   * Single source of truth used by both runStagedSyntheticTests (CLI)
   * and buildCommand (web server) so they can never drift.
   */
  private buildSyntheticPlaywrightCommand(
    options: TestRunOptions,
  ): EngineCommand {
    const args = [
      "test",
      `--config=${enginePath("src/pillars/browser/playwright.config.ts")}`,
    ];

    const modules = options.modules ?? [];
    if (modules.length > 0) {
      for (const mod of modules) {
        // Pass just the module name — playwright matches it against the full
        // file path, which includes .synth-run/<repo>/<module>/. This avoids
        // hardcoding the repo name in the pattern.
        args.push(mod);
      }
      // Skip project dependencies when targeting specific modules — prevents
      // a run-last project (`*.last.spec.ts`) from triggering
      // the full suite just because it declares dependencies for ordering.
      args.push("--no-deps");
    }

    const shouldRunHeaded =
      options.headed ||
      (options.grep &&
        (options.grep.toLowerCase().includes("manual") ||
          options.grep.toLowerCase().includes("poc") ||
          options.grep.toLowerCase().includes("multi-user")));

    if (shouldRunHeaded) args.push("--headed");
    if (options.debug) args.push("--debug");
    if (options.grep) args.push("--grep", options.grep);

    return playwrightCommand(...args);
  }

  private async runStagedSyntheticTests(
    options: TestRunOptions,
  ): Promise<{ success: boolean; exitCode: number }> {
    const stageEnv = {
      ...process.env,
      E2E_ENVIRONMENT: options.environment,
    };

    console.log(chalk.cyan(`📦 Staging synthetic tests...\n`));
    const stageResult = await this.spawnCommand(
      tsxCommand("src/pillars/browser/setup.ts"),
      stageEnv,
    );
    if (!stageResult.success) {
      return stageResult;
    }

    const run = this.buildSyntheticPlaywrightCommand(options);

    const modules = options.modules ?? [];
    if (modules.length > 0) {
      console.log(chalk.cyan(`📦 Running module(s): ${modules.join(", ")}\n`));
    }

    const shouldRunHeaded =
      options.headed ||
      (options.grep &&
        (options.grep.toLowerCase().includes("manual") ||
          options.grep.toLowerCase().includes("poc") ||
          options.grep.toLowerCase().includes("multi-user")));

    if (shouldRunHeaded) {
      console.log(
        chalk.yellow("📺 Running in headed mode (browser visible)\n"),
      );
    } else {
      console.log(chalk.gray("🚀 Running in headless mode (fast!)\n"));
    }

    const env = { ...stageEnv };
    console.log(chalk.gray(`Environment: ${options.environment}`));
    console.log(chalk.gray(`E2E_ENVIRONMENT set to: ${env.E2E_ENVIRONMENT}\n`));

    return await this.spawnCommand(run, env);
  }

  /**
   * Run smoke tests via make test-smk-* targets
   * module format: "{repo}/{service}" (e.g. "shop/api") or null for all
   */
  private async runSmokeTests(
    options: TestRunOptions,
  ): Promise<{ success: boolean; exitCode: number }> {
    let makeTarget: string;
    let repo: string | undefined;

    const smokeMod = (options.modules ?? [])[0];
    if (smokeMod) {
      // module = "shop/api"
      const [repoName, service] = smokeMod.split("/");
      repo = repoName;
      if (options.smokeCollection) {
        // specific suite: make test-smk-api-items
        makeTarget = `test-smk-${service}-${options.smokeCollection}`;
      } else {
        // all suites in service: make test-smk-api-all
        makeTarget = `test-smk-${service}-all`;
      }
    } else {
      // all services: make test-smk-all
      makeTarget = "test-smk-all";
    }

    const env = {
      ...process.env,
      E2E_ENVIRONMENT: options.environment,
    };

    console.log(chalk.gray(`Environment: ${options.environment}`));

    return await this.spawnProcess(
      "make",
      [
        makeTarget,
        ...(repo ? [`repo=${repo}`] : []),
        `env=${options.environment}`,
      ],
      env,
    );
  }

  /**
   * Build the command steps for a journeys run — one `npx tsx
   * src/pillars/journeys/run.ts --env=<env> [--journey=<repo/name>]`
   * invocation per selected journey (or a single all-journeys run when
   * none are selected). Module names come from the module scanner as
   * "<repo>/<journey-name>" and flow through REPO-QUALIFIED (review
   * finding 10) — the entrypoint filters on repo + name, so duplicate
   * journey names across repos stay unambiguous. The selected
   * environment flows through as the required --env flag exactly like
   * other pillars — policy (production refusal, env allowlists) is owned
   * by the entrypoint, never duplicated here.
   *
   * Single source of truth used by both runJourneyTests (interactive CLI)
   * and pillarBuilders.journeys (web server) so they can never drift.
   */
  private buildJourneysSteps(
    options: TestRunOptions,
    baseEnv: NodeJS.ProcessEnv,
  ): CommandStep[] {
    const journeyNames = options.modules ?? [];

    if (journeyNames.length === 0) {
      return [
        {
          ...tsxCommand(
            "src/pillars/journeys/run.ts",
            `--env=${options.environment}`,
          ),
          env: baseEnv,
          label: "Run all journeys",
        },
      ];
    }

    return journeyNames.map((name) => ({
      ...tsxCommand(
        "src/pillars/journeys/run.ts",
        `--env=${options.environment}`,
        `--journey=${name}`,
      ),
      env: baseEnv,
      label: `Run journey ${name}`,
    }));
  }

  /**
   * Run journeys via the pillar entrypoint (sequential, abort on the
   * first failing journey run — its exit code is the run's exit code).
   */
  private async runJourneyTests(
    options: TestRunOptions,
  ): Promise<{ success: boolean; exitCode: number }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      E2E_ENVIRONMENT: options.environment,
    };

    console.log(chalk.gray(`Environment: ${options.environment}\n`));

    for (const step of this.buildJourneysSteps(options, env)) {
      const result = await this.spawnProcess(step.command, step.args, step.env);
      if (!result.success) {
        return result;
      }
    }

    return { success: true, exitCode: 0 };
  }

  /**
   * Build the command steps for a security run: one `npx tsx
   * src/pillars/security/run.ts --env=<env> [--service=<repo/name>]`
   * invocation per selected target (or one all-targets run). Always the
   * runner's default `baseline` (passive) mode: stronger modes are a
   * deliberate `make test-sec-... mode=` act, never a picker default.
   * Policy (production gate, mode ceiling) is owned by the entrypoint.
   */
  private buildSecuritySteps(
    options: TestRunOptions,
    baseEnv: NodeJS.ProcessEnv,
  ): CommandStep[] {
    const names = options.modules ?? [];
    const script = "src/pillars/security/run.ts";
    // An explicitly chosen stronger mode is passed on; the entrypoint's
    // per-env ceiling refuses it where it isn't allowed.
    const mode =
      options.securityMode && options.securityMode !== "baseline"
        ? [`--mode=${options.securityMode}`]
        : [];
    if (names.length === 0) {
      return [
        {
          ...tsxCommand(script, `--env=${options.environment}`, ...mode),
          env: baseEnv,
          label: "Run all security scans",
        },
      ];
    }
    return names.map((name) => ({
      ...tsxCommand(
        script,
        `--env=${options.environment}`,
        `--service=${name}`,
        ...mode,
      ),
      env: baseEnv,
      label: `Run security scan ${name}`,
    }));
  }

  /** Run security scans via the pillar entrypoint (sequential, abort on first failure). */
  private async runSecurityTests(
    options: TestRunOptions,
  ): Promise<{ success: boolean; exitCode: number }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      E2E_ENVIRONMENT: options.environment,
    };
    console.log(
      chalk.gray(`Environment: ${options.environment}
`),
    );
    for (const step of this.buildSecuritySteps(options, env)) {
      const result = await this.spawnProcess(step.command, step.args, step.env);
      if (!result.success) return result;
    }
    return { success: true, exitCode: 0 };
  }

  /**
   * Run k6 performance tests
   */
  private async runK6Tests(
    options: TestRunOptions,
  ): Promise<{ success: boolean; exitCode: number }> {
    // Check if k6 is installed
    const k6Installed = await this.checkK6Installed();

    if (!k6Installed) {
      console.log(chalk.red("\n❌ k6 is not installed"));
      console.log(
        chalk.gray(
          "Install k6 from: https://k6.io/docs/get-started/installation/",
        ),
      );
      console.log(chalk.gray("  macOS: brew install k6"));
      console.log(chalk.gray("  Linux: See installation guide\n"));
      return { success: false, exitCode: 1 };
    }

    const perfMods = options.modules ?? [];
    if (perfMods.length === 0) {
      console.log(chalk.red("\n❌ No performance test module specified\n"));
      return { success: false, exitCode: 1 };
    }

    const explicitBaseUrl = options.baseApiUrl?.trim() || undefined;
    const inheritedRunnerEnv = this.getBaseRunnerEnv();
    const baseEnv: NodeJS.ProcessEnv = {
      ...inheritedRunnerEnv,
      E2E_ENVIRONMENT: options.environment,
      ...(options.useLocalCheckout ? { USE_LOCAL_CHECKOUT: "1" } : {}),
      ...(explicitBaseUrl
        ? { BASE_URL: explicitBaseUrl, BASE_API_URL: explicitBaseUrl }
        : {}),
    };
    const { internalModules, repoModules } =
      this.partitionPerformanceModules(perfMods);

    for (const [repoName, moduleNames] of repoModules.entries()) {
      if (options.environment !== "local" && !options.useLocalCheckout) {
        const setupEnvResult = await this.spawnCommand(
          tsxCommand(
            "src/pillars/smoke/setup-env.ts",
            "--env",
            options.environment,
            "--repo",
            repoName,
          ),
          baseEnv,
        );
        if (!setupEnvResult.success) {
          return setupEnvResult;
        }
      }

      const repoRun = tsxCommand(
        "src/pillars/perf/run.ts",
        "--env",
        options.environment,
        ...(explicitBaseUrl ? ["--base-url", explicitBaseUrl] : []),
        ...(options.useLocalCheckout ? ["--use-local-checkout"] : []),
        ...moduleNames.flatMap((moduleName) => [
          "--repo",
          repoName,
          "--module",
          moduleName,
        ]),
      );
      const repoRunResult = await this.spawnCommand(repoRun, baseEnv);
      if (!repoRunResult.success) {
        return repoRunResult;
      }
    }

    if (internalModules.length > 0) {
      // Den-root anchored: the CLI's cwd is wherever the user ran `den`.
      fs.mkdirSync(path.resolve(getDistRoot(), PERF_CURRENT_REPORT_DIR), {
        recursive: true,
      });
      // Clear the prior run's report up front so a stale one is never served.
      resetCurrentPerfRunReport();
    }

    let internalOverallFailed = false;
    let internalFirstExitCode = 0;
    for (const perfMod of internalModules) {
      const result = await this.spawnProcess(
        "k6",
        [
          "run",
          "--summary-export",
          // Absolute: k6 resolves relative paths against its inherited cwd.
          path.resolve(getDistRoot(), getPerfSummaryArtifactPath(perfMod)),
          getPerfTestFile(perfMod),
        ],
        { ...baseEnv, ...(options.moduleEnv?.[perfMod] ?? {}) },
      );
      if (!result.success) {
        internalOverallFailed = true;
        if (internalFirstExitCode === 0) {
          internalFirstExitCode = result.exitCode;
        }
      }
    }

    if (internalModules.length > 0) {
      const reportResult = await this.spawnCommand(
        tsxCommand("src/pillars/perf/build-report.ts"),
        {
          ...baseEnv,
          PERF_ENVIRONMENT: options.environment,
          PERF_MODULES: internalModules.join(","),
        },
      );
      if (!reportResult.success) {
        return reportResult;
      }
    }

    if (internalOverallFailed) {
      return { success: false, exitCode: internalFirstExitCode || 1 };
    }

    return { success: true, exitCode: 0 };
  }

  private partitionPerformanceModules(modules: string[]): {
    internalModules: string[];
    repoModules: Map<string, string[]>;
  } {
    const internalModules: string[] = [];
    const repoModules = new Map<string, string[]>();

    for (const moduleName of modules) {
      const [repoName, perfModuleName] = moduleName.split("/", 2);
      if (!perfModuleName) {
        internalModules.push(moduleName);
        continue;
      }
      const existing = repoModules.get(repoName) ?? [];
      existing.push(perfModuleName);
      repoModules.set(repoName, existing);
    }

    return { internalModules, repoModules };
  }

  /**
   * Check if k6 is installed
   */
  private async checkK6Installed(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("which", ["k6"]);

      proc.on("close", (code) => {
        resolve(code === 0);
      });

      proc.on("error", () => {
        resolve(false);
      });
    });
  }

  /**
   * Spawn a child process and stream output
   */
  private spawnCommand(
    cmd: EngineCommand,
    env: NodeJS.ProcessEnv,
  ): Promise<{ success: boolean; exitCode: number }> {
    return this.spawnProcess(cmd.command, cmd.args, env);
  }

  private async spawnProcess(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ success: boolean; exitCode: number }> {
    return new Promise((resolve) => {
      console.log(chalk.gray(`$ ${command} ${args.join(" ")}\n`));

      const proc = spawn(command, args, {
        // The distribution root: reports, results and staged tests land there,
        // wherever the CLI was invoked from.
        cwd: getDistRoot(),
        env,
        stdio: "inherit", // Stream output directly to console
      });

      proc.on("close", (code) => {
        resolve({
          success: code === 0,
          exitCode: code || 0,
        });
      });

      proc.on("error", (error) => {
        console.error(chalk.red(`\n❌ Failed to execute: ${error.message}\n`));
        resolve({
          success: false,
          exitCode: 1,
        });
      });
    });
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);

    if (minutes > 0) {
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds}s`;
    }

    return `${seconds}s`;
  }

  /**
   * Check if server is up and accessible
   */
  private async checkServerHealth(
    environment: Environment,
    pillar: Pillar,
  ): Promise<boolean> {
    console.log(chalk.cyan("🏥 Checking server health...\n"));

    const baseUrl = await this.getBaseUrl(environment);
    const apiUrl = await this.getApiUrl(environment);

    // For synthetic tests, check web app
    if (pillar === "synthetic") {
      const webHealthy = await this.pingServer(baseUrl, "Web App");
      if (!webHealthy) {
        console.log(
          chalk.red(`\n❌ Web app is not accessible at: ${baseUrl}\n`),
        );
        const { shouldContinue } = await inquirer.prompt<{
          shouldContinue: boolean;
        }>([
          {
            type: "confirm",
            name: "shouldContinue",
            message: "The web app appears to be down. Continue anyway?",
            default: false,
          },
        ]);

        if (!shouldContinue) {
          console.log(chalk.yellow("\n💡 Make sure your app is running:"));
          console.log(chalk.gray("  cd shop/apps/web && npm run dev"));
          console.log(
            chalk.gray("  or check docker-compose if using containers\n"),
          );
          return false;
        }
      }
    }

    // For integration tests, check API
    if (pillar === "integration") {
      const apiHealthy = await this.pingServer(`${apiUrl}/docs`, "API");
      if (!apiHealthy) {
        console.log(
          chalk.red(`\n❌ API is not accessible at: ${apiUrl}/docs\n`),
        );
        const { shouldContinue } = await inquirer.prompt<{
          shouldContinue: boolean;
        }>([
          {
            type: "confirm",
            name: "shouldContinue",
            message: "The API appears to be down. Continue anyway?",
            default: false,
          },
        ]);

        if (!shouldContinue) {
          console.log(chalk.yellow("\n💡 Make sure your API is running:"));
          console.log(chalk.gray("  cd shop/apps/api && npm run dev"));
          console.log(
            chalk.gray("  or check docker-compose if using containers\n"),
          );
          return false;
        }
      }
    }

    console.log(chalk.green("✅ Server health check passed\n"));
    return true;
  }

  /**
   * Ping a server to check if it's responding
   */
  private async pingServer(url: string, serverName: string): Promise<boolean> {
    try {
      console.log(chalk.gray(`  Checking ${serverName}: ${url}`));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          redirect: "manual", // Don't follow redirects (auth redirect is OK)
        });
      } finally {
        clearTimeout(timeout);
      }

      // Accept 2xx (success) or 3xx (redirect - means server is up)
      // For web app, also accept 401/403 (means auth is working)
      const isHealthy =
        (response.status >= 200 && response.status < 400) ||
        response.status === 401 ||
        response.status === 403;

      if (isHealthy) {
        console.log(
          chalk.green(
            `  ✓ ${serverName} is responding (status: ${response.status})`,
          ),
        );
        return true;
      }

      // 4xx/5xx errors (except 401/403) indicate problems
      console.log(
        chalk.red(
          `  ✗ ${serverName} returned error status: ${response.status}`,
        ),
      );
      return false;
    } catch (error: unknown) {
      // Check specific error types
      const err = error as { name?: string; code?: string; message?: string };
      if (err.name === "AbortError") {
        console.log(chalk.red(`  ✗ ${serverName} timed out (5s)`));
      } else if (err.code === "ECONNREFUSED") {
        console.log(chalk.red(`  ✗ ${serverName} connection refused`));
      } else if (err.code === "ENOTFOUND") {
        console.log(chalk.red(`  ✗ ${serverName} hostname not found`));
      } else {
        console.log(
          chalk.red(`  ✗ ${serverName} not accessible: ${err.message}`),
        );
      }
      return false;
    }
  }

  /**
   * Check and refresh authentication tokens
   */
  private async checkAndRefreshAuth(
    environment: Environment,
  ): Promise<boolean> {
    const authDir = path.resolve(getDistRoot(), "playwright/.auth");
    const adminAuthFile = path.join(authDir, "admin.json");
    const userAuthFile = path.join(authDir, "user.json");

    // Get base URL from environment config
    const baseUrl = await this.getBaseUrl(environment);

    console.log(chalk.cyan("🔍 Checking authentication sessions...\n"));

    let hasValidAuth = false;

    // Check admin session
    if (fs.existsSync(adminAuthFile)) {
      console.log(chalk.gray("🔐 Checking admin session..."));
      const adminValid = await refreshAuthIfNeeded(adminAuthFile, baseUrl);
      if (adminValid) {
        console.log(chalk.green("  ✓ Admin session valid"));
        hasValidAuth = true;
      } else {
        console.log(chalk.yellow("  ⚠️  Admin session expired"));
      }
    }

    // Check user session
    if (fs.existsSync(userAuthFile)) {
      console.log(chalk.gray("👤 Checking user session..."));
      const userValid = await refreshAuthIfNeeded(userAuthFile, baseUrl);
      if (userValid) {
        console.log(chalk.green("  ✓ User session valid"));
        hasValidAuth = true;
      } else {
        console.log(chalk.yellow("  ⚠️  User session expired"));
      }
    }

    // If no auth files exist at all
    if (!fs.existsSync(adminAuthFile) && !fs.existsSync(userAuthFile)) {
      console.log(chalk.yellow("⚠️  No authentication sessions found\n"));
      const { shouldSetup } = await inquirer.prompt<{ shouldSetup: boolean }>([
        {
          type: "confirm",
          name: "shouldSetup",
          message: "Would you like to set up authentication now?",
          default: true,
        },
      ]);

      if (shouldSetup) {
        console.log(
          chalk.cyan(
            "\n📝 Sessions are created automatically — ensure the secrets backend is ready:\n",
          ),
        );
        console.log(chalk.cyan(SETUP_SECRETS_HINT));
        console.log(chalk.cyan(`${CI_CREDENTIALS_HINT}\n`));
        return false;
      } else {
        console.log(chalk.red("Cannot run tests without authentication\n"));
        return false;
      }
    }

    // If auth exists but is invalid
    if (!hasValidAuth) {
      console.log(
        chalk.yellow(
          "\n⚠️  Authentication failed — sessions are created fresh each run\n",
        ),
      );
      console.log(chalk.cyan(SETUP_SECRETS_HINT));
      console.log(chalk.cyan(`${CI_CREDENTIALS_HINT}\n`));
      return false;
    }

    console.log(chalk.green("\n✅ Authentication verified\n"));
    return true;
  }

  /**
   * Get base URL for environment
   */
  private async getBaseUrl(environment: Environment): Promise<string> {
    try {
      const configPath = path.resolve(
        getDistRoot(),
        `config/environments/${environment}.json`,
      );
      const configFile = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(configFile);
      return config.baseUrls.web;
    } catch {
      return "http://localhost:3000";
    }
  }

  /**
   * Build the sequence of shell commands for a test run without executing them.
   * Synthetic tests produce two steps (stage + run); all other pillars produce one.
   * Used by the web server to stream output via SSE without interactive prompts.
   */
  buildCommand(options: TestRunOptions): CommandStep[] {
    const explicitBaseUrlForCmd = options.baseApiUrl?.trim() || undefined;
    const resolvedApiBaseUrl =
      explicitBaseUrlForCmd || this.getApiUrlSync(options.environment);
    const inheritedRunnerEnv = this.getBaseRunnerEnv();
    const baseEnv: NodeJS.ProcessEnv = {
      ...inheritedRunnerEnv,
      E2E_ENVIRONMENT: options.environment,
      ...(options.useLocalCheckout ? { USE_LOCAL_CHECKOUT: "1" } : {}),
      ...(options.baseApiUrl?.trim()
        ? { BASE_API_URL: options.baseApiUrl.trim() }
        : {}),
      // Prevent Playwright from auto-opening the HTML report in a browser window
      PLAYWRIGHT_HTML_OPEN: "never",
    };

    const builder = this.pillarBuilders[options.pillar];
    if (!builder) return [];
    return builder(options, baseEnv, explicitBaseUrlForCmd, resolvedApiBaseUrl);
  }

  // ── Pillar command builders ────────────────────────────────────────────────
  // Registry of per-pillar buildCommand implementations. Adding a new pillar
  // means adding one entry here (and its run method in executeTestCommand).

  private pillarBuilders: Record<
    Pillar,
    (
      options: TestRunOptions,
      baseEnv: NodeJS.ProcessEnv,
      explicitBaseUrl: string | undefined,
      resolvedApiBaseUrl: string,
    ) => CommandStep[]
  > = {
    synthetic: (options, baseEnv) => {
      const env = { ...baseEnv };
      const run = this.buildSyntheticPlaywrightCommand(options);
      return [
        {
          ...tsxCommand("src/pillars/browser/setup.ts"),
          env,
          label: "Stage tests",
        },
        { ...run, env, label: "Run Playwright" },
      ];
    },

    integration: (options, baseEnv) => {
      const args = [
        "test",
        "--config",
        enginePath("src/pillars/api/playwright.config.ts"),
      ];
      for (const mod of options.modules ?? [])
        args.push(enginePath(`src/pillars/api/tests/${mod}`) + "/");
      if (options.headed) args.push("--headed");
      if (options.debug) args.push("--debug");
      if (options.grep) args.push("--grep", options.grep);
      return [
        { ...playwrightCommand(...args), env: baseEnv, label: "Run API tests" },
      ];
    },

    smoke: (options, baseEnv) => {
      const mods = options.modules ?? [];
      const isLocal = options.environment === "local";
      const useLocalCheckout = options.useLocalCheckout === true;

      // For non-local environments, prepend a step that clones each repo at
      // the deployed SHA before staging.  Local uses the symlinked sibling.
      const envSetupStep =
        !isLocal && !useLocalCheckout
          ? [
              {
                ...tsxCommand(
                  "src/pillars/smoke/setup-env.ts",
                  "--env",
                  options.environment,
                  // Pass --repo for each selected module so we only clone
                  // what we need; omit when running all (setup-env handles all)
                  ...mods.flatMap((m) => ["--repo", m.split("/")[0]]),
                ),
                env: baseEnv,
                label: `Resolve deployed branch (${options.environment})`,
              },
            ]
          : [];

      if (mods.length === 0) {
        // No module selected — run all services across all registered repos
        return [
          ...envSetupStep,
          {
            ...tsxCommand("src/pillars/smoke/setup-global.ts"),
            env: baseEnv,
            label: "Stage all smoke tests",
          },
          {
            ...playwrightCommand(
              "test",
              `--config=${enginePath("src/pillars/smoke/playwright-global.config.ts")}`,
            ),
            env: baseEnv,
            label: "Run all smoke tests",
          },
          smokePostRunTeardownVerifyStep(baseEnv),
        ];
      }
      // Stage each selected service, then ONE combined playwright run → one report.
      // All modules are assumed to be from the same repo (first module wins).
      const [repoName, firstService] = mods[0].split("/");
      const services = mods.map((m) => m.split("/")[1]);
      const smokeEnv = {
        ...baseEnv,
        SMOKE_REPO: repoName,
        SMOKE_SERVICES: services.join(","),
      };

      const setupSteps = services.map((svc) => ({
        ...tsxCommand("src/pillars/smoke/setup.ts"),
        env: { ...smokeEnv, SMOKE_SERVICE: svc },
        label: `Stage ${svc} smoke tests`,
      }));

      if (options.smokeCollection && mods.length === 1) {
        // Single service + specific suite
        const suiteDir = `.smoke-run/${repoName}-${firstService}/${options.smokeCollection}`;
        const runEnv = { ...smokeEnv, SMOKE_SERVICE: firstService };
        return [
          ...envSetupStep,
          setupSteps[0],
          {
            ...playwrightCommand(
              "test",
              `--config=${enginePath("src/pillars/smoke/playwright.config.ts")}`,
              suiteDir,
            ),
            env: runEnv,
            label: `Run ${firstService}/${options.smokeCollection}`,
          },
          smokePostRunTeardownVerifyStep(runEnv),
        ];
      }

      // All suites for selected services — one combined report
      return [
        ...envSetupStep,
        ...setupSteps,
        {
          ...playwrightCommand(
            "test",
            `--config=${enginePath("src/pillars/smoke/playwright-all.config.ts")}`,
          ),
          env: smokeEnv,
          label: `Run smoke tests (${services.join(", ")})`,
        },
        smokePostRunTeardownVerifyStep(smokeEnv),
      ];
    },

    performance: (
      options,
      baseEnv,
      explicitBaseUrlForCmd,
      resolvedApiBaseUrl,
    ) => {
      const mods = options.modules ?? [];
      if (mods.length === 0) return [];
      const { internalModules, repoModules } =
        this.partitionPerformanceModules(mods);
      const steps: CommandStep[] = [];

      for (const [repoName, moduleNames] of repoModules.entries()) {
        const isLocal = options.environment === "local";
        if (!isLocal && !options.useLocalCheckout) {
          steps.push({
            ...tsxCommand(
              "src/pillars/smoke/setup-env.ts",
              "--env",
              options.environment,
              "--repo",
              repoName,
            ),
            env: baseEnv,
            label: `Resolve deployed branch (${options.environment})`,
          });
        }

        steps.push({
          ...tsxCommand(
            "src/pillars/perf/run.ts",
            "--env",
            options.environment,
            ...(explicitBaseUrlForCmd
              ? ["--base-url", explicitBaseUrlForCmd]
              : []),
            ...(options.useLocalCheckout ? ["--use-local-checkout"] : []),
            ...moduleNames.flatMap((moduleName) => [
              "--repo",
              repoName,
              "--module",
              moduleName,
            ]),
          ),
          env: {
            ...baseEnv,
            ...(explicitBaseUrlForCmd
              ? {
                  BASE_URL: explicitBaseUrlForCmd,
                  BASE_API_URL: explicitBaseUrlForCmd,
                }
              : {}),
          },
          label: `Run k6 ${repoName} (${moduleNames.join(", ")})`,
        });
      }

      if (internalModules.length > 0) {
        fs.mkdirSync(path.resolve(getDistRoot(), PERF_CURRENT_REPORT_DIR), {
          recursive: true,
        });
        // Clear the prior run's report up front so a stale one is never served
        // if this run is read before — or never — regenerates report.json.
        resetCurrentPerfRunReport();
      }

      for (const mod of internalModules) {
        // Per-test optional-field env, resolved upstream (server → resolveFieldEnv)
        // and routed ONLY to this module's k6 process — never globally.
        const fieldEnv = options.moduleEnv?.[mod] ?? {};
        const fieldKeys = Object.keys(fieldEnv);
        steps.push({
          command: "k6",
          args: [
            "run",
            "--summary-export",
            // Absolute: k6 resolves relative paths against its inherited cwd.
            path.resolve(getDistRoot(), getPerfSummaryArtifactPath(mod)),
            getPerfTestFile(mod),
          ],
          env: {
            ...baseEnv,
            BASE_URL: resolvedApiBaseUrl,
            BASE_API_URL: options.baseApiUrl?.trim() || resolvedApiBaseUrl,
            ...fieldEnv,
          },
          label: `Run k6 ${mod}${
            fieldKeys.length > 0 ? ` (${fieldKeys.join(", ")})` : ""
          }`,
          // A perf run that breaches an SLO threshold exits k6 non-zero — that
          // is EXPECTED for a stress test, and the run must still proceed to
          // the "Build perf report" step. Otherwise the run aborts before the
          // report is regenerated and the web UI serves the previous run's
          // stale report (frozen at the last all-passing run). Always continue;
          // the overall run exit code still reflects the breach.
          continueOnFailure: true,
        });
      }

      if (internalModules.length > 0) {
        steps.push({
          ...tsxCommand("src/pillars/perf/build-report.ts"),
          env: {
            ...baseEnv,
            PERF_ENVIRONMENT: options.environment,
            PERF_MODULES: internalModules.join(","),
          },
          label: "Build perf report",
        });
      }

      return steps;
    },

    journeys: (options, baseEnv) => this.buildJourneysSteps(options, baseEnv),

    security: (options, baseEnv) => this.buildSecuritySteps(options, baseEnv),

    suites: (options, baseEnv) => [
      {
        ...tsxCommand(
          "src/pillars/suites/run.ts",
          "--env",
          options.environment,
          ...(options.modules ?? []).flatMap((m) => ["--suite", m]),
        ),
        env: baseEnv,
        label: "Run repo suites",
      },
    ],
  };

  /**
   * Spawn a process and stream stdout/stderr line-by-line via callbacks.
   * ANSI colour codes are stripped so browser output renders cleanly.
   * Used by the web server for SSE streaming.
   */
  spawnStreaming(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    onLine: (line: string) => void,
    onClose: (exitCode: number) => void,
    cwd?: string,
    detached?: boolean,
  ): ReturnType<typeof spawn> {
    return sharedSpawnStreaming(
      command,
      args,
      env,
      onLine,
      onClose,
      cwd,
      detached,
    );
  }

  /**
   * Get API URL for environment
   */
  private async getApiUrl(environment: Environment): Promise<string> {
    try {
      const configPath = path.resolve(
        getDistRoot(),
        `config/environments/${environment}.json`,
      );
      const configFile = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(configFile);
      return config.baseUrls.api;
    } catch {
      return "http://localhost:4000";
    }
  }

  private getApiUrlSync(environment: Environment): string {
    try {
      const configPath = path.resolve(
        getDistRoot(),
        `config/environments/${environment}.json`,
      );
      const configFile = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(configFile);
      return config.baseUrls.api;
    } catch {
      return "http://localhost:4000";
    }
  }
}

export const testRunner = new TestRunner();
