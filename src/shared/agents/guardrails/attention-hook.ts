/**
 * NT-1: Claude Code's hooks tell Den an agent needs its person, and when
 * it went on. `--den <base>`: Den's web server as the agent reaches it.
 *   PermissionRequest (a permission dialog shows) → waiting, "permission";
 *   Notification ("Claude needs your permission…", "…waiting for your
 *   input") → waiting, why "permission" or "input";
 *   PostToolUse (a tool ran: it was allowed) → resumed, from "tool";
 *   UserPromptSubmit (the person sent a prompt) → resumed, from "prompt";
 *   Stop (the turn ended) → finished.
 * Each says `hooked: true`: Den clears the wait on these, not on the
 * agent's output (Claude Code redraws a prompt while it waits).
 * POST <den>/api/agents/self/attention with the agent's own Den token
 * (DEN_ACTOR_TOKEN in its session's env); Den knows which agent from the
 * token, never from anything here. Two seconds at most; it never blocks
 * the agent and prints nothing (fails open).
 */
import { actorTokenOf } from "../../actor-token.js";

export type AttentionEvent =
  | {
      event: "waiting";
      why: "permission" | "input";
      text: string;
      hooked: true;
    }
  | { event: "resumed"; from: "tool" | "prompt"; hooked: true }
  | { event: "finished"; text: string; hooked: true };

/** The hook events Den listens to (guardrails.ts registers these). */
export const ATTENTION_EVENTS = [
  "PermissionRequest",
  "Notification",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
] as const;

/** What Den is told for one hook input, or null for nothing. */
export function attentionOf(input: unknown): AttentionEvent | null {
  if (!input || typeof input !== "object") return null;
  const i = input as {
    hook_event_name?: unknown;
    message?: unknown;
    stop_hook_active?: unknown;
    tool_name?: unknown;
  };
  const msg = typeof i.message === "string" ? i.message.slice(0, 300) : "";
  if (i.hook_event_name === "PermissionRequest")
    return {
      event: "waiting",
      why: "permission",
      text:
        typeof i.tool_name === "string"
          ? `Claude needs your permission to use ${i.tool_name.slice(0, 80)}`
          : "Claude needs your permission",
      hooked: true,
    };
  if (i.hook_event_name === "Notification")
    return {
      event: "waiting",
      why: /permission/i.test(msg) ? "permission" : "input",
      text: msg,
      hooked: true,
    };
  if (i.hook_event_name === "PostToolUse")
    return { event: "resumed", from: "tool", hooked: true };
  if (i.hook_event_name === "UserPromptSubmit")
    return { event: "resumed", from: "prompt", hooked: true };
  // A Stop a Stop hook kept going (D41's nudge) isn't the turn's end yet.
  if (i.hook_event_name === "Stop" && i.stop_hook_active !== true)
    return { event: "finished", text: "", hooked: true };
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
    return r.ok;
  } catch {
    return false;
  }
}

export function denArg(argv: readonly string[]): string {
  const i = argv.indexOf("--den");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
}

async function main(): Promise<void> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  const base = denArg(process.argv.slice(2));
  if (!base) return;
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return;
  }
  const ev = attentionOf(input);
  if (ev) await sendAttention(base, ev);
}

if (process.argv[1] && /attention-hook\.[jt]s$/.test(process.argv[1]))
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
