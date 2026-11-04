/**
 * Journeys CLI entrypoint (plan: jrn-pilot-journeys packet).
 *
 *   npx tsx src/pillars/journeys/run.ts --env=<env> [--journey=<repo/name>]
 *
 * `--journey` accepts a repo-qualified "<repo>/<name>" (exact) or a bare
 * spec name; bare names duplicated across repos are refused loudly.
 *
 * The FIRST executable surface of the journeys pillar — every library
 * packet (runner, verifier, reporting, teardown) already landed, and this
 * module only orchestrates them:
 *
 * - `--env` is REQUIRED and exactly one environment per invocation
 *   (Approach §Explicit environment targeting; the make targets add the
 *   command-line-origin guard on top).
 * - Discovery is manifest-driven via discoverJourneySpecs() — specs live
 *   in registered repos (the app's own repo), never a den-local dir. Specs whose
 *   `environments` allowlist excludes the target env are skipped with a
 *   logged reason; zero runnable specs exits with the distinct loud code
 *   {@link EXIT_NO_SPECS} — never silent green.
 * - Per journey, the STRICT order is runJourney → verify → collect report
 *   → teardown (in finally, strictly AFTER the verification probes so they
 *   observe created state) → finalize report (teardown warnings folded
 *   in). Reporting is guaranteed in the same finally on every outcome.
 * - Sequential in v1; exit codes: 0 all passed / 1 infra error / 2 any
 *   journey failed / 3 no specs discovered.
 * - In-process transcript secret scan: the secrets captured for the run
 *   are compared FROM MEMORY against the persisted transcript artifacts —
 *   they never pass through argv or a child process. A hit fails the
 *   journey as infra_error (belt and suspenders over the runner's
 *   persist-path scrubber).
 */

import * as fs from "fs";
import * as path from "path";
import type { Environment } from "../../shared/types/index.js";
import {
  discoverJourneySpecs,
  type DiscoveredJourneySpec,
} from "./discover.js";
import { extractFrictionPoints } from "./report/friction.js";
import {
  collectJourneyReport,
  finalizeJourneyReport,
  type CollectedJourneyReport,
} from "./report/results.js";
import {
  writeJourneysJUnitXml,
  type JourneysJUnitCase,
} from "./report/junit.js";
import {
  runJourney,
  type RunnerDeps,
  type RunnerEnvConfigLike,
  type RunOutcome,
} from "./runner.js";
import type { JourneyPersonaRole, JourneySpec } from "./spec/schema.js";
import type { JourneysSessionTokenConfig } from "./app-config.js";
import type { CapturedSecrets } from "./sandbox.js";
import type { SessionApiToken } from "./tools/browser-session.js";
import { teardownLedger, type TeardownReport } from "./teardown.js";
import { allowedBaseUrlsFromEnv } from "./tools/http-tool.js";
import type { RunLedger } from "./tools/ledger.js";
import {
  buildVerifierProbeClient,
  type VerifierProbeClient,
  type VerifierProbeClientOptions,
} from "./verify/assertions.js";
import { verifyJourney, type Verdict } from "./verify/verdict.js";

import { product } from "../../shared/product.js";
// ── Exit codes ───────────────────────────────────────────────────────────────

export const EXIT_ALL_PASSED = 0;
export const EXIT_INFRA_ERROR = 1;
export const EXIT_JOURNEY_FAILED = 2;
/** Zero specs discovered/runnable — loud and distinct, never silent green. */
export const EXIT_NO_SPECS = 3;

// ── CLI args ─────────────────────────────────────────────────────────────────

const KNOWN_ENVIRONMENTS: readonly Environment[] = [
  "local",
  "dev",
  "sandbox",
  "staging",
  "beta",
  "prod",
  "production",
];

/** Operator/usage mistake — maps to {@link EXIT_INFRA_ERROR}. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export interface ParsedCliArgs {
  env: Environment;
  journey?: string;
}

/**
 * Parse `--env=<env> [--journey=<name>]`. `--env` is required and must
 * appear exactly once (one environment per invocation); unknown arguments
 * are rejected loudly rather than ignored.
 */
export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const envValues: string[] = [];
  let journey: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--env=")) {
      envValues.push(arg.slice("--env=".length));
    } else if (arg.startsWith("--journey=")) {
      journey = arg.slice("--journey=".length);
    } else {
      throw new CliUsageError(
        `Unrecognized argument "${arg}". ` +
          "Usage: run.ts --env=<env> [--journey=<name>]",
      );
    }
  }

  if (envValues.length === 0) {
    throw new CliUsageError(
      "--env is required (exactly one environment per invocation). " +
        "Usage: run.ts --env=<env> [--journey=<name>]",
    );
  }
  if (envValues.length > 1) {
    throw new CliUsageError(
      "Exactly one --env per invocation — journeys never fan out across " +
        `environments (got: ${envValues.join(", ")}).`,
    );
  }

  const env = envValues[0];
  if (!(KNOWN_ENVIRONMENTS as readonly string[]).includes(env)) {
    throw new CliUsageError(
      `Unknown environment "${env}". Known: ${KNOWN_ENVIRONMENTS.join(", ")}.`,
    );
  }

  const parsed: ParsedCliArgs = { env: env as Environment };
  if (journey !== undefined) {
    parsed.journey = journey;
  }
  return parsed;
}

// ── Secret scan ──────────────────────────────────────────────────────────────

/**
 * In-process scan: does `contents` contain any live secret value? Values
 * are compared from memory — never serialized to argv, a temp file, or a
 * child process. Empty values are ignored (they would match everything).
 */
export function transcriptContainsSecret(
  contents: string,
  secrets: readonly string[],
): boolean {
  return secrets.some(
    (secret) => secret.length > 0 && contents.includes(secret),
  );
}

// ── Injectable dependencies ──────────────────────────────────────────────────

export interface EntrypointDeps {
  discoverSpecs: () => DiscoveredJourneySpec[];
  loadEnvironment: (env: Environment) => Promise<RunnerEnvConfigLike>;
  /**
   * The persona-secret source (Cursor key only). The entrypoint passes a
   * caching wrapper of this into runJourney's deps so the captured value
   * remains available — in memory only — for the transcript secret scan.
   */
  captureSecrets: (
    role: JourneyPersonaRole,
    env: Environment,
  ) => Promise<CapturedSecrets>;
  /**
   * Derive the API assertion token + session headers from the browser
   * session. The entrypoint passes a caching wrapper into runJourney's deps
   * so the SAME real-user token + headers back the verifier probe client and
   * the teardown client — one credential for navigation and assertions.
   */
  deriveApiToken: (
    authFilePath: string,
    env: Environment,
    sessionToken?: JourneysSessionTokenConfig,
  ) => Promise<SessionApiToken>;
  runJourney: (
    spec: JourneySpec,
    env: Environment,
    deps: Partial<RunnerDeps>,
  ) => Promise<RunOutcome>;
  buildProbeClient: (
    options: VerifierProbeClientOptions,
  ) => VerifierProbeClient;
  verifyJourney: typeof verifyJourney;
  teardownLedger: typeof teardownLedger;
  collectReport: typeof collectJourneyReport;
  finalizeReport: (
    collected: CollectedJourneyReport,
    teardown: TeardownReport | undefined,
  ) => ReturnType<typeof finalizeJourneyReport>;
  writeJUnit: (cases: readonly JourneysJUnitCase[]) => Promise<string>;
  extractFriction: typeof extractFrictionPoints;
  /** Read a text file, or undefined when it does not exist. */
  readFileIfExists: (filePath: string) => string | undefined;
  log: (message: string) => void;
  logError: (message: string) => void;
}

function defaultReadFileIfExists(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, "utf8");
}

/** Production wiring — every collaborator is the real den machinery. */
export function defaultEntrypointDeps(): EntrypointDeps {
  return {
    discoverSpecs: () => discoverJourneySpecs(),
    loadEnvironment: async (env) => {
      const { envSelector } =
        await import("../../shared/environment/env-selector.js");
      return envSelector.loadEnvironment(env);
    },
    captureSecrets: async (role, env) => {
      const { captureSecrets } = await import("./sandbox.js");
      return captureSecrets(role, env);
    },
    deriveApiToken: async (authFilePath, env, sessionToken) => {
      const { deriveApiTokenFromSession } =
        await import("./tools/browser-session.js");
      return deriveApiTokenFromSession(authFilePath, env, sessionToken);
    },
    runJourney,
    buildProbeClient: buildVerifierProbeClient,
    verifyJourney,
    teardownLedger,
    collectReport: collectJourneyReport,
    finalizeReport: (collected, teardown) =>
      finalizeJourneyReport(collected, teardown),
    writeJUnit: (cases) => writeJourneysJUnitXml(cases),
    extractFriction: extractFrictionPoints,
    readFileIfExists: defaultReadFileIfExists,
    log: (message) => console.log(message),
    logError: (message) => console.error(message),
  };
}

// ── Per-journey execution ────────────────────────────────────────────────────

type JourneyStatus = "passed" | "failed" | "infra";

interface JourneyExecution {
  status: JourneyStatus;
  junitCase?: JourneysJUnitCase;
}

/** Parse the persisted transcript JSONL into lines for friction analysis. */
function parseTranscriptLines(contents: string | undefined): unknown[] {
  if (contents === undefined) return [];
  const lines: unknown[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // Non-JSON lines carry no structured signal; friction skips them.
    }
  }
  return lines;
}

function statusOf(verdict: Verdict): JourneyStatus {
  if (verdict.passed) return "passed";
  return verdict.failure_kind === "infra_error" ? "infra" : "failed";
}

async function executeJourney(
  discovered: DiscoveredJourneySpec,
  env: Environment,
  envConfig: RunnerEnvConfigLike,
  deps: EntrypointDeps,
): Promise<JourneyExecution> {
  const { spec } = discovered;
  deps.log(`▶ journey ${spec.name} (${spec.surface}) — env=${env}`);

  // Held in memory for verify/teardown/scan; populated by the caching
  // wrappers the runner invokes during its provisioning phase.
  let secrets: CapturedSecrets | undefined;
  let sessionToken: SessionApiToken | undefined;
  const cachingCaptureSecrets = async (
    role: JourneyPersonaRole,
    targetEnv: Environment,
  ): Promise<CapturedSecrets> => {
    secrets = await deps.captureSecrets(role, targetEnv);
    return secrets;
  };
  // The browser-session-derived API token + headers. Cached
  // here so the verifier probe client and teardown client reuse the SAME
  // real-user credential the agent navigated with.
  const cachingDeriveApiToken = async (
    authFilePath: string,
    targetEnv: Environment,
    sessionTokenConfig?: JourneysSessionTokenConfig,
  ): Promise<SessionApiToken> => {
    sessionToken = await deps.deriveApiToken(
      authFilePath,
      targetEnv,
      sessionTokenConfig,
    );
    return sessionToken;
  };

  let outcome: RunOutcome | undefined;
  let verdict: Verdict | undefined;
  let collected: CollectedJourneyReport | undefined;
  let junitCase: JourneysJUnitCase | undefined;
  let crashed: Error | undefined;

  const buildClient = (): VerifierProbeClient =>
    deps.buildProbeClient({
      allowedBaseUrls: allowedBaseUrlsFromEnv(envConfig),
      tokenProvider: async () => {
        if (sessionToken === undefined) {
          throw new Error(
            "No session API token available — runJourney never derived one",
          );
        }
        return sessionToken.apiToken;
      },
      headersProvider: async () => {
        if (sessionToken === undefined) {
          throw new Error(
            "No session headers available — runJourney never derived them",
          );
        }
        return sessionToken.headers;
      },
    });

  try {
    outcome = await deps.runJourney(spec, env, {
      captureSecrets: cachingCaptureSecrets,
      deriveApiToken: cachingDeriveApiToken,
      app: discovered.app,
    });

    // Post-ledger runner failures come back as outcomes carrying the
    // ledger (review finding 8) — loud in the log, and the normal
    // verify → report → teardown pipeline below still runs.
    if (outcome.error !== undefined) {
      deps.logError(
        `✖ journey ${spec.name} run error (${outcome.failure_kind ?? "unknown"}): ${outcome.error}`,
      );
    }

    // Verification probes run strictly BEFORE teardown so they observe
    // the created state; even a failed run gets probed for diagnostics.
    verdict = await deps.verifyJourney(
      spec.success.assertions,
      outcome,
      buildClient(),
    );

    // In-process secret scan over the persisted transcript artifacts
    // (JSONL + rendered markdown), secrets compared from memory.
    const transcriptContents = deps.readFileIfExists(outcome.transcriptPath);
    const renderedContents = deps.readFileIfExists(
      path.join(path.dirname(outcome.transcriptPath), "transcript.md"),
    );
    // The event log is scrubbed at emit time by the bus, but scan it here
    // too — defense in depth alongside the transcript scan (same failure
    // mode: a live secret in a persisted artifact fails the run closed).
    const eventsContents = deps.readFileIfExists(outcome.eventsPath);
    const secretValues = [secrets?.cursorApiKey, sessionToken?.apiToken].filter(
      (value): value is string => value !== undefined,
    );
    const leaked = [transcriptContents, renderedContents, eventsContents].some(
      (contents) =>
        contents !== undefined &&
        transcriptContainsSecret(contents, secretValues),
    );
    if (leaked) {
      deps.logError(
        `✖ journey ${spec.name}: a live secret value was found in the ` +
          "persisted transcript — failing closed as infra_error.",
      );
      outcome.failure_kind = "infra_error";
      verdict = { ...verdict, passed: false, failure_kind: "infra_error" };
    }

    const friction = deps.extractFriction({
      transcript: parseTranscriptLines(transcriptContents),
      snapshotIndex: outcome.snapshotIndex,
      budgets: spec.budgets,
    });

    collected = deps.collectReport({
      spec,
      env,
      outcome,
      verdict,
      frictionPoints: friction,
    });
  } catch (error) {
    crashed = error instanceof Error ? error : new Error(String(error));
    deps.logError(`✖ journey ${spec.name} crashed: ${crashed.message}`);
  } finally {
    // Teardown strictly AFTER verification; a run that never produced an
    // outcome has no ledger to tear down (and nothing persisted to report).
    let teardown: TeardownReport | undefined;
    // Teardown needs the session-derived token/headers to authenticate its
    // DELETE probes; skip cleanly if the run never got that far.
    if (outcome !== undefined && sessionToken !== undefined) {
      try {
        teardown = await deps.teardownLedger(
          outcome.ledger as RunLedger,
          async (request) => {
            const response = await buildClient()({
              method: request.method as
                | "GET"
                | "POST"
                | "PUT"
                | "PATCH"
                | "DELETE",
              path: request.path,
            });
            return { status: response.status };
          },
        );
      } catch (error) {
        deps.logError(
          `✖ journey ${spec.name} teardown crashed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        crashed ??= error instanceof Error ? error : new Error(String(error));
      }
    }

    // Reporting guaranteed on every outcome: when the pipeline crashed
    // after producing an outcome, persist a failed infra report anyway.
    if (outcome !== undefined) {
      if (collected === undefined) {
        verdict = {
          passed: false,
          failure_kind: outcome.failure_kind ?? "infra_error",
          results: [],
        };
        collected = deps.collectReport({
          spec,
          env,
          outcome,
          verdict,
          frictionPoints: [],
        });
      }
      try {
        const finalized = await deps.finalizeReport(collected, teardown);
        junitCase = finalized.junitCase;
        deps.log(`  report: ${finalized.reportPath}`);
        // Point operators at the structured timeline for post-mortem; the
        // report embeds it too, but the raw JSONL is the forensic source.
        if (outcome !== undefined) {
          deps.log(`  events: ${outcome.eventsPath}`);
        }
      } catch (error) {
        deps.logError(
          `✖ journey ${spec.name} report finalization failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        crashed ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  if (crashed !== undefined || verdict === undefined) {
    const execution: JourneyExecution = { status: "infra" };
    if (junitCase !== undefined) execution.junitCase = junitCase;
    return execution;
  }

  const status = statusOf(verdict);
  deps.log(
    status === "passed"
      ? `✔ journey ${spec.name} passed`
      : `✖ journey ${spec.name} ${status === "infra" ? "hit an infra error" : "failed"}` +
          (verdict.failure_kind !== undefined
            ? ` (failure_kind=${verdict.failure_kind})`
            : ""),
  );
  const execution: JourneyExecution = { status };
  if (junitCase !== undefined) execution.junitCase = junitCase;
  return execution;
}

// ── CLI orchestration ────────────────────────────────────────────────────────

/**
 * Run the journeys pillar once against one environment. Returns the
 * process exit code (see the EXIT_* constants).
 */
export async function runJourneysCli(
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

  let discovered: DiscoveredJourneySpec[];
  try {
    discovered = deps.discoverSpecs();
  } catch (error) {
    deps.logError(
      `Journey spec discovery failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_INFRA_ERROR;
  }

  // Repo-qualified filtering (review finding 10): --journey accepts
  // "<repo>/<name>" (exact) or a bare name — bare names must be
  // unambiguous across repos, else the run refuses loudly instead of
  // executing an arbitrary duplicate.
  if (args.journey !== undefined) {
    const requested = args.journey;
    const slash = requested.indexOf("/");
    if (slash !== -1) {
      const repo = requested.slice(0, slash);
      const name = requested.slice(slash + 1);
      discovered = discovered.filter(
        (entry) => entry.repoName === repo && entry.spec.name === name,
      );
      if (discovered.length === 0) {
        deps.logError(
          `No discovered journey "${name}" in repo "${repo}". Check the ` +
            "spec name and that the repo is registered (make register-repos).",
        );
        return EXIT_NO_SPECS;
      }
    } else {
      const matches = discovered.filter(
        (entry) => entry.spec.name === requested,
      );
      if (matches.length === 0) {
        deps.logError(
          `No discovered journey named "${requested}". Check the spec name ` +
            "and that its repo is registered (make register-repos).",
        );
        return EXIT_NO_SPECS;
      }
      const repos = [...new Set(matches.map((entry) => entry.repoName))];
      if (repos.length > 1) {
        deps.logError(
          `Journey name "${requested}" is ambiguous — declared by repos ` +
            `[${repos.join(", ")}]. Qualify it as <repo>/<name> ` +
            `(e.g. --journey=${repos[0]}/${requested}).`,
        );
        return EXIT_INFRA_ERROR;
      }
      discovered = matches;
    }
  }

  if (discovered.length === 0) {
    deps.logError(
      "No journey specs discovered across registered repos. Register the " +
        `spec-hosting repo (make register-repos) and check its ${product().manifestYml} ` +
        "journeys: block — zero specs is never a pass.",
    );
    return EXIT_NO_SPECS;
  }

  const runnable: DiscoveredJourneySpec[] = [];
  for (const entry of discovered) {
    if (entry.spec.environments.includes(args.env)) {
      runnable.push(entry);
    } else {
      deps.log(
        `↷ skipping ${entry.spec.name}: environments allowlist ` +
          `[${entry.spec.environments.join(", ")}] excludes "${args.env}"`,
      );
    }
  }

  if (runnable.length === 0) {
    deps.logError(
      `0 of ${discovered.length} discovered journeys allow env "${args.env}" ` +
        "— nothing ran (never silent green).",
    );
    return EXIT_NO_SPECS;
  }

  let envConfig: RunnerEnvConfigLike;
  try {
    envConfig = await deps.loadEnvironment(args.env);
  } catch (error) {
    deps.logError(
      `Failed to load environment "${args.env}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_INFRA_ERROR;
  }

  // Sequential in v1 — one agent, one browser context at a time.
  const executions: JourneyExecution[] = [];
  for (const entry of runnable) {
    executions.push(await executeJourney(entry, args.env, envConfig, deps));
  }

  const junitCases = executions.flatMap((execution) =>
    execution.junitCase !== undefined ? [execution.junitCase] : [],
  );
  if (junitCases.length > 0) {
    try {
      const junitPath = await deps.writeJUnit(junitCases);
      deps.log(`JUnit: ${junitPath}`);
    } catch (error) {
      deps.logError(
        `Failed to write the JUnit report: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return EXIT_INFRA_ERROR;
    }
  }

  const infra = executions.filter((e) => e.status === "infra").length;
  const failed = executions.filter((e) => e.status === "failed").length;
  const passedCount = executions.length - infra - failed;
  deps.log(
    `journeys: ${passedCount} passed, ${failed} failed, ${infra} infra ` +
      `error(s) — env=${args.env}`,
  );

  // Infra errors dominate: the result set is unreliable, not merely red.
  if (infra > 0) return EXIT_INFRA_ERROR;
  if (failed > 0) return EXIT_JOURNEY_FAILED;
  return EXIT_ALL_PASSED;
}

// ── Main-module gate ─────────────────────────────────────────────────────────

// No import.meta here: ts-jest compiles this module to CJS for the unit
// tests, where import.meta is a syntax error. Matching argv[1] against this
// module's stable repo path keeps the gate inert under jest (argv[1] is the
// jest binary) while firing under `npx tsx src/pillars/journeys/run.ts`.
const isMainModule = /[\\/]pillars[\\/]journeys[\\/]run\.(ts|js)$/.test(
  process.argv[1] ?? "",
);

if (isMainModule) {
  runJourneysCli(process.argv.slice(2))
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
