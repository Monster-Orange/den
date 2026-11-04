import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parseArgs } from "util";
import { resolveManifestBaseUrl } from "../../shared/service-url.js";
import { getDistRoot } from "../../shared/paths.js";
import type { Environment } from "../../shared/types/index.js";
import { findManifest, resolveRepoPath } from "../smoke/discover.js";
import { assertStorageAdminProbe } from "../smoke/admin-probe.js";
import {
  acquireFixture,
  releaseFixturesForConsumer,
} from "../smoke/fixture-manager.js";
import { resolvePerformanceStorageFixture } from "../smoke/fixtures.js";
import {
  PERF_CURRENT_REPORT_DIR,
  getPerfSummaryArtifactPath,
} from "../../shared/perf/report-paths.js";
import {
  writeCurrentPerfRunReport,
  resetCurrentPerfRunReport,
} from "../../shared/perf/report-store.js";

import { product } from "../../shared/product.js";
export interface PerfRunModule {
  repoName: string;
  moduleName: string;
}

export interface RunPerfModulesOptions {
  modules: PerfRunModule[];
  environment: Environment;
  baseUrl: string;
  useLocalCheckout?: boolean;
  env?: NodeJS.ProcessEnv;
}

function spawnK6Process(
  testFile: string,
  env: NodeJS.ProcessEnv,
  summaryExportPath?: string,
): Promise<{ success: boolean; exitCode: number }> {
  const args = ["run"];
  if (summaryExportPath) {
    args.push("--summary-export", summaryExportPath);
  }
  args.push(testFile);
  return new Promise((resolve) => {
    const proc = spawn("k6", args, {
      env,
      stdio: "inherit",
    });

    proc.on("close", (code) => {
      resolve({
        success: code === 0,
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (error) => {
      console.error(`Failed to execute k6: ${error.message}`);
      resolve({
        success: false,
        exitCode: 1,
      });
    });
  });
}

function logPerfTeardownFailure(error: unknown): void {
  if (error instanceof AggregateError) {
    console.error("Performance storage fixture teardown failed:");
    for (const [index, err] of error.errors.entries()) {
      console.error(`  [${index + 1}/${error.errors.length}]`, err);
    }
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Performance storage fixture teardown failed: ${message}`);
}

export async function runPerfModules(
  options: RunPerfModulesOptions,
): Promise<{ success: boolean; exitCode: number }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env ?? {}),
    E2E_ENVIRONMENT: options.environment,
    BASE_URL: options.baseUrl,
    BASE_API_URL: options.baseUrl,
  };
  const releases: Array<() => Promise<void>> = [];

  let k6Outcome = { success: true, exitCode: 0 };
  let caughtError: unknown = undefined;
  let teardownFailed = false;
  let disabledSkipCount = 0;
  const completedModuleKeys: string[] = [];

  // Den-root anchored: this child inherits its spawner's (arbitrary) cwd.
  fs.mkdirSync(path.resolve(getDistRoot(), PERF_CURRENT_REPORT_DIR), {
    recursive: true,
  });
  // Clear the prior run's report so a stale one is never served.
  resetCurrentPerfRunReport();

  try {
    for (const moduleRef of options.modules) {
      const discovered = findManifest(moduleRef.repoName);
      if (!discovered) {
        throw new Error(
          `Performance repo "${moduleRef.repoName}" is not registered with ${product().cli}`,
        );
      }

      const repoPath = resolveRepoPath(
        discovered,
        options.environment,
        options.useLocalCheckout ?? false,
      );
      const moduleConfig =
        discovered.manifest.performance?.[moduleRef.moduleName];
      if (!moduleConfig) {
        throw new Error(
          `Performance module "${moduleRef.moduleName}" not found in ${moduleRef.repoName}/${product().manifestYml}`,
        );
      }

      if (moduleConfig.enabled === false) {
        console.warn(
          `Skipping disabled performance module "${moduleRef.moduleName}" (${moduleRef.repoName})`,
        );
        disabledSkipCount += 1;
        continue;
      }

      const moduleEnv = {
        ...env,
        PERF_TEST_ID: `${moduleRef.repoName}/${moduleRef.moduleName}`,
        PERF_RUN_ID:
          env.PERF_RUN_ID ??
          `${moduleRef.repoName}-${moduleRef.moduleName}-${Date.now()}`,
      };

      if (moduleConfig.fixtures?.storage?.[options.environment]) {
        const lifecycle = resolvePerformanceStorageFixture(
          discovered.manifest,
          moduleRef.moduleName,
          options.environment,
          moduleEnv,
        );
        if (lifecycle.adminProbePath) {
          await assertStorageAdminProbe({
            baseUrl: options.baseUrl,
            adminProbePath: lifecycle.adminProbePath,
            label: `${moduleRef.repoName} / ${moduleRef.moduleName} (${moduleConfig.service})`,
            ...(lifecycle.adminProbe403Hint
              ? { hintOn403: () => lifecycle.adminProbe403Hint! }
              : {}),
          });
        }
        const fixtureEnv = { ...moduleEnv, ...lifecycle.envVars };
        const release = await acquireFixture({
          fixtureKey: lifecycle.fixtureKey,
          resolvedPayload: lifecycle.resolvedPayload as unknown as Record<
            string,
            unknown
          >,
          cwd: repoPath,
          env: fixtureEnv,
          setup: lifecycle.setup,
          teardown: lifecycle.teardown,
        });
        releases.push(release);
        Object.assign(moduleEnv, lifecycle.envVars);
      }

      const testFile = path.resolve(
        repoPath,
        moduleConfig.testDir,
        moduleConfig.testMatch,
      );
      const moduleKey = `${moduleRef.repoName}/${moduleRef.moduleName}`;
      // Absolute: k6 resolves relative paths against its inherited cwd.
      const summaryPath = path.resolve(
        getDistRoot(),
        getPerfSummaryArtifactPath(moduleKey),
      );
      const result = await spawnK6Process(testFile, moduleEnv, summaryPath);
      completedModuleKeys.push(moduleKey);
      k6Outcome = result;
      if (!result.success) {
        break;
      }
    }

    if (
      disabledSkipCount === options.modules.length &&
      options.modules.length > 0
    ) {
      throw new Error(
        `All requested performance modules are disabled in manifest: ${options.modules
          .map((m) => `${m.repoName}/${m.moduleName}`)
          .join(", ")}`,
      );
    }
  } catch (e) {
    caughtError = e;
  } finally {
    try {
      await releaseFixturesForConsumer(releases);
    } catch (e) {
      teardownFailed = true;
      logPerfTeardownFailure(e);
    }
    console.log("  Storage fixture teardown completed.");
  }

  if (completedModuleKeys.length > 0) {
    try {
      writeCurrentPerfRunReport({
        environment: options.environment,
        modules: completedModuleKeys,
        finishedAt: new Date().toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Failed to generate perf report: ${msg}`);
    }
  }

  if (caughtError !== undefined) {
    throw caughtError;
  }
  if (teardownFailed) {
    return {
      success: false,
      exitCode: k6Outcome.success ? 1 : k6Outcome.exitCode,
    };
  }
  return k6Outcome;
}

function cliArgs() {
  return parseArgs({
    options: {
      env: { type: "string" },
      repo: { type: "string", multiple: true },
      module: { type: "string", multiple: true },
      "base-url": { type: "string" },
      "use-local-checkout": { type: "boolean" },
    },
  }).values;
}

/**
 * Auto-resolve a base URL for perf runs from the manifest's
 * `services.*.health.<env>` entry, falling back to
 * `config/environments/<env>.json → baseUrls.api`.
 */
export function resolveBaseUrlFromManifest(
  repoName: string,
  moduleName: string,
  environment: Environment,
): string | null {
  const discovered = findManifest(repoName);
  if (!discovered) return null;

  const moduleConfig = discovered.manifest.performance?.[moduleName];
  if (!moduleConfig) return null;

  const serviceName = moduleConfig.service ?? repoName;
  const baseUrlKey = moduleConfig.baseUrlKey ?? "api";

  const manifestUrl = resolveManifestBaseUrl({
    manifest: discovered.manifest,
    repoName,
    serviceName,
    environment,
    baseUrlKey,
  });
  if (manifestUrl) return manifestUrl;

  try {
    const configPath = path.resolve(
      `./config/environments/${environment}.json`,
    );
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.baseUrls?.services?.[serviceName] ?? null;
  } catch {
    return null;
  }
}

export async function main(): Promise<number> {
  const values = cliArgs();
  const repos = values.repo ?? [];
  const moduleNames = values.module ?? [];
  if (repos.length !== moduleNames.length || repos.length === 0) {
    throw new Error(
      "Performance runner requires matching --repo and --module arguments",
    );
  }

  const environment = (values.env ??
    process.env.E2E_ENVIRONMENT ??
    "local") as Environment;

  const baseUrl =
    resolveBaseUrlFromManifest(repos[0], moduleNames[0], environment) ??
    values["base-url"] ??
    process.env.BASE_URL ??
    process.env.BASE_API_URL;
  if (!baseUrl) {
    throw new Error(
      "Could not determine base URL. Provide --base-url, set BASE_URL, " +
        `or add a services.*.health.<env> entry in ${product().manifestYml}`,
    );
  }

  const result = await runPerfModules({
    modules: repos.map((repoName, index) => ({
      repoName,
      moduleName: moduleNames[index],
    })),
    environment,
    baseUrl,
    useLocalCheckout: values["use-local-checkout"] ?? false,
    env: process.env,
  });
  return result.exitCode;
}

if (process.argv[1]?.endsWith("/run.ts")) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
