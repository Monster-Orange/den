/**
 * NT-1: Claude Code's hooks tell Den an agent needs its person, and when
 * it went on. `--den <base>`: Den's web server as the agent reaches it.
 *   PermissionRequest (a permission dialog shows) → waiting, "permission";
 *   Notification ("Claude needs your permission…", "…waiting for your
 *   input") → waiting, why "permission" or "input";
 *   PostToolUse (a tool ran: it was allowed) → resumed, from "tool";
 *   UserPromptSubmit (the person sent a prompt) → resumed, from "prompt";
 *   Stop (the turn ended) → finished;
 *   SessionStart (a new or resumed Claude session; not a compaction) →
 *   resumed, from "session": a dialog from before it is gone (issue 327).
 * Issue 327: a wait names what it saw (`what`): the tool a permission
 * dialog asks for, or the notification's text, trimmed. Claude Code's
 * idle notice ("idle_prompt") says no dialog is open: it carries
 * `idle: true`, and Den clears a permission wait on it.
 * Each says `hooked: true`: Den clears the wait on these, not on the
 * agent's output (Claude Code redraws a prompt while it waits).
 * POST <den>/api/agents/self/attention with the agent's own Den token
 * (DEN_ACTOR_TOKEN in its session's env); Den knows which agent from the
 * token, never from anything here. Two seconds at most; it never blocks
 * the agent and prints nothing (fails open).
 */
import { actorTokenOf } from "../../actor-token.js";
import { recordLost } from "./lost-marks.js";

export type AttentionEvent =
  | {
      event: "waiting";
      why: "permission" | "input";
      text: string;
      /** Issue 327: the tool asked about, or the notice, ≤ WHAT_MAX chars. */
      what: string;
      /** Claude Code's idle notice: no dialog is open now. */
      idle?: true;
      hooked: true;
    }
  | { event: "resumed"; from: "tool" | "prompt" | "session"; hooked: true }
  | {
      event: "finished";
      text: string;
      /**
       * Issue 142: the question the turn ended on (its answer's last
       * line), from Claude Code's `last_assistant_message`.
       */
      question?: string;
      hooked: true;
    };

/** The hook events Den listens to (guardrails.ts registers these). */
export const ATTENTION_EVENTS = [
  "PermissionRequest",
  "Notification",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
] as const;

/** Issue 327: how much of a tool name or a notice a wait keeps. */
export const WHAT_MAX = 80;

/** One line of at most WHAT_MAX characters. */
export function trimWhat(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > WHAT_MAX ? `${one.slice(0, WHAT_MAX - 1)}…` : one;
}

/**
 * Issue 142: an answer's last line when it asks the person something (it
 * ends with "?", markup and quotes aside), ≤ 300 chars; else null.
 */
export function endingQuestion(text: string): string | null {
  const last =
    text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .pop() ?? "";
  const bare = last.trim().replace(/[\s*_`"'”’)\]]+$/u, "");
  return /[?？]$/u.test(bare) ? last.trim().slice(0, 300) : null;
}

/** What Den is told for one hook input, or null for nothing. */
export function attentionOf(input: unknown): AttentionEvent | null {
  if (!input || typeof input !== "object") return null;
  const i = input as {
    hook_event_name?: unknown;
    message?: unknown;
    stop_hook_active?: unknown;
    tool_name?: unknown;
    notification_type?: unknown;
    source?: unknown;
    last_assistant_message?: unknown;
  };
  const msg = typeof i.message === "string" ? i.message.slice(0, 300) : "";
  if (i.hook_event_name === "PermissionRequest") {
    const tool = typeof i.tool_name === "string" ? trimWhat(i.tool_name) : "";
    return {
      event: "waiting",
      why: "permission",
      text: tool
        ? `Claude needs your permission to use ${tool}`
        : "Claude needs your permission",
      what: tool,
      hooked: true,
    };
  }
  if (i.hook_event_name === "Notification")
    return {
      event: "waiting",
      why: /permission/i.test(msg) ? "permission" : "input",
      text: msg,
      what: trimWhat(msg),
      ...(i.notification_type === "idle_prompt" ? { idle: true as const } : {}),
      hooked: true,
    };
  // A compaction keeps the session (and any dialog); anything else is new.
  if (i.hook_event_name === "SessionStart" && i.source !== "compact")
    return { event: "resumed", from: "session", hooked: true };
  if (i.hook_event_name === "PostToolUse")
    return { event: "resumed", from: "tool", hooked: true };
  if (i.hook_event_name === "UserPromptSubmit")
    return { event: "resumed", from: "prompt", hooked: true };
  // A Stop a Stop hook kept going (D41's nudge) isn't the turn's end yet.
  // Issue 142: the turn's last answer comes with it; a question there
  // needs the person.
  if (i.hook_event_name === "Stop" && i.stop_hook_active !== true) {
    const q =
      typeof i.last_assistant_message === "string"
        ? endingQuestion(i.last_assistant_message)
        : null;
    return {
      event: "finished",
      text: "",
      ...(q ? { question: q } : {}),
      hooked: true,
    };
  }
  return null;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** Send it; true when Den took it. Never throws. */
export async function sendAttention(
  base: string,
  ev: AttentionEvent,
  opts: {
    env?: Record<string, string | undefined>;
    fetch?: FetchFn;
    timeoutMs?: number;
    /** Issue 609: why Den didn't take it ("no answer", or its refusal). */
    onMiss?: (reason: string) => void;
  } = {},
): Promise<boolean> {
  const t = actorTokenOf(opts.env ?? process.env);
  if (!t || !/^[\x21-\x7e]+$/.test(t)) return false;
  try {
    const r = await (opts.fetch ?? fetch)(
      `${base.replace(/\/+$/, "")}/api/agents/self/attention`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${t}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(ev),
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      },
    );
    if (!r.ok) opts.onMiss?.(`refused (HTTP ${r.status})`);
    return r.ok;
  } catch {
    opts.onMiss?.("no answer");
    return false;
  }
}

/** `--<name> <value>`, or "". */
function argOf(argv: readonly string[], name: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
}

export function denArg(argv: readonly string[]): string {
  const i = argv.indexOf("--den");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
}

async function main(): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  const argv = process.argv.slice(2);
  const base = denArg(argv);
  if (!base) return;
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return;
  }
  const ev = attentionOf(input);
  if (!ev) return;
  // Issue 609: a mark Den never took is recorded, for doctor.
  const lost = argOf(argv, "--lost");
  let why = "";
  const ok = await sendAttention(base, ev, { onMiss: (r) => (why = r) });
  if (!ok && why && lost)
    recordLost(lost, {
      agent: argOf(argv, "--agent") || "?",
      event: ev.event,
      reason: why,
    });
}

if (process.argv[1] && /attention-hook\.[jt]s$/.test(process.argv[1]))
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
