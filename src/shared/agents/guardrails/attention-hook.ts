/**
 * NT-1: Claude Code's Notification and Stop hooks tell Den an agent needs
 * its person. `--den <base>`: Den's web server as the agent reaches it.
 *   Notification ("Claude needs your permission…", "…waiting for your
 *   input") → waiting, why "permission" or "input";
 *   Stop (the turn ended) → finished.
 * POST <den>/api/agents/self/attention with the agent's own Den token
 * (DEN_ACTOR_TOKEN in its session's env); Den knows which agent from the
 * token, never from anything here. Two seconds at most; it never blocks
 * the agent and prints nothing (fails open).
 */
import { ACTOR_TOKEN_ENV } from "../../actor-token.js";

export type AttentionEvent =
  | { event: "waiting"; why: "permission" | "input"; text: string }
  | { event: "finished"; text: string };

/** What Den is told for one hook input, or null for nothing. */
export function attentionOf(input: unknown): AttentionEvent | null {
  if (!input || typeof input !== "object") return null;
  const i = input as {
    hook_event_name?: unknown;
    message?: unknown;
    stop_hook_active?: unknown;
  };
  const msg = typeof i.message === "string" ? i.message.slice(0, 300) : "";
  if (i.hook_event_name === "Notification")
    return {
      event: "waiting",
      why: /permission/i.test(msg) ? "permission" : "input",
      text: msg,
    };
  // A Stop a Stop hook kept going (D41's nudge) isn't the turn's end yet.
  if (i.hook_event_name === "Stop" && i.stop_hook_active !== true)
    return { event: "finished", text: "" };
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
  const t = (opts.env ?? process.env)[ACTOR_TOKEN_ENV];
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
