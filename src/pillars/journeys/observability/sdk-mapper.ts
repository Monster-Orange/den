/**
 * Pure SDK-stream → JourneyEvent mapper. The runner streams opaque SDK
 * messages; this module turns the interesting ones into condensed,
 * secret-free harness events (tool calls with results, thinking,
 * assistant text, per-turn usage). Kept pure + injectable-free so it is
 * exhaustively unit-testable without an SDK or a live agent.
 *
 * Only the subset the operator cares about is mapped; system/request/task
 * bookkeeping messages produce no events (the raw line is still in
 * transcript.jsonl). Tool args/results are summarized to a single line —
 * never the full payload — so events.jsonl stays a timeline, not a body
 * dump (see events.ts data-minimization contract).
 */

import type { SDKMessage } from "@cursor/sdk";
import type { JourneyEventBody } from "./events.js";

/**
 * Stream state threaded across messages. The SDK streams assistant output
 * one TOKEN per `assistant` message (verified on a staging transcript:
 * 771 assistant frames for a handful of logical replies — "I'll", " run",
 * " the", …). Emitting an event per frame produced 771 fake turns + 763
 * one-word assistant_text lines and buried the real tool timeline. So we
 * BUFFER consecutive text deltas here and flush a single coalesced
 * assistant_text when a non-text signal (tool call / thinking / usage /
 * end-of-stream) arrives. `turn` increments per usage-reported round, the
 * only honest turn boundary the stream exposes.
 */
export interface MapperState {
  turn: number;
  /** Accumulated assistant text since the last flush. */
  textBuffer: string;
}

export function createMapperState(): MapperState {
  return { turn: 0, textBuffer: "" };
}

/**
 * Flush any buffered assistant text as one coalesced event. Called by the
 * mapper before emitting a non-text event, and by the runner at end-of-stream
 * so a trailing reply is not lost.
 */
export function flushAssistantText(state: MapperState): JourneyEventBody[] {
  const text = state.textBuffer.trim();
  state.textBuffer = "";
  return text.length > 0 ? [{ kind: "assistant_text", text }] : [];
}

/**
 * Map one SDK message to zero or more journey events, mutating `state`.
 * Returns [] for messages with no operator signal (the buffer may still be
 * mutated). The runner MUST call flushAssistantText(state) after the stream
 * ends to emit any trailing buffered reply.
 */
export function sdkMessageToEvents(
  message: SDKMessage,
  state: MapperState,
): JourneyEventBody[] {
  switch (message.type) {
    case "assistant":
      return mapAssistant(message, state);
    case "tool_call": {
      // Custom tools are routed through the SDK's MCP bridge, so the wire
      // `name` is the literal "mcp" and the real tool + args are nested under
      // args.{toolName,args}. Unwrap so the timeline shows `browser_navigate`,
      // not `mcp` (verified against a staging transcript, 2026-07-16).
      const { tool, args } = unwrapMcp(message.name, message.args);
      return [
        ...flushAssistantText(state),
        {
          kind: "tool_call",
          tool,
          callId: message.call_id,
          status: message.status,
          summary: summarizeArgs(tool, args),
          result: summarizeResult(message.status, message.result),
        },
      ];
    }
    case "thinking":
      return message.text.trim().length > 0
        ? [
            ...flushAssistantText(state),
            { kind: "thinking", text: message.text },
          ]
        : [];
    case "usage":
      // A usage message is the SDK's real turn boundary — flush the reply,
      // count the turn, and report cumulative tokens.
      state.turn += 1;
      return [
        ...flushAssistantText(state),
        {
          kind: "turn_ended",
          turn: state.turn,
          totalTokens: message.usage.totalTokens,
        },
      ];
    default:
      // system / user / status / request / task — no timeline signal.
      return [];
  }
}

/**
 * Handle one streamed assistant frame. Text blocks are buffered (coalesced
 * across the many one-token frames); an inline tool_use block flushes the
 * buffer and emits a running tool_call (the SDK also emits a standalone
 * `tool_call` line for execution status, so this is the intent marker).
 */
function mapAssistant(
  message: Extract<SDKMessage, { type: "assistant" }>,
  state: MapperState,
): JourneyEventBody[] {
  // Defensive: a malformed/partial assistant frame (missing message.content)
  // must never crash the stream loop — the raw line is still in
  // transcript.jsonl; we just skip block-level events for it.
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const events: JourneyEventBody[] = [];
  for (const block of content) {
    if (block.type === "text") {
      state.textBuffer += block.text;
    } else {
      events.push(...flushAssistantText(state));
      const { tool, args } = unwrapMcp(block.name, block.input);
      events.push({
        kind: "tool_call",
        tool,
        callId: block.id,
        status: "running",
        summary: summarizeArgs(tool, args),
      });
    }
  }
  return events;
}

/**
 * Unwrap the SDK's MCP tool envelope. Custom tools surface on the stream as
 * `name:"mcp"` with `args:{providerIdentifier, toolName, args}`; return the
 * inner tool name + its real args. Non-MCP calls pass through unchanged.
 */
export function unwrapMcp(
  name: string,
  args: unknown,
): { tool: string; args: unknown } {
  if (name !== "mcp" || typeof args !== "object" || args === null) {
    return { tool: name, args };
  }
  const bag = args as Record<string, unknown>;
  const toolName = typeof bag.toolName === "string" ? bag.toolName : "mcp";
  return { tool: toolName, args: bag.args };
}

/**
 * Peel the MCP result envelope to the tool's own payload. Custom-tool
 * results arrive as `{ status, value: { content: [{ text: { text } }],
 * isError } }`; return either the inner text (browser tools) or the parsed
 * JSON payload (http_request returns a JSON string) so summarizeResult can
 * read status codes / error codes. Non-MCP results pass through.
 */
function unwrapMcpResult(result: unknown): {
  payload: unknown;
  isError: boolean;
} {
  if (typeof result !== "object" || result === null) {
    return { payload: result, isError: false };
  }
  const bag = result as Record<string, unknown>;
  const value = bag.value;
  if (typeof value !== "object" || value === null) {
    return { payload: result, isError: false };
  }
  const valueBag = value as Record<string, unknown>;
  const isError = valueBag.isError === true;
  const content = valueBag.content;
  if (!Array.isArray(content) || content.length === 0) {
    return { payload: result, isError };
  }
  const first = content[0] as { text?: { text?: unknown } } | undefined;
  const text = first?.text?.text;
  if (typeof text !== "string") {
    return { payload: result, isError };
  }
  // http_request returns a JSON string; browser tools return prose.
  try {
    return { payload: JSON.parse(text), isError };
  } catch {
    return { payload: text, isError };
  }
}

/**
 * Build a one-line, secret-free summary of tool args. For the HTTP tool we
 * surface `METHOD /sanitized/path`; for browser tools the target
 * URL/selector; everything else falls back to the arg keys so we never dump
 * a full payload (which could carry a body/token) into the timeline.
 */
export function summarizeArgs(tool: string, args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const bag = args as Record<string, unknown>;

  if (tool === "http_request" || tool === "journeys_http_request") {
    const method =
      typeof bag.method === "string" ? bag.method.toUpperCase() : "GET";
    const target =
      typeof bag.path === "string"
        ? bag.path
        : typeof bag.url === "string"
          ? bag.url
          : "";
    return `${method} ${sanitizeForSummary(target)}`.trim();
  }

  if (tool.startsWith("browser_")) {
    if (typeof bag.url === "string") return sanitizeForSummary(bag.url);
    if (typeof bag.selector === "string") return `selector=${bag.selector}`;
    if (typeof bag.text === "string") return `text="${truncate(bag.text, 40)}"`;
    if (typeof bag.action === "string") return bag.action;
  }

  const keys = Object.keys(bag);
  return keys.length > 0 ? `{${keys.join(", ")}}` : undefined;
}

/**
 * Summarize a tool result to one line. HTTP results expose their status
 * code and any structured error code; browser results expose the leading
 * line of their page summary; errors expose the error code/message. Never
 * the full body.
 */
export function summarizeResult(
  status: "running" | "completed" | "error",
  rawResult: unknown,
): string | undefined {
  if (status === "running") return undefined;
  // Peel the MCP envelope (custom tools) → the tool's own payload + isError.
  const { payload: result, isError } = unwrapMcpResult(rawResult);
  if (result === undefined || result === null) {
    return status === "error" || isError ? "ERROR" : undefined;
  }

  if (typeof result === "string") {
    return withErrorPrefix(truncate(firstLine(result), 120), isError);
  }

  if (typeof result === "object") {
    const bag = result as Record<string, unknown>;
    // Scoped-tool error envelope: { error: { code, message } }.
    if (typeof bag.error === "object" && bag.error !== null) {
      const err = bag.error as Record<string, unknown>;
      const code = typeof err.code === "string" ? err.code : "ERROR";
      const msg = typeof err.message === "string" ? ` ${err.message}` : "";
      return truncate(`${code}${msg}`, 120);
    }
    if (typeof bag.error === "string") {
      return truncate(bag.error, 120);
    }
    // HTTP payload: { status, ... }.
    if (typeof bag.status === "number") {
      return `HTTP ${bag.status}`;
    }
    // Browser summary: { summary: "URL: ...\nTitle: ..." }.
    if (typeof bag.summary === "string") {
      return truncate(firstLine(bag.summary), 120);
    }
  }
  return status === "error" ? "error" : "done";
}

/** Strip query/fragment/origin from a URL-ish string for the summary line. */
function sanitizeForSummary(pathOrUrl: string): string {
  if (pathOrUrl.length === 0) return "";
  try {
    const url = new URL(pathOrUrl, "http://placeholder.invalid");
    return url.pathname;
  } catch {
    // Not URL-shaped — return as-is minus any query tail.
    return pathOrUrl.split("?")[0] ?? pathOrUrl;
  }
}

/**
 * Prefix a summary with "ERROR " when the tool flagged an error — but only
 * if the text doesn't already begin with "ERROR" (browser-tool failures
 * already start with "ERROR ACTION_FAILED: …", which double-prefixed to the
 * nonsensical "ERROR ERROR ACTION_FAILED" on the first staging run).
 */
function withErrorPrefix(text: string, isError: boolean): string {
  if (!isError) return text;
  return /^error\b/i.test(text) ? text : `ERROR ${text}`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
