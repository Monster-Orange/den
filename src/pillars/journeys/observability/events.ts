/**
 * Journeys observability event bus — the single structured timeline of what
 * a journey did, feeding three sinks from one source:
 *   1. an in-memory list (the report reads it for the timeline + binding
 *      summary + denial list),
 *   2. `events.jsonl` next to the transcript (post-mortem forensics),
 *   3. an optional condensed live line to stdout (JOURNEYS_VERBOSE) so a
 *      stuck/looping run is obvious WHILE it runs, not after `report:`.
 *
 * The transcript.jsonl remains the raw SDK stream; events.jsonl is the
 * harness's own interpretation — tool calls with results, ledger bindings
 * (the `{<type>_id}` question answered directly), network interception hits,
 * capability/policy denials, agent errors, and turn/token progress.
 *
 * Data-minimization (mirrors ledger.ts): events carry ONLY method +
 * sanitized path + status + extracted id + tool name + a short human
 * summary. Never bodies, headers, cookies, or credential material. The
 * caller still passes secret values so the JSONL writer fails closed if one
 * ever appears (defense in depth alongside TranscriptScrubber).
 */

import * as fs from "fs";
import * as path from "path";
import type { HttpMethod, LedgerSource } from "../tools/ledger.js";

/** Monotonic-ish wall clock; injectable for deterministic tests. */
export type Clock = () => number;

/**
 * One structured harness event. `kind` discriminates; every event carries a
 * `seq` (emission order) and `tMs` (ms since bus creation) stamped by the
 * bus, so consumers never compute timing themselves.
 */
export type JourneyEvent = { seq: number; tMs: number } & JourneyEventBody;

export type JourneyEventBody =
  | {
      kind: "run_started";
      journey: string;
      env: string;
      surface: string;
      model: string;
    }
  | { kind: "turn_started"; turn: number }
  | {
      kind: "turn_ended";
      turn: number;
      /** Cumulative total tokens if the runtime reported usage this turn. */
      totalTokens?: number;
    }
  | {
      kind: "tool_call";
      /** Tool wire name, e.g. "browser_navigate", "http_request". */
      tool: string;
      /** SDK call id, for correlating start/end if both are emitted. */
      callId?: string;
      status: "running" | "completed" | "error";
      /** One-line, secret-free summary of args (e.g. `GET /api/v1/items`). */
      summary?: string;
      /** One-line, secret-free summary of the result (status, error code). */
      result?: string;
    }
  | { kind: "thinking"; text: string }
  | { kind: "assistant_text"; text: string }
  | {
      kind: "ledger_binding";
      resourceType: string;
      id: string;
      method: HttpMethod;
      pathValue: string;
      status: number;
      source: LedgerSource;
    }
  | {
      kind: "unmanaged_mutation";
      method: HttpMethod;
      pathValue: string;
      status: number;
      source: LedgerSource;
    }
  | { kind: "interception_error"; message: string }
  | {
      kind: "snapshot";
      action: string;
      /** null when suppressed/failed — the reason is in `note`. */
      pathValue: string | null;
      note?: string;
    }
  | {
      kind: "agent_error";
      /** SDK RunResult.error.message (secret-redacted by the caller). */
      message: string;
      code?: string;
    }
  | { kind: "run_ended"; failureKind?: string; durationMs: number };

/**
 * The surface the runner depends on — lets tests inject a recording fake
 * without a filesystem. `JourneyEventBus` is the production implementation.
 */
export interface JourneyEventSink {
  emit(body: JourneyEventBody): void;
  addSecret(value: string): void;
  readonly events: readonly JourneyEvent[];
}

/** Sink config; all optional so tests can run the bus headless-silent. */
export interface JourneyEventBusOptions {
  /** Absolute path for the JSONL sink; when omitted, nothing is written. */
  filePath?: string;
  /** Emit a condensed line per event to this writer (stdout when verbose). */
  liveWriter?: (line: string) => void;
  /** Secret values redacted before any event is written/printed. */
  secrets?: readonly string[];
  clock?: Clock;
}

/** A live secret slipped into an event — fail the run loudly (never write). */
export class EventLeakError extends Error {
  constructor() {
    super(
      "Journey event persist blocked: an event matched a live secret value. " +
        "The run fails closed (failure_kind=infra_error).",
    );
    this.name = "EventLeakError";
  }
}

/**
 * Collects, persists, and (optionally) live-prints structured journey
 * events. Single-threaded append; the JSONL write is synchronous so an
 * event is durable the instant it is emitted (a crash mid-run still leaves
 * a partial timeline on disk).
 */
export class JourneyEventBus {
  private readonly recorded: JourneyEvent[] = [];
  private readonly filePath?: string;
  private readonly liveWriter?: (line: string) => void;
  private readonly secrets: string[];
  private readonly clock: Clock;
  private readonly startedAt: number;
  private seqCounter = 0;

  constructor(options: JourneyEventBusOptions = {}) {
    this.filePath = options.filePath;
    this.liveWriter = options.liveWriter;
    this.secrets = (options.secrets ?? []).filter((v) => v.length > 0);
    this.clock = options.clock ?? Date.now;
    this.startedAt = this.clock();
    if (this.filePath !== undefined) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
  }

  /** Events in emission order (report timeline reads this). */
  get events(): readonly JourneyEvent[] {
    return this.recorded;
  }

  /**
   * Add live secret values to redact from future events. The runner learns
   * the session token only after provisioning, so the bus is constructed
   * with the Cursor key and the token is added once derived.
   */
  addSecret(value: string): void {
    if (value.length > 0 && !this.secrets.includes(value)) {
      this.secrets.push(value);
    }
  }

  private redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      out = out.split(secret).join("[REDACTED]");
    }
    return out;
  }

  /**
   * Emit one event: stamp seq + tMs, redact strings, record, persist, and
   * (if verbose) live-print. Throws EventLeakError if a raw secret survives
   * redaction anywhere in the serialized event.
   */
  emit(body: JourneyEventBody): void {
    const redactedBody = redactEventStrings(body, (t) => this.redact(t));
    const event: JourneyEvent = {
      seq: this.seqCounter++,
      tMs: this.clock() - this.startedAt,
      ...redactedBody,
    };
    const line = JSON.stringify(event);
    for (const secret of this.secrets) {
      if (line.includes(secret)) {
        throw new EventLeakError();
      }
    }
    this.recorded.push(event);
    if (this.filePath !== undefined) {
      fs.appendFileSync(this.filePath, `${line}\n`);
    }
    this.liveWriter?.(formatLiveLine(event));
  }
}

/**
 * Map every user-supplied string field of an event through `fn` (redaction).
 * Kept exhaustive-by-construction: only known string-bearing fields are
 * touched, numbers/enums pass through.
 */
function redactEventStrings(
  body: JourneyEventBody,
  fn: (t: string) => string,
): JourneyEventBody {
  switch (body.kind) {
    case "tool_call":
      return {
        ...body,
        summary: body.summary === undefined ? undefined : fn(body.summary),
        result: body.result === undefined ? undefined : fn(body.result),
      };
    case "thinking":
    case "assistant_text":
      return { ...body, text: fn(body.text) };
    case "interception_error":
      return { ...body, message: fn(body.message) };
    case "agent_error":
      return { ...body, message: fn(body.message) };
    default:
      return body;
  }
}

/** ANSI-free, one-line condensed rendering for the live/verbose stream. */
export function formatLiveLine(event: JourneyEvent): string {
  const t = `${(event.tMs / 1000).toFixed(1)}s`;
  switch (event.kind) {
    case "run_started":
      return `  [${t}] ▶ ${event.journey} (${event.surface}) model=${event.model}`;
    case "turn_started":
      return `  [${t}] turn ${event.turn}`;
    case "turn_ended":
      return `  [${t}] turn ${event.turn} ended${
        event.totalTokens !== undefined ? ` (${event.totalTokens} tok)` : ""
      }`;
    case "tool_call": {
      const icon =
        event.status === "completed"
          ? "✓"
          : event.status === "error"
            ? "✗"
            : "…";
      const parts = [`  [${t}] ${icon} ${event.tool}`];
      if (event.summary) parts.push(event.summary);
      if (event.result) parts.push(`→ ${event.result}`);
      return parts.join(" ");
    }
    case "thinking":
      return `  [${t}] 💭 ${truncate(event.text, 100)}`;
    case "assistant_text":
      return `  [${t}] 🗣  ${truncate(event.text, 100)}`;
    case "ledger_binding":
      return `  [${t}] 🔗 bound ${event.resourceType}=${event.id} (${event.method} ${event.pathValue} → ${event.status})`;
    case "unmanaged_mutation":
      return `  [${t}] ⚠ unmanaged ${event.method} ${event.pathValue} → ${event.status}`;
    case "interception_error":
      return `  [${t}] ⚠ interception error: ${truncate(event.message, 120)}`;
    case "snapshot":
      return `  [${t}] 📸 ${event.action}${
        event.pathValue === null
          ? ` (no frame${event.note ? `: ${event.note}` : ""})`
          : ""
      }`;
    case "agent_error":
      return `  [${t}] ✗ agent error${event.code ? ` [${event.code}]` : ""}: ${truncate(event.message, 200)}`;
    case "run_ended":
      return `  [${t}] ■ ended${event.failureKind ? ` (${event.failureKind})` : " (ok)"} in ${event.durationMs}ms`;
    default: {
      // Exhaustiveness guard: a new event kind must extend this switch.
      const _never: never = event;
      return String(_never);
    }
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
