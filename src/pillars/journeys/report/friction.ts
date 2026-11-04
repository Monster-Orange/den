/**
 * Journeys friction extraction — deterministic, harness-side, zero LLM
 * involvement (plan: jrn-reporting packet, Approach §Reporting).
 *
 * Extracts friction_points[] from the persisted transcript (parsed JSONL
 * lines), optional tool telemetry, and the SnapshotIndex. Friction is
 * OBSERVABILITY ONLY: nothing in this module touches the verdict, and the
 * report row's status is computed exclusively from the deterministic
 * verifier's Verdict (pinned by tests in reporting.test.ts).
 *
 * Categories:
 * - tool_error            — a tool call finished with status "error";
 * - tool_retry            — a same-name call immediately after a failed one;
 * - http_error            — a structured tool result carrying HTTP 4xx/5xx
 *                           (both surfaces: scoped HTTP tool and browser);
 * - error_page            — error-page markers in a browser page summary;
 * - dead_end_navigation   — navigation back to an already-visited URL;
 * - latency_outlier       — a tool call far slower than the per-step budget.
 *
 * Every point carries evidence {transcriptRef, snapshotPath?}: the 1-based
 * transcript line and, for browser actions, the nearest SnapshotIndex frame
 * (falling back to the closest earlier non-suppressed frame).
 */

import type { JourneyBudgets } from "../spec/schema.js";
import type { SnapshotIndexEntry } from "../tools/snapshot-store.js";

/**
 * Markers that identify an error page in a browser tool's text page summary.
 * Deliberately conservative: generic web-app failure copy only, so ordinary
 * content ("error handling docs") does not false-positive.
 */
const ERROR_PAGE_MARKERS =
  /something went wrong|an error occurred|page not found|internal server error|service unavailable/i;

/**
 * A step is a latency outlier when it exceeds this multiple of the per-step
 * budget (timeout_s * 1000 / max_turns). Factor 2 because the per-step
 * budget is an average — individual steps legitimately vary around it, and
 * friction is advisory, so we only flag clear outliers.
 */
const LATENCY_OUTLIER_FACTOR = 2;

/** Tool-name prefix that assigns an event to the browser surface. */
const BROWSER_TOOL_PREFIX = "browser_";

export type FrictionSurface = "browser" | "api";
export type FrictionSeverity = "low" | "medium" | "high";
export type FrictionCategory =
  | "tool_error"
  | "tool_retry"
  | "http_error"
  | "error_page"
  | "dead_end_navigation"
  | "latency_outlier";

export interface FrictionEvidence {
  /** Transcript position, e.g. "transcript.jsonl:12" (1-based line). */
  transcriptRef: string;
  /** Nearest snapshot frame, when one exists for the action. */
  snapshotPath?: string;
}

export interface FrictionPoint {
  /** 1-based transcript line of the triggering event. */
  step: number;
  surface: FrictionSurface;
  severity: FrictionSeverity;
  category: FrictionCategory;
  evidence: FrictionEvidence;
  description: string;
}

/** Per-call duration telemetry, keyed by the transcript's call_id. */
export interface ToolCallTelemetry {
  callId: string;
  durationMs: number;
}

export interface FrictionInputs {
  /** Parsed transcript JSONL lines, in persisted order. */
  transcript: readonly unknown[];
  snapshotIndex: readonly SnapshotIndexEntry[];
  /** Spec budgets — the per-step latency baseline derives from these. */
  budgets: JourneyBudgets;
  toolTelemetry?: readonly ToolCallTelemetry[];
}

/** Structural shape of a terminal tool_call transcript line. */
interface TerminalToolCall {
  line: number;
  callId?: string;
  name: string;
  status: "completed" | "error";
  result?: unknown;
}

function asTerminalToolCall(
  message: unknown,
  line: number,
): TerminalToolCall | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const candidate = message as {
    type?: unknown;
    call_id?: unknown;
    name?: unknown;
    status?: unknown;
    result?: unknown;
  };
  if (candidate.type !== "tool_call") return undefined;
  if (typeof candidate.name !== "string") return undefined;
  if (candidate.status !== "completed" && candidate.status !== "error") {
    return undefined;
  }
  return {
    line,
    callId:
      typeof candidate.call_id === "string" ? candidate.call_id : undefined,
    name: candidate.name,
    status: candidate.status,
    result: candidate.result,
  };
}

function surfaceOf(call: TerminalToolCall): FrictionSurface {
  return call.name.startsWith(BROWSER_TOOL_PREFIX) ? "browser" : "api";
}

function resultField(call: TerminalToolCall, field: string): unknown {
  if (typeof call.result !== "object" || call.result === null) return undefined;
  return (call.result as Record<string, unknown>)[field];
}

function httpStatusOf(call: TerminalToolCall): number | undefined {
  const status = resultField(call, "status");
  return typeof status === "number" ? status : undefined;
}

function pageSummaryOf(call: TerminalToolCall): string | undefined {
  const summary = resultField(call, "summary");
  if (typeof summary === "string") return summary;
  return typeof call.result === "string" ? call.result : undefined;
}

/** Did this terminal call fail (tool error or HTTP >= 400 result)? */
function callFailed(call: TerminalToolCall): boolean {
  if (call.status === "error") return true;
  const status = httpStatusOf(call);
  return status !== undefined && status >= 400;
}

/**
 * Nearest snapshot for the browser action at `ordinal` (1-based count of
 * terminal browser_* calls so far): the entry with the matching seq when it
 * has a persisted frame, else the closest earlier non-suppressed frame.
 */
function nearestSnapshotPath(
  snapshotIndex: readonly SnapshotIndexEntry[],
  ordinal: number,
): string | undefined {
  for (let seq = ordinal; seq >= 1; seq -= 1) {
    const entry = snapshotIndex.find((candidate) => candidate.seq === seq);
    if (entry?.path != null) return entry.path;
  }
  return undefined;
}

/**
 * Extract deterministic friction points from one run's persisted artifacts.
 * Output order follows transcript order; identical inputs always produce
 * identical output.
 */
export function extractFrictionPoints(inputs: FrictionInputs): FrictionPoint[] {
  const points: FrictionPoint[] = [];
  const telemetryByCallId = new Map<string, number>(
    (inputs.toolTelemetry ?? []).map((t) => [t.callId, t.durationMs]),
  );
  // Per-step baseline: the budgets guarantee max_turns > 0 (schema-enforced).
  const stepBudgetMs =
    (inputs.budgets.timeout_s * 1000) / inputs.budgets.max_turns;
  const latencyThresholdMs = stepBudgetMs * LATENCY_OUTLIER_FACTOR;

  const visitedUrls = new Set<string>();
  let previousCall: TerminalToolCall | undefined;
  let browserOrdinal = 0;

  const push = (
    call: TerminalToolCall,
    category: FrictionCategory,
    severity: FrictionSeverity,
    description: string,
  ): void => {
    const evidence: FrictionEvidence = {
      transcriptRef: `transcript.jsonl:${call.line}`,
    };
    if (surfaceOf(call) === "browser") {
      const snapshotPath = nearestSnapshotPath(
        inputs.snapshotIndex,
        browserOrdinal,
      );
      if (snapshotPath !== undefined) evidence.snapshotPath = snapshotPath;
    }
    points.push({
      step: call.line,
      surface: surfaceOf(call),
      severity,
      category,
      evidence,
      description,
    });
  };

  inputs.transcript.forEach((message, index) => {
    const call = asTerminalToolCall(message, index + 1);
    if (call === undefined) return;

    if (surfaceOf(call) === "browser") browserOrdinal += 1;

    if (call.status === "error") {
      push(
        call,
        "tool_error",
        "high",
        `${call.name} failed: ${JSON.stringify(call.result ?? null)}`,
      );
    }

    const httpStatus = httpStatusOf(call);
    if (call.status === "completed" && httpStatus !== undefined) {
      if (httpStatus >= 500) {
        push(
          call,
          "http_error",
          "high",
          `${call.name} returned HTTP ${httpStatus}`,
        );
      } else if (httpStatus >= 400) {
        push(
          call,
          "http_error",
          "medium",
          `${call.name} returned HTTP ${httpStatus}`,
        );
      }
    }

    if (call.status === "completed" && surfaceOf(call) === "browser") {
      const summary = pageSummaryOf(call);
      if (summary !== undefined && ERROR_PAGE_MARKERS.test(summary)) {
        push(
          call,
          "error_page",
          "medium",
          `${call.name} landed on an error page: ${summary.slice(0, 200)}`,
        );
      }
    }

    if (
      previousCall !== undefined &&
      previousCall.name === call.name &&
      callFailed(previousCall)
    ) {
      push(
        call,
        "tool_retry",
        "low",
        `${call.name} retried after a failed attempt`,
      );
    }

    if (call.name === "browser_navigate" && call.status === "completed") {
      const url = resultField(call, "url");
      if (typeof url === "string") {
        if (visitedUrls.has(url)) {
          push(
            call,
            "dead_end_navigation",
            "low",
            `navigated back to already-visited ${url} (backtracking)`,
          );
        }
        visitedUrls.add(url);
      }
    }

    if (call.callId !== undefined) {
      const durationMs = telemetryByCallId.get(call.callId);
      if (durationMs !== undefined && durationMs > latencyThresholdMs) {
        push(
          call,
          "latency_outlier",
          "medium",
          `${call.name} took ${durationMs}ms (>${Math.round(latencyThresholdMs)}ms, ` +
            `${LATENCY_OUTLIER_FACTOR}x the per-step budget)`,
        );
      }
    }

    previousCall = call;
  });

  return points;
}
