/**
 * D41: before an agent stops, ask Hub (GET <hub>/api/inbox) how many open
 * threads wait on it (`yours`). When that went up since the last time this
 * agent was told, block the stop once: "N Hub comments wait on you: call
 * hub_inbox". Answered threads drop out of `yours`, so a new reply brings
 * the nudge back.
 *
 * D52: it asks through Den's proxy (`<den>/hub`), with the agent's own Den
 * token from its session's env (DEN_ACTOR_TOKEN); Den attaches the install's
 * Hub token, which the agent never holds. Any failure lets the agent stop
 * (fails open). Issue 609: each try waits agent_hooks.timeout_seconds
 * (20 s), with agent_hooks.retries (hook-call.ts), as the attention hook.
 *
 * 2026-11-22: with `cacheSeconds` (the Stop hook: INBOX_CACHE_SECONDS, or
 * `--hub-inbox-cache <s>`), Hub's answer is kept that long in the agent's
 * files, and turn ends inside it reuse it instead of asking again.
 */
import * as fs from "fs";
import { writeFileAtomic } from "../../atomic-write.js";
import * as path from "path";
import { actorTokenOf } from "../../actor-token.js";
import { HOOK_CALL_DEFAULT, callDen, type HookCall } from "./hook-call.js";

export interface InboxArgs {
  /** Den's proxy to Hub (`<den>/hub`). */
  base: string;
  /** The agent's files dir: where the last nudged count is kept. */
  files: string;
  /** Seconds Hub's last answer is reused for; none: ask every time. */
  cacheSeconds?: number;
}

/** The Stop hook reuses Hub's answer this long (seconds). */
export const INBOX_CACHE_SECONDS = 30;

/** `--hub-inbox <base>` (with `--files <dir>`), or null. */
export function inboxArgs(argv: readonly string[]): InboxArgs | null {
  const val = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
  };
  const base = val("--hub-inbox");
  const files = val("--files");
  if (!base || !files) return null;
  const c = Number(val("--hub-inbox-cache"));
  return Number.isFinite(c) && c > 0
    ? { base, files, cacheSeconds: c }
    : { base, files };
}

/** The agent's own Den token (its session's env), as a bearer; or null. */
function denBearer(
  env: Record<string, string | undefined>,
): Record<string, string> | null {
  const t = actorTokenOf(env);
  return t && /^[\x21-\x7e]+$/.test(t)
    ? { Authorization: `Bearer ${t}` }
    : null;
}

const stateFile = (files: string) => path.join(files, "hub-inbox.json");

interface InboxState {
  /** The count the agent was last nudged for. */
  yours: number;
  /** Hub's last answer and when (ms), with a cache. */
  answer?: number;
  at?: number;
}

function readState(files: string): InboxState {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(files), "utf-8")) as {
      yours?: unknown;
      answer?: unknown;
      at?: unknown;
    };
    const ok = (n: unknown): n is number =>
      typeof n === "number" && Number.isFinite(n) && n >= 0;
    return {
      yours: ok(j.yours) ? j.yours : 0,
      ...(ok(j.answer) && ok(j.at) ? { answer: j.answer, at: j.at } : {}),
    };
  } catch {
    return { yours: 0 };
  }
}

function saveState(files: string, st: InboxState): void {
  try {
    fs.mkdirSync(files, { recursive: true });
    writeFileAtomic(stateFile(files), `${JSON.stringify(st)}\n`, {
      mode: 0o600,
    });
  } catch {
    /* a count that can't be kept just nudges again */
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** The Stop hook's output for the inbox check ("" lets the agent stop). */
export async function inboxBlock(
  a: InboxArgs,
  opts: {
    fetch?: FetchFn;
    /** Issue 609: each try's wait, the retries, the pause between. */
    call?: HookCall;
    sleep?: (ms: number) => Promise<void>;
    env?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
): Promise<string> {
  const headers = denBearer(opts.env ?? process.env);
  if (!headers) return "";
  const now = (opts.now ?? Date.now)();
  const st = readState(a.files);
  const cacheMs = (a.cacheSeconds ?? 0) * 1000;
  const cached =
    cacheMs > 0 &&
    st.answer !== undefined &&
    st.at !== undefined &&
    now >= st.at &&
    now - st.at < cacheMs;
  let yours: number;
  if (cached) yours = st.answer as number;
  else
    try {
      const r = await callDen(
        `${a.base.replace(/\/+$/, "")}/api/inbox`,
        {
          method: "GET",
          headers: { ...headers, Accept: "application/json" },
          redirect: "error",
        },
        opts.call ?? HOOK_CALL_DEFAULT,
        { fetch: opts.fetch, sleep: opts.sleep },
      );
      if (!r?.ok) return "";
      const b = (await r.json()) as { yours?: unknown };
      if (typeof b.yours !== "number" || !Number.isInteger(b.yours)) return "";
      yours = Math.max(0, Math.min(b.yours, 1_000_000));
    } catch {
      return "";
    }
  const last = st.yours;
  // A fresh answer is kept (with a cache) so the next turn ends reuse it.
  const keep: Pick<InboxState, "answer" | "at"> =
    cacheMs <= 0
      ? {}
      : cached
        ? { answer: st.answer, at: st.at }
        : { answer: yours, at: now };
  const nudge = yours > last;
  const next: InboxState = {
    yours: nudge || yours < last ? yours : last,
    ...keep,
  };
  if (next.yours !== last || (cacheMs > 0 && !cached)) saveState(a.files, next);
  if (!nudge) return "";
  return JSON.stringify({
    decision: "block",
    reason:
      yours === 1
        ? "1 Hub comment waits on you: call hub_inbox, answer it (hub_comment) or say why not, then finish."
        : `${yours} Hub comments wait on you: call hub_inbox, answer them (hub_comment) or say why not, then finish.`,
  });
}
