/**
 * Journeys runner — runJourney(spec, env, deps): one @cursor/sdk local
 * agent per journey, confined to the mounted custom tools with shell
 * denied by the beforeShellExecution hook (the OS sandbox is disabled —
 * it blocks the custom-tool MCP calls; see the Agent.create call below).
 * (plan: jrn-runner packet). Library only: no CLI
 * entrypoint, no teardown invocation — the caller (jrn-pilot-journeys)
 * orchestrates runJourney → verify → report → teardown.
 *
 * Isolation ordering (load-bearing, pinned by tests/unit/journeys/
 * isolation.test.ts): captureSecrets → provisionBrowserSession (browser|
 * mixed surfaces — getCredentials/headlessLogin read E2E_* env vars in CI)
 * → sanitizeEnvironment → Agent.create (apiKey passed explicitly); env
 * restored and agent + browser context disposed in finally.
 *
 * Budgets are FAIL-CLOSED (Approach §Budget enforcement):
 * - max_turns counts the guaranteed turn-ended InteractionUpdate (onDelta),
 *   never optional usage events;
 * - max_total_tokens is enforced on ONE monotonic cumulative total at
 *   each turn-ended, reconciled via max() across per-turn payload sums
 *   and the run handle's cumulative usage (never undercounts after a
 *   missing-usage turn);
 * - a turn-ended with NO usage and NO cumulative run.usage cancels the run
 *   as budget_unverifiable — unverifiable spend never continues;
 * - timeout_s is a harness wall-clock timer → run.cancel().
 *
 * Failure kinds are disjoint: policy refusals THROW JourneyPolicyError
 * (caller bugs, not run outcomes); CursorAgentError at startup →
 * infra_error; result.status === "error" → agent_error; budget
 * cancellations → budget_exceeded / budget_unverifiable; transcript secret
 * leaks → infra_error. RunOutcome deliberately has NO pass field — the
 * deterministic verifier (jrn-verifier) is the sole pass/fail authority.
 */

import * as fs from "fs";
import * as path from "path";
import { getDistRoot } from "../../shared/paths.js";
import { CursorAgentError, type SDKMessage } from "@cursor/sdk";
import { envSelector } from "../../shared/environment/env-selector.js";
import type { Environment } from "../../shared/types/index.js";
import {
  captureSecrets as defaultCaptureSecrets,
  prepareSandbox as defaultPrepareSandbox,
  sanitizeEnvironment as defaultSanitizeEnvironment,
  SecretLeakError,
  TranscriptScrubber,
  TranscriptWriter,
  type CapturedSecrets,
  type SanitizeResult,
  type StagedSandbox,
} from "./sandbox.js";
import type { JourneyPersonaRole, JourneySpec } from "./spec/schema.js";
import {
  provisionBrowserSession as defaultProvisionBrowserSession,
  deriveApiTokenFromSession as defaultDeriveApiToken,
  type SessionApiToken,
} from "./tools/browser-session.js";
import {
  buildBrowserToolset as defaultBuildBrowserToolset,
  type BrowserToolset,
  type BrowserToolsetOptions,
} from "./tools/browser-tool.js";
import {
  allowedBaseUrlsFromEnv,
  allowedMethodsForSurface,
  buildScopedHttpTool as defaultBuildHttpTool,
  HTTP_TOOL_NAME,
  type ScopedHttpToolOptions,
} from "./tools/http-tool.js";
import { RunLedger } from "./tools/ledger.js";
import {
  ledgerRegistryFromApp,
  type JourneysAppConfig,
  type JourneysSessionTokenConfig,
} from "./app-config.js";
import {
  SnapshotStore,
  type SnapshotIndexEntry,
} from "./tools/snapshot-store.js";
import {
  JourneyEventBus,
  type JourneyEvent,
  type JourneyEventSink,
} from "./observability/events.js";
import {
  createMapperState,
  flushAssistantText,
  sdkMessageToEvents,
} from "./observability/sdk-mapper.js";

// ── SDK-facing structural types (unit tests provide plain fakes) ────────────

/** Cumulative token usage as reported by the SDK run. */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

/** Per-turn usage payload on a turn-ended InteractionUpdate. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

/** Structural subset of the SDK's InteractionUpdate the runner consumes. */
export interface InteractionUpdateLike {
  type: string;
  usage?: TurnUsage;
}

export interface RunResultLike {
  status: string;
  result?: string;
  error?: { message: string; code?: string };
  usage?: RunUsage;
  durationMs?: number;
}

export interface AgentRunLike {
  stream(): AsyncGenerator<unknown, void>;
  wait(): Promise<RunResultLike>;
  cancel(): Promise<void>;
  readonly usage?: RunUsage;
}

export interface AgentSendOptionsLike {
  onDelta: (args: { update: InteractionUpdateLike }) => void | Promise<void>;
}

export interface AgentLike {
  send(message: string, options: AgentSendOptionsLike): Promise<AgentRunLike>;
  close(): void;
}

/** Options the runner passes to Agent.create (structural subset). */
export interface AgentCreateOptionsLike {
  apiKey: string;
  model: { id: string };
  local: {
    cwd: string;
    // Load the staged `.cursor/` config (hooks.json + permissions.json).
    // Defaults to [] ("inline only") in the SDK, which would ignore the
    // sandbox's shell-deny hook AND the custom-tools mcpAllowlist.
    settingSources: string[];
    sandboxOptions: { enabled: boolean };
    customTools: Record<string, unknown>;
  };
}

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * A journey was refused before anything ran: production target, env not in
 * the spec's allowlist, no model (neither spec `model` nor JOURNEYS_MODEL),
 * or a spec without budgets.
 * Thrown (never a RunOutcome) — these are operator/config mistakes.
 */
export class JourneyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JourneyPolicyError";
  }
}

// ── Runner deps / outcome ────────────────────────────────────────────────────

export type FailureKind =
  | "infra_error"
  | "agent_error"
  | "budget_exceeded"
  | "budget_unverifiable";

export interface RunOutcome {
  runId: string;
  transcriptPath: string;
  /** Absolute path of the structured harness event log (events.jsonl). */
  eventsPath: string;
  /** Structured timeline (tool calls, bindings, denials, agent error). */
  events: readonly JourneyEvent[];
  snapshotIndex: readonly SnapshotIndexEntry[];
  ledger: RunLedger;
  usage?: RunUsage;
  durationMs: number;
  /** Absent on a clean run. NO pass verdict here — the verifier owns it. */
  failure_kind?: FailureKind;
  /**
   * Secret-redacted message of the error that produced an infra_error
   * outcome (review finding 8: post-ledger failures return the ledger
   * instead of throwing, so the caller always tears down + reports).
   */
  error?: string;
}

export interface RunnerEnvConfigLike {
  name: string;
  baseUrls: {
    web: string;
    api: string;
    services: Record<string, string>;
  };
}

export interface RunnerTimers {
  setTimeout: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (handle: NodeJS.Timeout) => void;
}

export interface RunnerDeps {
  loadEnvironment: (env: Environment) => Promise<RunnerEnvConfigLike>;
  captureSecrets: (
    role: JourneyPersonaRole,
    env: Environment,
  ) => Promise<CapturedSecrets>;
  provisionBrowserSession: (
    role: JourneyPersonaRole,
    env: Environment,
  ) => Promise<string>;
  /**
   * Derive the API assertion token from the browser session. Called with
   * the auth-file path produced by provisionBrowserSession and the app's
   * `session_token` config, BEFORE sanitizeEnvironment (it reaches the web
   * origin over the session cookies). Returns the real-user token + any
   * session-derived headers.
   */
  deriveApiToken: (
    authFilePath: string,
    env: Environment,
    sessionToken?: JourneysSessionTokenConfig,
  ) => Promise<SessionApiToken>;
  /**
   * The app under test (`journeys.app` in the spec-hosting repo's
   * manifest): tracked resources, web-origin API feed, session token.
   * Defaults to {} — nothing tracked, no web-origin feed.
   */
  app: JourneysAppConfig;
  /**
   * `baseline` is the process-env snapshot taken BEFORE captureSecrets;
   * restore() reinstates from it so secrets introduced during capture
   * are never restored.
   */
  sanitizeEnvironment: (baseline: NodeJS.ProcessEnv) => SanitizeResult;
  prepareSandbox: (journeyName: string) => StagedSandbox;
  createAgent: (options: AgentCreateOptionsLike) => Promise<AgentLike>;
  buildHttpTool: (options: ScopedHttpToolOptions) => unknown;
  buildBrowserToolset: (options: BrowserToolsetOptions) => BrowserToolset;
  /**
   * Build the structured observability sink for one run. Writes
   * `<reportDir>/events.jsonl`, records the in-memory timeline the report
   * reads, and (when JOURNEYS_VERBOSE is truthy) live-prints one condensed
   * line per event to stdout. Injectable so tests get a silent recorder.
   */
  buildEventSink: (options: {
    filePath: string;
    verbose: boolean;
    secrets: readonly string[];
  }) => JourneyEventSink;
  /** Root for per-run report dirs; reports land in <reportRoot>/<runId>/. */
  reportRoot: string;
  /** Env-var source for runner configuration (JOURNEYS_MODEL override). */
  env: NodeJS.ProcessEnv;
  /** Injectable wall-clock timer (budget timeout_s). */
  timers: RunnerTimers;
}

async function defaultCreateAgent(
  options: AgentCreateOptionsLike,
): Promise<AgentLike> {
  const { Agent } = await import("@cursor/sdk");
  return (await Agent.create(options as never)) as unknown as AgentLike;
}

/** Production wiring — every collaborator is the real den machinery. */
export function defaultRunnerDeps(): RunnerDeps {
  return {
    loadEnvironment: (env) => envSelector.loadEnvironment(env),
    captureSecrets: (role, env) => defaultCaptureSecrets(role, env),
    provisionBrowserSession: (role, env) =>
      defaultProvisionBrowserSession(role, env),
    deriveApiToken: (authFilePath, env, sessionToken) =>
      defaultDeriveApiToken(authFilePath, env, sessionToken),
    app: {},
    sanitizeEnvironment: (baseline) =>
      defaultSanitizeEnvironment(process.env, baseline),
    prepareSandbox: (journeyName) => defaultPrepareSandbox(journeyName),
    createAgent: defaultCreateAgent,
    buildHttpTool: defaultBuildHttpTool,
    buildBrowserToolset: defaultBuildBrowserToolset,
    buildEventSink: ({ filePath, verbose, secrets }) =>
      new JourneyEventBus({
        filePath,
        secrets,
        liveWriter: verbose
          ? (line) => process.stdout.write(`${line}\n`)
          : undefined,
      }),
    reportRoot: path.resolve(getDistRoot(), "reports/journeys"),
    env: process.env,
    timers: { setTimeout, clearTimeout },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Narrow an opaque stream item to a mappable SDK message. The stream is
 * typed `unknown` (fakes in tests push plain objects); the mapper only
 * reads `type` + shape-guarded fields, so a structural `type: string`
 * check is sufficient — unknown types map to [] harmlessly.
 */
function isSdkMessage(message: unknown): message is SDKMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    typeof (message as { type?: unknown }).type === "string"
  );
}

/** Truthy JOURNEYS_VERBOSE values enable the live event stream to stdout. */
function isVerbose(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function generateRunId(journeyName: string, now: Date = new Date()): string {
  const slug = journeyName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const rand4 = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `jrn-${slug}-${now.toISOString().replace(/[:.]/g, "-")}-${rand4}`;
}

function buildPersonaPrompt(spec: JourneySpec, runId: string): string {
  return [
    `You are a synthetic user executing the journey "${spec.name}".`,
    `Run id: ${runId}. Any resource you create that accepts a display name`,
    `MUST have its name prefixed with "${runId}".`,
    ``,
    `Persona brief:`,
    spec.persona.brief,
    ``,
    `Use only the mounted journey tools. Shell access is denied.`,
  ].join("\n");
}

function enforcePolicy(
  spec: JourneySpec,
  env: Environment,
  configuredModel: string,
): void {
  if (env === "production" || env === "prod") {
    throw new JourneyPolicyError(
      "Journeys never run against production — the runner hard-refuses " +
        "the production environment regardless of spec content.",
    );
  }
  if (!spec.environments.includes(env)) {
    throw new JourneyPolicyError(
      `Journey "${spec.name}" does not allow environment "${env}" — its ` +
        `environments allowlist is [${spec.environments.join(", ")}].`,
    );
  }
  if (configuredModel.length === 0) {
    throw new JourneyPolicyError(
      `No model configured for journey "${spec.name}". Declare a default ` +
        "in the spec (`model: <model-id>`) or set the JOURNEYS_MODEL env " +
        "var (operator override) — there is no invented default model.",
    );
  }
  const budgets = (spec as Partial<JourneySpec>).budgets;
  if (
    budgets === undefined ||
    typeof budgets.max_turns !== "number" ||
    typeof budgets.timeout_s !== "number" ||
    typeof budgets.max_total_tokens !== "number"
  ) {
    throw new JourneyPolicyError(
      `Journey "${spec.name}" is missing required budgets ` +
        "(max_turns, timeout_s, max_total_tokens) — budgets are fail-closed " +
        "and never defaulted.",
    );
  }
}

/**
 * Mount tools per the spec's surface: browser => browser toolset only,
 * api => scoped HTTP tool only, mixed => both.
 */
function mountToolsForSurface(
  spec: JourneySpec,
  httpTool: unknown,
  browserToolset: BrowserToolset | undefined,
): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  if (spec.surface === "api" || spec.surface === "mixed") {
    tools[HTTP_TOOL_NAME] = httpTool;
  }
  if (
    (spec.surface === "browser" || spec.surface === "mixed") &&
    browserToolset !== undefined
  ) {
    Object.assign(tools, browserToolset.tools);
  }
  return tools;
}

function turnTotalTokens(usage: TurnUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens
  );
}

/** The run's wall-clock deadline (budgets.timeout_s) expired. */
export class DeadlineExceededError extends Error {
  constructor() {
    super(
      "Journey wall-clock deadline (budgets.timeout_s) exceeded — the run " +
        "was aborted.",
    );
    this.name = "DeadlineExceededError";
  }
}

interface RunDeadline {
  /** Aborts when the deadline fires; threaded into tool fetches. */
  signal: AbortSignal;
  clear(): void;
  /** Await `work`, rejecting with DeadlineExceededError on expiry. */
  race<T>(work: Promise<T>): Promise<T>;
}

/**
 * Cap on post-deadline / teardown-side cleanup waits (review finding
 * R2-2): run cancellation and browser disposal are best-effort — a hung
 * cleanup must never stall the outcome past this bound.
 */
export const CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Await a cleanup promise for at most `ms` (review finding R2-2). Never
 * rejects; the work's eventual settlement is always observed so an
 * abandoned cleanup can never unhandled-reject later.
 */
async function settleBounded(
  work: Promise<unknown> | undefined,
  ms: number,
): Promise<void> {
  if (work === undefined) return;
  const observed = work.then(
    () => undefined,
    () => undefined,
  );
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([observed, cap]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wall-clock deadline covering the WHOLE run — provisioning, agent
 * lifecycle waits, and (via `signal`) tool fetches (review finding 6).
 * Started BEFORE provisioning so a hung secret capture or browser mint
 * can never stall past budgets.timeout_s.
 */
function startDeadline(
  ms: number,
  timers: RunnerTimers,
  onExpire: () => void,
): RunDeadline {
  const controller = new AbortController();
  const handle = timers.setTimeout(() => {
    // onExpire first so the budget violation is recorded before any
    // race() rejection handler observes the abort.
    onExpire();
    controller.abort(new DeadlineExceededError());
  }, ms);

  return {
    signal: controller.signal,
    clear(): void {
      timers.clearTimeout(handle);
    },
    race<T>(work: Promise<T>): Promise<T> {
      // On expiry the orphaned `work` keeps running: neither Agent.create
      // nor the provisioning collaborators accept an AbortSignal today
      // (residual orphan risk — the process-level bound is the caller's
      // overall lifecycle). Its eventual settlement is OBSERVED here so a
      // late rejection can never surface as an unhandled rejection
      // (review finding R2-2).
      const observeOrphan = (): void => {
        work.then(
          () => undefined,
          () => undefined,
        );
      };
      return new Promise<T>((resolve, reject) => {
        if (controller.signal.aborted) {
          observeOrphan();
          reject(new DeadlineExceededError());
          return;
        }
        const onAbort = (): void => {
          observeOrphan();
          reject(new DeadlineExceededError());
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        work.then(
          (value) => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error: unknown) => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(error as Error);
          },
        );
      });
    },
  };
}

/**
 * Fail-closed budget accounting over turn-ended updates. The enforcer only
 * decides; the runner owns cancelling the active run.
 */
class BudgetEnforcer {
  private turns = 0;
  /**
   * ONE monotonic cumulative total across both usage sources (review
   * finding 5): each turn advances it to
   * max(prevTotal, prevTotal + turnUsage, run.usage.totalTokens) — so a
   * missing-usage turn covered only by the run handle's cumulative
   * counter can never make a later per-turn sum undercount total spend.
   */
  private cumulativeTotal: number | undefined;
  violation: Extract<
    FailureKind,
    "budget_exceeded" | "budget_unverifiable"
  > | null = null;

  constructor(
    private readonly budgets: JourneySpec["budgets"],
    private readonly cumulativeRunUsage: () => RunUsage | undefined,
  ) {}

  /** The monotonic cumulative total (undefined until any usage evidence). */
  get reportedUsage(): RunUsage | undefined {
    if (this.cumulativeTotal === undefined) return undefined;
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: this.cumulativeTotal,
    };
  }

  /** Process one turn-ended update; returns true when the run must cancel. */
  onTurnEnded(update: InteractionUpdateLike): boolean {
    if (this.violation !== null) return false;
    this.turns += 1;

    if (this.turns > this.budgets.max_turns) {
      this.violation = "budget_exceeded";
      return true;
    }

    const candidates: number[] = [];
    if (update.usage !== undefined) {
      candidates.push(
        (this.cumulativeTotal ?? 0) + turnTotalTokens(update.usage),
      );
    }
    const runTotal = this.cumulativeRunUsage()?.totalTokens;
    if (runTotal !== undefined) {
      candidates.push(runTotal);
    }

    if (candidates.length === 0) {
      // FAIL-CLOSED: spend we cannot verify never continues.
      this.violation = "budget_unverifiable";
      return true;
    }
    this.cumulativeTotal = Math.max(this.cumulativeTotal ?? 0, ...candidates);

    if (this.cumulativeTotal > this.budgets.max_total_tokens) {
      this.violation = "budget_exceeded";
      return true;
    }
    return false;
  }

  /** Wall-clock expiry (timeout_s). */
  onTimeout(): void {
    if (this.violation === null) {
      this.violation = "budget_exceeded";
    }
  }
}

/**
 * Render the scrubbed transcript as Markdown, interleaving SnapshotIndex
 * references at their action positions: whenever a message mentions a
 * browser_* tool, the next unconsumed snapshot entry is attached to it.
 * Remaining snapshots (e.g. failure frames) are appended at the end.
 */
export function renderTranscriptMarkdown(
  runId: string,
  messages: readonly string[],
  snapshotIndex: readonly SnapshotIndexEntry[],
): string {
  const lines: string[] = [`# Journey transcript — ${runId}`, ""];
  let nextSnapshot = 0;

  const snapshotLine = (entry: SnapshotIndexEntry): string =>
    entry.path === null
      ? `_Snapshot ${entry.seq} (${entry.action}) suppressed${entry.masked ? " — sensitive input masked" : ""}._`
      : `![${entry.seq}-${entry.action}](${entry.path})`;

  for (const message of messages) {
    lines.push("```json", message, "```", "");
    if (nextSnapshot < snapshotIndex.length && message.includes("browser_")) {
      lines.push(snapshotLine(snapshotIndex[nextSnapshot]), "");
      nextSnapshot += 1;
    }
  }

  if (nextSnapshot < snapshotIndex.length) {
    lines.push("## Remaining snapshots", "");
    for (const entry of snapshotIndex.slice(nextSnapshot)) {
      lines.push(snapshotLine(entry), "");
    }
  }

  return lines.join("\n");
}

// ── runJourney ───────────────────────────────────────────────────────────────

/**
 * Execute one journey against one environment. Returns a RunOutcome with
 * deliberately NO pass field — deterministic assertions (jrn-verifier) are
 * the sole pass/fail authority. Never invokes teardown.
 */
export async function runJourney(
  spec: JourneySpec,
  env: Environment,
  deps: Partial<RunnerDeps> = {},
): Promise<RunOutcome> {
  const resolved: RunnerDeps = { ...defaultRunnerDeps(), ...deps };
  const startedAt = Date.now();

  // Model resolution: JOURNEYS_MODEL (operator override, e.g. CI cost
  // pinning) wins over the spec's declared default; neither → policy refusal.
  const modelId =
    resolved.env.JOURNEYS_MODEL?.trim() || (spec.model?.trim() ?? "");
  enforcePolicy(spec, env, modelId);

  const runId = generateRunId(spec.name);
  const reportDir = path.join(resolved.reportRoot, runId);
  const transcriptPath = path.join(reportDir, "transcript.jsonl");
  const eventsPath = path.join(reportDir, "events.jsonl");
  const snapshotStore = new SnapshotStore(reportDir);

  // Structured observability timeline: live-prints under JOURNEYS_VERBOSE and
  // is persisted to events.jsonl + surfaced in report.md. Constructed with
  // the Cursor key already redacted; the session token is added post-derive.
  const verbose = isVerbose(resolved.env.JOURNEYS_VERBOSE);
  const events = resolved.buildEventSink({
    filePath: eventsPath,
    verbose,
    secrets: [],
  });

  // The ledger feeds bindings/unmanaged-mutations/interception-errors into
  // the event timeline the instant they are recognized — this is how the
  // `{<type>_id}` binding question is answered live, not only at teardown.
  const ledger = new RunLedger(ledgerRegistryFromApp(resolved.app), {
    onResource: (entry) =>
      events.emit({
        kind: "ledger_binding",
        resourceType: entry.resourceType,
        id: entry.id,
        method: entry.method,
        pathValue: entry.path,
        status: entry.status,
        source: entry.source,
      }),
    onUnmanagedMutation: (warning) =>
      events.emit({
        kind: "unmanaged_mutation",
        method: warning.method,
        pathValue: warning.path,
        status: warning.status,
        source: warning.source,
      }),
    onInterceptionError: (message) =>
      events.emit({ kind: "interception_error", message }),
  });

  let browserToolset: BrowserToolset | undefined;
  let agent: AgentLike | undefined;
  let activeRun: AgentRunLike | undefined;
  let sanitized: SanitizeResult | undefined;
  let secrets: CapturedSecrets | undefined;
  let sessionToken: SessionApiToken | undefined;
  let runEndedEmitted = false;

  const enforcer = new BudgetEnforcer(spec.budgets, () => activeRun?.usage);

  // The wall-clock deadline starts BEFORE provisioning (review finding
  // 6): a hung secret capture, browser mint, or SDK lifecycle wait can
  // never stall the journey past budgets.timeout_s. Its AbortSignal is
  // threaded into the scoped HTTP tool's fetches.
  const deadline = startDeadline(
    spec.budgets.timeout_s * 1000,
    resolved.timers,
    () => {
      enforcer.onTimeout();
      // Fire-and-forget cancel: rejection observed so it can never
      // unhandled-reject (the catch path re-cancels with a bound).
      void activeRun?.cancel().catch(() => undefined);
    },
  );

  const redactSecrets = (message: string): string => {
    let redacted = message;
    // Cursor key (captureSecrets) + the session-derived API token, once
    // available. Session-derived headers are not secrets, so not redacted.
    for (const value of [secrets?.cursorApiKey, sessionToken?.apiToken]) {
      if (value !== undefined && value.length > 0) {
        redacted = redacted.split(value).join("[REDACTED]");
      }
    }
    return redacted;
  };

  const outcome = (
    usage: RunUsage | undefined,
    durationMs: number | undefined,
    failureKind?: FailureKind,
    errorMessage?: string,
  ): RunOutcome => {
    const result: RunOutcome = {
      runId,
      transcriptPath,
      eventsPath,
      events: events.events,
      snapshotIndex: snapshotStore.index,
      ledger,
      usage: usage ?? enforcer.reportedUsage,
      durationMs: durationMs ?? Date.now() - startedAt,
    };
    if (failureKind !== undefined) {
      result.failure_kind = failureKind;
    }
    if (errorMessage !== undefined) {
      result.error = redactSecrets(errorMessage);
    }
    return result;
  };

  const scrubbedMessages: string[] = [];

  try {
    const envConfig = await deadline.race(resolved.loadEnvironment(env));

    // ── Provisioning (BEFORE sanitization — reads E2E_* env vars in CI) ──
    // Env snapshot BEFORE capture: restore() reinstates from this
    // baseline, so any secret a capture path exports into process.env is
    // deleted at sanitize time and never restored afterwards.
    const envBaseline: NodeJS.ProcessEnv = { ...process.env };
    secrets = await deadline.race(
      resolved.captureSecrets(spec.persona.role, env),
    );

    // Every journey mints a real browser session and derives its API
    // assertion token from that same session — navigation and deterministic
    // assertions share
    // one real-user credential. The browser TOOLSET is mounted only for
    // browser|mixed; api-surface journeys still need the session to obtain
    // the token, but drive nothing through the UI.
    const authFilePath = await deadline.race(
      resolved.provisionBrowserSession(spec.persona.role, env),
    );
    sessionToken = await deadline.race(
      resolved.deriveApiToken(authFilePath, env, resolved.app.session_token),
    );
    // The session-derived API token is the second live secret — register it
    // with the event sink so no event line can ever carry it (the sink also
    // fails closed if one slips through).
    events.addSecret(sessionToken.apiToken);
    events.addSecret(secrets.cursorApiKey);
    events.emit({
      kind: "run_started",
      journey: spec.name,
      env,
      surface: spec.surface,
      model: modelId,
    });

    // ── Sanitize env, then build the sandboxed agent ──
    sanitized = resolved.sanitizeEnvironment(envBaseline);

    const scrubber = new TranscriptScrubber([
      secrets.cursorApiKey,
      sessionToken.apiToken,
    ]);
    const transcriptWriter = new TranscriptWriter(transcriptPath, scrubber);
    const derivedToken = sessionToken;

    const sandbox = resolved.prepareSandbox(spec.name);

    const httpTool = resolved.buildHttpTool({
      allowedBaseUrls: allowedBaseUrlsFromEnv(envConfig),
      tokenProvider: async () => derivedToken.apiToken,
      // Session-derived scoping headers (journeys.app.session_token.headers).
      headersProvider: async () => derivedToken.headers,
      ledger,
      // Per-journey method capability derives from the spec surface;
      // DELETE is structurally impossible (harness-only teardown).
      allowedMethods: allowedMethodsForSurface(spec.surface),
      // Mutating grants come from the spec's http_capabilities (review
      // finding R2-1); an absent field means read-only for mutations.
      capabilities: (spec.http_capabilities ?? []).map((grant) => ({
        methods: grant.methods,
        pathPattern: grant.path_pattern,
      })),
      signal: deadline.signal,
    });

    // The browser toolset is mounted only for surfaces that travel the UI.
    // An api-surface journey holds a session (for the token) but exposes no
    // browser tools to the agent.
    if (spec.surface === "browser" || spec.surface === "mixed") {
      browserToolset = resolved.buildBrowserToolset({
        env: envConfig,
        authFilePath,
        snapshotStore,
        ledger,
        webApi: resolved.app.web_api,
      });
    }

    agent = await deadline.race(
      resolved.createAgent({
        apiKey: secrets.cursorApiKey,
        model: { id: modelId },
        local: {
          cwd: sandbox.dir,
          // Load the staged .cursor/ config from the cwd so the
          // beforeShellExecution deny hook (+ the custom-tools mcpAllowlist)
          // take effect. settingSources defaults to [] ("inline only"),
          // which would ignore both.
          settingSources: ["project"],
          // Sandbox is DISABLED on purpose. Custom tools are exposed as the
          // `custom-user-tools` MCP server, and the SDK's OS-level sandbox
          // does not run MCP tools inside it: with the sandbox ON, every
          // browser_*/http_request call is blocked outright (verified on two
          // staging runs — "MCP calls rejected by sandbox policy despite
          // permissions allowing custom-user-tools", 0 snapshots). Journeys
          // need the network anyway (browser navigation + API probes), so an
          // OS sandbox is the wrong tool here. The threat model — no arbitrary
          // shell, confine the agent to the mounted tools — is enforced by the
          // fail-closed beforeShellExecution deny hook instead.
          sandboxOptions: { enabled: false },
          customTools: mountToolsForSurface(spec, httpTool, browserToolset),
        },
      }),
    );

    const run = await deadline.race(
      agent.send(buildPersonaPrompt(spec, runId), {
        onDelta: async ({ update }) => {
          if (update.type !== "turn-ended") return;
          if (enforcer.onTurnEnded(update)) {
            await activeRun?.cancel();
          }
        },
      }),
    );
    activeRun = run;

    const mapperState = createMapperState();
    await deadline.race(
      (async () => {
        for await (const message of run.stream()) {
          const line = JSON.stringify(message);
          await transcriptWriter.append(message);
          scrubbedMessages.push(line);
          // Interpret the raw SDK message into condensed timeline events
          // (tool calls with results, thinking, assistant text, per-turn
          // usage). transcript.jsonl keeps the raw line; events.jsonl gets
          // the harness's own reading.
          if (isSdkMessage(message)) {
            for (const body of sdkMessageToEvents(message, mapperState)) {
              events.emit(body);
            }
          }
        }
        // The mapper buffers streamed assistant text (one token per SDK
        // frame) and flushes on the next non-text signal; a reply that ends
        // the stream has no following signal, so flush the tail here.
        for (const body of flushAssistantText(mapperState)) {
          events.emit(body);
        }
      })(),
    );
    const result = await deadline.race(run.wait());

    // Interception feeds are async — drain them so every ledger record
    // lands before the outcome is returned (review finding 7).
    await browserToolset?.drain();

    // Rendered transcript with snapshot references at action positions.
    fs.mkdirSync(reportDir, { recursive: true });
    const rendered = renderTranscriptMarkdown(
      runId,
      scrubbedMessages,
      snapshotStore.index,
    );
    scrubber.assertClean(rendered);
    fs.writeFileSync(path.join(reportDir, "transcript.md"), rendered);

    let failureKind: FailureKind | undefined;
    let agentErrorMessage: string | undefined;
    if (result.status === "error") {
      failureKind = "agent_error";
      // Capture the SDK's terminal error detail (previously dropped): the
      // message is what turns "agent_error" from an opaque verdict into an
      // actionable line in the report header + event timeline.
      agentErrorMessage = result.error?.message ?? "agent run failed";
      events.emit({
        kind: "agent_error",
        message: redactSecrets(agentErrorMessage),
        code: result.error?.code,
      });
    } else if (result.status === "cancelled") {
      failureKind = enforcer.violation ?? "budget_exceeded";
    }

    const finalDurationMs = result.durationMs ?? Date.now() - startedAt;
    events.emit({
      kind: "run_ended",
      failureKind,
      durationMs: finalDurationMs,
    });
    runEndedEmitted = true;

    return outcome(
      result.usage ?? run.usage,
      result.durationMs,
      failureKind,
      agentErrorMessage,
    );
  } catch (error) {
    // Best-effort, BOUNDED cancel (review finding R2-2): a hung SDK
    // cancel must never stall the outcome past the cleanup cap.
    await settleBounded(activeRun?.cancel(), CLEANUP_TIMEOUT_MS);
    if (error instanceof SecretLeakError) {
      // Layer 4: a live secret was about to be persisted — fail the run
      // (never rethrow: the message is safe but the run is compromised).
      return outcome(activeRun?.usage, undefined, "infra_error");
    }
    if (error instanceof DeadlineExceededError) {
      return outcome(
        activeRun?.usage,
        undefined,
        enforcer.violation ?? "budget_exceeded",
      );
    }
    if (error instanceof CursorAgentError) {
      // Startup/config failure (bad key, invalid model, transport).
      return outcome(undefined, undefined, "infra_error", error.message);
    }
    // Review finding 8: ANY other post-policy failure (stream errors,
    // transcript I/O, SDK surprises) becomes an infra_error outcome that
    // CARRIES the ledger — never a rethrow that would skip the caller's
    // teardown + reporting for already-created resources.
    return outcome(
      activeRun?.usage,
      undefined,
      "infra_error",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    deadline.clear();
    // Ensure the event log always closes with a terminal event, even on the
    // failure paths above (infra_error / budget / secret leak) that return
    // before the happy-path run_ended. Best-effort — a sink write failure
    // must never mask the real outcome.
    if (!runEndedEmitted) {
      try {
        events.emit({
          kind: "run_ended",
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // Sink already failed (e.g. EventLeakError); the outcome stands.
      }
    }
    if (browserToolset !== undefined) {
      // Best-effort drain on failure paths too (drain is internally
      // bounded — review finding R2-2), then a bounded dispose: a hung
      // browser close must never stall the outcome.
      await browserToolset.drain().catch(() => undefined);
      await settleBounded(browserToolset.dispose(), CLEANUP_TIMEOUT_MS);
    }
    agent?.close();
    sanitized?.restore();
  }
}
