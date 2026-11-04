/**
 * Security CLI entrypoint (security pillar).
 *
 *   npx tsx src/pillars/security/run.ts --env=<env> [--service=<repo/name>]
 *       [--mode=<baseline|api|full|all>] [--dry-run]
 *
 * Runs OWASP ZAP (docker) against our OWN services declared in their
 * .den.yml `security:` blocks (or den's held manifests in
 * manifests/). Conventions mirror the journeys pillar:
 *
 * - `--env` is REQUIRED and exactly one per invocation (the make targets
 *   add the command-line-origin guard on top). `production` additionally
 *   needs DEN_ALLOW_PROD=1.
 * - Every target host must be on the owned-host allowlist
 *   (config/den.yml `security.owned_hosts`, default: none), in every
 *   env.
 * - Mode policy lives in plan.ts (MODE_CEILING): production is passive
 *   `baseline` only and no manifest can widen that. `--mode` defaults to
 *   `baseline`; `all` runs every mode the service allows in the env. An
 *   explicit mode above the env's ceiling is REFUSED, never downgraded.
 * - Production never injects credentials (unauthenticated passive scan),
 *   even if the manifest lists `auth:` roles.
 * - `--dry-run` prints each docker command and exits 0 without minting
 *   tokens, creating directories, or starting anything.
 * - Sequential in v1. Exit codes: 0 no High alerts / 1 infra or usage error
 *   / 2 at least one scan found a High alert / 3 nothing was scanned.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import type {
  Environment,
  SecurityMode,
  TestResult,
} from "../../shared/types/index.js";
import { getDistRoot } from "../../shared/paths.js";
import {
  isProductionEnv,
  readSecurityAutoTargets,
} from "../../shared/den-config.js";
import { isProtectedRemote } from "../../shared/manifest/placement.js";
import { listServicesWithManifests } from "../../shared/manifest/workspace-manifests.js";
import {
  autoSecurityTargets,
  discoverSecurityTargets,
  securityTargetId,
  type DiscoveredSecurityTarget,
} from "./discover.js";
import {
  latestSummaryPath,
  newFindings,
  parseZapReport,
  type Finding,
  type ScanSummary,
  type TargetResult,
} from "./findings.js";
import {
  AUTH_HEADER_ENV,
  allowedModes,
  buildZapPlan,
  MODE_CEILING,
  resolveOpenapi,
  resolveTargets,
  scanFailed,
  summarizeZapReport,
  type AlertCounts,
  ownedHostSuffixes,
  type SecurityEnvConfigLike,
  type ZapPlan,
} from "./plan.js";

import { envKey, product } from "../../shared/product.js";
import { containsValue, redactValues } from "../../shared/redact.js";
// ── Exit codes ───────────────────────────────────────────────────────────────

export const EXIT_CLEAN = 0;
export const EXIT_INFRA_ERROR = 1;
export const EXIT_FINDINGS = 2;
/** Nothing was scanned — loud and distinct, never silent green. */
export const EXIT_NO_TARGETS = 3;

// ── CLI args ─────────────────────────────────────────────────────────────────

const KNOWN_ENVIRONMENTS: readonly Environment[] = [
  "local",
  "dev",
  "sandbox",
  "staging",
  "production",
];
const KNOWN_MODES: readonly string[] = ["baseline", "api", "full", "all"];

const USAGE =
  "Usage: run.ts --env=<env> [--service=<name>] " +
  "[--mode=<baseline|api|full|all>] [--dry-run]";

/** Operator/usage mistake — maps to {@link EXIT_INFRA_ERROR}. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface ParsedCliArgs {
  env: Environment;
  service?: string;
  mode: SecurityMode | "all";
  dryRun: boolean;
}

/**
 * Parse the CLI args. `--env` is required exactly once; unknown arguments
 * are rejected loudly rather than ignored.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const envValues: string[] = [];
  let service: string | undefined;
  let mode = "baseline";
  let dryRun = false;

  for (const arg of argv) {
    if (arg.startsWith("--env=")) {
      envValues.push(arg.slice("--env=".length));
    } else if (arg.startsWith("--service=")) {
      service = arg.slice("--service=".length);
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new CliUsageError(`Unrecognized argument "${arg}". ${USAGE}`);
    }
  }

  if (envValues.length === 0) {
    throw new CliUsageError(
      `--env is required (exactly one environment per invocation). ${USAGE}`,
    );
  }
  if (envValues.length > 1) {
    throw new CliUsageError(
      "Exactly one --env per invocation — scans never fan out across " +
        `environments (got: ${envValues.join(", ")}).`,
    );
  }
  const env = envValues[0];
  if (!(KNOWN_ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new CliUsageError(
      `Unknown environment "${env}". Known: ${KNOWN_ENVIRONMENTS.join(", ")}.`,
    );
  }
  if (!KNOWN_MODES.includes(mode)) {
    throw new CliUsageError(
      `Unknown mode "${mode}". Known: ${KNOWN_MODES.join(", ")}.`,
    );
  }

  const parsed: ParsedCliArgs = {
    env: env as Environment,
    mode: mode as SecurityMode | "all",
    dryRun,
  };
  if (service !== undefined) parsed.service = service;
  return parsed;
}

// ── Injectable dependencies ──────────────────────────────────────────────────

export interface ZapRunResult {
  exitCode: number;
  timedOut: boolean;
}

export interface EntrypointDeps {
  discoverTargets: () => DiscoveredSecurityTarget[];
  /** Owned-host allowlist (config/den.yml + DEN_SECURITY_EXTRA_HOSTS). */
  ownedHosts: () => string[];
  loadEnvironment: (env: Environment) => Promise<SecurityEnvConfigLike>;
  /** Bearer token for an auth role (never called in dry-run or production). */
  getToken: (
    role: "admin" | "user" | "beta",
    env: Environment,
  ) => Promise<string>;
  /** Execute the plan; `childEnv` carries any credential (never argv). */
  runZap: (plan: ZapPlan, childEnv: NodeJS.ProcessEnv) => Promise<ZapRunResult>;
  mkdirp: (dir: string) => void;
  readFileIfExists: (filePath: string) => string | undefined;
  writeFile: (filePath: string, contents: string) => void;
  writeResult: (row: TestResult) => Promise<void>;
  /** Root under which reports/security/<env>/<run>/ is created. */
  reportsRoot: string;
  now: () => Date;
  log: (message: string) => void;
  logError: (message: string) => void;
  /** Whether the org counts an env as production (default: org config). */
  isProduction?: (env: string) => boolean;
}

/** Production wiring: real docker, real token minting, real result writer. */
export function defaultEntrypointDeps(): EntrypointDeps {
  return {
    discoverTargets: () => {
      const declared = discoverSecurityTargets();
      return readSecurityAutoTargets()
        ? [
            ...declared,
            ...autoSecurityTargets(listServicesWithManifests(), declared),
          ]
        : declared;
    },
    ownedHosts: () => ownedHostSuffixes(),
    loadEnvironment: async (env) => {
      const { envSelector } =
        await import("../../shared/environment/env-selector.js");
      return envSelector.loadEnvironment(env);
    },
    getToken: async (role, env) => {
      const { getApiToken } = await import("../../shared/auth/api-token.js");
      return getApiToken(role, env);
    },
    runZap: (plan, childEnv) =>
      new Promise<ZapRunResult>((resolve, reject) => {
        const child = spawn(plan.command, plan.args, {
          env: childEnv,
          stdio: "inherit",
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, plan.timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? -1, timedOut });
        });
      }),
    mkdirp: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
    },
    readFileIfExists: (filePath) =>
      fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined,
    writeFile: (filePath, contents) => fs.writeFileSync(filePath, contents),
    writeResult: async (row) => {
      const { resultWriter } =
        await import("../../shared/results/result-writer.js");
      await resultWriter.writeResult(row);
    },
    reportsRoot: path.join(getDistRoot(), "reports", "security"),
    now: () => new Date(),
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
  };
}

// ── Per-scan execution ───────────────────────────────────────────────────────

type ScanStatus = "clean" | "findings" | "infra";

interface ScanOutcome {
  status: ScanStatus;
  /** null when the scan itself failed. */
  findings: Finding[] | null;
  error?: string;
  reportDir: string;
}

/** ZAP exits 0/1/2 when the scan completed (1/2 = its own fail/warn). */
const ZAP_COMPLETED_EXIT_CODES: readonly number[] = [0, 1, 2];

/** One planned scan: a (service, mode, target, role) combination. */
interface ScanUnit {
  target: DiscoveredSecurityTarget;
  mode: SecurityMode;
  baseUrl: string;
  /** Undefined = unauthenticated. */
  role?: "admin" | "user" | "beta";
}

function scanLabel(unit: ScanUnit): string {
  return (
    `${securityTargetId(unit.target)} ${unit.mode} ${unit.baseUrl}` +
    (unit.role ? ` as ${unit.role}` : "") +
    (unit.target.auto ? " (auto: health URL)" : "")
  );
}

/** Replace any occurrence of `secret` in a persisted report file. */
function redactFile(
  filePath: string,
  secret: string | undefined,
  deps: EntrypointDeps,
): void {
  if (secret === undefined || secret.length === 0) return;
  const contents = deps.readFileIfExists(filePath);
  if (contents !== undefined && containsValue(contents, [secret])) {
    deps.writeFile(filePath, redactValues(contents, [secret]));
  }
}

async function executeScan(
  unit: ScanUnit,
  args: ParsedCliArgs,
  runDir: string,
  index: number,
  deps: EntrypointDeps,
): Promise<ScanOutcome> {
  const started = deps.now();
  const reportDir = path.join(
    runDir,
    `${String(index).padStart(2, "0")}-${unit.target.repoName}-` +
      `${unit.target.serviceName}-${unit.mode}${unit.role ? `-${unit.role}` : ""}`,
  );
  deps.log(`▶ scan ${scanLabel(unit)} — env=${args.env}`);

  let token: string | undefined;
  let counts: AlertCounts | undefined;
  let parsed: Finding[] | null = null;
  let status: ScanStatus = "infra";
  let error: string | undefined;

  try {
    deps.mkdirp(reportDir);
    if (unit.role !== undefined) {
      token = await deps.getToken(unit.role, args.env);
    }
    const spec = resolveOpenapi(
      unit.target.config.openapi,
      unit.baseUrl,
      unit.target.repoPath,
    );
    const plan = buildZapPlan({
      mode: unit.mode,
      target: unit.baseUrl,
      reportDir,
      ...(spec.file !== undefined ? { openapiFile: spec.file } : {}),
      ...(spec.url !== undefined ? { openapiUrl: spec.url } : {}),
      ...(unit.target.config.exclude !== undefined
        ? { exclude: unit.target.config.exclude }
        : {}),
      authenticated: token !== undefined,
    });
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    if (token !== undefined) childEnv[AUTH_HEADER_ENV] = `Bearer ${token}`;

    const result = await deps.runZap(plan, childEnv);
    if (result.timedOut) {
      throw new Error(`ZAP exceeded the ${plan.timeoutMs / 60_000}m cap.`);
    }
    if (!ZAP_COMPLETED_EXIT_CODES.includes(result.exitCode)) {
      throw new Error(`ZAP exited with code ${result.exitCode}.`);
    }

    // Belt and suspenders: ZAP shouldn't echo request headers into reports,
    // but a credential must never persist if it ever does.
    const jsonPath = path.join(reportDir, "report.json");
    const raw = deps.readFileIfExists(jsonPath);
    if (raw === undefined) throw new Error("ZAP wrote no report.json.");
    const report: unknown = JSON.parse(raw);
    counts = summarizeZapReport(report);
    parsed = parseZapReport(report);
    redactFile(jsonPath, token, deps);
    redactFile(path.join(reportDir, "report.html"), token, deps);
    status = scanFailed(counts) ? "findings" : "clean";
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const duration = deps.now().getTime() - started.getTime();
  const row: TestResult = {
    timestamp: started.toISOString(),
    pillar: "security",
    environment: args.env,
    test: `${securityTargetId(unit.target)}:${unit.mode}${unit.role ? `:${unit.role}` : ""}`,
    status: status === "clean" ? "passed" : "failed",
    duration,
    user: process.env.USER ?? "unknown",
    metadata: {
      mode: unit.mode,
      target: unit.baseUrl,
      authenticated: unit.role !== undefined,
      ...(unit.role !== undefined ? { role: unit.role } : {}),
      report_dir: reportDir,
      ...(counts !== undefined ? { alerts: counts } : {}),
      ...(status === "infra" ? { failure_kind: "infra_error" } : {}),
    },
  };
  if (error !== undefined) row.error = error;
  try {
    await deps.writeResult(row);
  } catch (writeError) {
    deps.logError(
      `Failed to persist result row: ` +
        `${writeError instanceof Error ? writeError.message : String(writeError)}`,
    );
    status = "infra";
  }

  deps.log(
    status === "clean"
      ? `✔ ${scanLabel(unit)} — no High alerts`
      : status === "findings"
        ? `✖ ${scanLabel(unit)} — ${counts?.high ?? 0} High, ` +
          `${counts?.medium ?? 0} Medium alert(s); report: ${reportDir}`
        : `✖ ${scanLabel(unit)} — infra error: ${error ?? "unknown"}`,
  );
  return {
    status,
    findings: status === "infra" ? null : parsed,
    ...(error !== undefined ? { error } : {}),
    reportDir,
  };
}

/** The id a scan unit has in a run summary (one row per URL and role). */
function unitId(unit: ScanUnit): string {
  return securityTargetId(unit.target) + (unit.role ? ` as ${unit.role}` : "");
}

/**
 * Write each mode's run summary and point <env>/latest-<mode>.json at it,
 * marking the findings the previous run of the same row did not have.
 */
function writeRunSummaries(
  units: ScanUnit[],
  outcomes: ScanOutcome[],
  env: Environment,
  runDir: string,
  startedAt: Date,
  deps: EntrypointDeps,
): void {
  const modes = [...new Set(units.map((u) => u.mode))];
  for (const mode of modes) {
    const latest = latestSummaryPath(deps.reportsRoot, env, mode);
    let previous: ScanSummary | null = null;
    try {
      const raw = deps.readFileIfExists(latest);
      previous = raw === undefined ? null : (JSON.parse(raw) as ScanSummary);
    } catch {
      previous = null;
    }
    const results: TargetResult[] = [];
    units.forEach((unit, i) => {
      if (unit.mode !== mode) return;
      const o = outcomes[i];
      const id = unitId(unit);
      const prev = previous?.results.find(
        (r) => r.id === id && r.url === unit.baseUrl,
      )?.findings;
      results.push({
        id,
        repo: unit.target.repoName,
        service: unit.target.serviceName,
        org: "",
        url: unit.baseUrl,
        findings: o.findings,
        ...(o.error !== undefined ? { error: o.error } : {}),
        ...(o.findings ? { newSince: newFindings(o.findings, prev) } : {}),
        ...(o.findings
          ? {
              report: path.relative(
                deps.reportsRoot,
                path.join(o.reportDir, "report.html"),
              ),
            }
          : {}),
      });
    });
    const summary: ScanSummary = {
      id: `${path.basename(runDir)}-${env}-${mode}`,
      env,
      mode,
      startedAt: startedAt.toISOString(),
      finishedAt: deps.now().toISOString(),
      results,
    };
    const body = JSON.stringify(summary, null, 2);
    try {
      deps.writeFile(path.join(runDir, `summary-${mode}.json`), body);
      deps.writeFile(latest, body);
    } catch (error) {
      deps.logError(
        `Failed to write the run summary: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// ── CLI orchestration ────────────────────────────────────────────────────────

/** Filter discovered targets by --service ("<repo>/<name>" or bare name). */
function filterTargets(
  targets: DiscoveredSecurityTarget[],
  service: string,
): DiscoveredSecurityTarget[] {
  return service.includes("/")
    ? targets.filter((t) => securityTargetId(t) === service)
    : targets.filter((t) => t.serviceName === service);
}

/**
 * Run the security pillar once against one environment. Returns the
 * process exit code (see the EXIT_* constants).
 */
export async function runSecurityCli(
  argv: readonly string[],
  deps: EntrypointDeps = defaultEntrypointDeps(),
): Promise<number> {
  let args: ParsedCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    deps.logError(error instanceof Error ? error.message : String(error));
    return EXIT_INFRA_ERROR;
  }

  const ceiling = MODE_CEILING[args.env];
  if (ceiling.length === 0) {
    deps.logError(`Security scans are not supported for env "${args.env}".`);
    return EXIT_INFRA_ERROR;
  }
  if (args.env === "production" && process.env.DEN_ALLOW_PROD !== "1") {
    deps.logError(
      `Refusing to scan production without ${envKey("ALLOW_PROD")}=1. ` +
        "Production scans are passive (baseline) only — set it to confirm " +
        "an authorized run.",
    );
    return EXIT_INFRA_ERROR;
  }
  if (args.mode !== "all" && !ceiling.includes(args.mode)) {
    deps.logError(
      `Mode "${args.mode}" is not permitted in ${args.env} ` +
        `(allowed: ${ceiling.join(", ")}). Refusing rather than downgrading.`,
    );
    return EXIT_INFRA_ERROR;
  }

  let targets: DiscoveredSecurityTarget[];
  try {
    targets = deps.discoverTargets();
  } catch (error) {
    deps.logError(
      `Security target discovery failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_INFRA_ERROR;
  }
  if (args.service !== undefined) {
    targets = filterTargets(targets, args.service);
  }
  if (targets.length === 0) {
    deps.logError(
      "No security targets discovered" +
        (args.service ? ` matching "${args.service}"` : "") +
        ". Add the repo to the active workspace and check the security: " +
        `block in its ${product().manifestYml} (or manifests/<repo>${product().manifestYml}) — ` +
        "zero targets is never a pass.",
    );
    return EXIT_NO_TARGETS;
  }

  let envConfig: SecurityEnvConfigLike;
  try {
    envConfig = await deps.loadEnvironment(args.env);
  } catch (error) {
    deps.logError(
      `Failed to load environment "${args.env}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_INFRA_ERROR;
  }

  // Expand to concrete scans. Target/host resolution errors are config
  // mistakes (e.g. a non-owned host) and abort the whole run loudly.
  const units: ScanUnit[] = [];
  try {
    const suffixes = deps.ownedHosts();
    const isProduction =
      deps.isProduction ?? ((e: string) => isProductionEnv(e));
    for (const target of targets) {
      // R13: a remote service whose target env counts as production is never
      // scanned; any other remote one is scanned only in its own env, never
      // as if it ran locally.
      const placed = target.placement;
      if (placed?.runs === "remote" && placed.target) {
        const where = placed.target.env;
        if (isProtectedRemote(placed, isProduction)) {
          deps.log(
            `↷ skipping ${securityTargetId(target)}: runs in ${where}, which counts as production`,
          );
          continue;
        }
        if (args.env === "local") {
          deps.log(
            `↷ skipping ${securityTargetId(target)}: runs in ${where}, not on this machine`,
          );
          continue;
        }
      }
      // A target that declares no host for THIS env (e.g. only staging/prod)
      // is simply not in scope here — skip it, never abort the batch.
      const inEnv =
        (target.config.hosts?.[args.env]?.length ?? 0) > 0 ||
        target.config.baseUrlKey !== undefined;
      if (!inEnv) {
        deps.log(
          `↷ skipping ${securityTargetId(target)}: not deployed in ${args.env}`,
        );
        continue;
      }
      const modes = allowedModes(target.config, args.env).filter(
        (m) => args.mode === "all" || m === args.mode,
      );
      if (modes.length === 0) {
        deps.log(
          `↷ skipping ${securityTargetId(target)}: mode "${args.mode}" is ` +
            `not allowed for it in ${args.env}`,
        );
        continue;
      }
      const baseUrls = resolveTargets(
        target.config,
        args.env,
        envConfig,
        suffixes,
      );
      // Production: unauthenticated passive scan only (see module header).
      const roles =
        args.env === "production" || !target.config.auth?.length
          ? [undefined]
          : target.config.auth;
      for (const mode of modes) {
        if (mode === "api" && target.config.openapi === undefined) {
          deps.log(
            `↷ skipping ${securityTargetId(target)} api: no openapi declared`,
          );
          continue;
        }
        for (const baseUrl of baseUrls) {
          for (const role of roles) {
            units.push({
              target,
              mode,
              baseUrl,
              ...(role !== undefined ? { role } : {}),
            });
          }
        }
      }
    }
  } catch (error) {
    deps.logError(
      `Security plan refused: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_INFRA_ERROR;
  }

  if (units.length === 0) {
    // An explicitly-named service with nothing to run here (not deployed in
    // this env, or every mode filtered out) is a benign skip — exit clean so a
    // per-service batch does not abort on it. "All targets" resolving to
    // nothing stays loud (never silent green).
    if (args.service !== undefined) {
      deps.log(
        `↷ ${args.service}: nothing to scan in env "${args.env}" — skipped.`,
      );
      return EXIT_CLEAN;
    }
    deps.logError(
      `0 scans runnable for env "${args.env}" — nothing ran (never silent green).`,
    );
    return EXIT_NO_TARGETS;
  }

  if (args.dryRun) {
    for (const unit of units) {
      try {
        const spec = resolveOpenapi(
          unit.target.config.openapi,
          unit.baseUrl,
          unit.target.repoPath,
        );
        const plan = buildZapPlan({
          mode: unit.mode,
          target: unit.baseUrl,
          reportDir: "<report-dir>",
          ...(spec.file !== undefined ? { openapiFile: spec.file } : {}),
          ...(spec.url !== undefined ? { openapiUrl: spec.url } : {}),
          ...(unit.target.config.exclude !== undefined
            ? { exclude: unit.target.config.exclude }
            : {}),
          authenticated: unit.role !== undefined,
        });
        deps.log(
          `[dry-run] ${scanLabel(unit)}\n  ${plan.command} ${plan.args.join(" ")}`,
        );
      } catch (error) {
        deps.logError(
          `[dry-run] ${scanLabel(unit)} unrunnable: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return EXIT_INFRA_ERROR;
      }
    }
    deps.log(`[dry-run] ${units.length} scan(s) planned — nothing executed.`);
    return EXIT_CLEAN;
  }

  const startedAt = deps.now();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(deps.reportsRoot, args.env, stamp);
  const outcomes: ScanOutcome[] = [];
  for (const [index, unit] of units.entries()) {
    outcomes.push(await executeScan(unit, args, runDir, index, deps));
  }
  writeRunSummaries(units, outcomes, args.env, runDir, startedAt, deps);
  const statuses = outcomes.map((o) => o.status);

  const infra = statuses.filter((s) => s === "infra").length;
  const findings = statuses.filter((s) => s === "findings").length;
  deps.log(
    `security: ${statuses.length - infra - findings} clean, ${findings} ` +
      `with High alerts, ${infra} infra error(s) — env=${args.env}`,
  );

  // Infra errors dominate: the result set is unreliable, not merely red.
  if (infra > 0) return EXIT_INFRA_ERROR;
  if (findings > 0) return EXIT_FINDINGS;
  return EXIT_CLEAN;
}

// ── Main-module gate ─────────────────────────────────────────────────────────

// No import.meta here: ts-jest compiles this module to CJS for the unit
// tests, where import.meta is a syntax error (same constraint as journeys).
const isMainModule = /[\\/]pillars[\\/]security[\\/]run\.(ts|js)$/.test(
  process.argv[1] ?? "",
);

if (isMainModule) {
  runSecurityCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      process.exitCode = EXIT_INFRA_ERROR;
    });
}
