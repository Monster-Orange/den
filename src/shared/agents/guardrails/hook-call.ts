/**
 * Issue 609: how an agent's hooks call Den (the attention mark, the Hub
 * inbox check). Each try waits `timeoutMs`; a try that failed (no
 * answer, a refusal, Den busy) is tried again `retries` times, the pause
 * doubling from `backoffMs`. A request Den rejects as wrong (400, 401,
 * 404, 422) is never repeated.
 *
 * Settings with permissive defaults (user.yml agent_hooks.*), passed to
 * the hook at launch as flags. A wait long enough for a loaded machine:
 * the call stays connected until Den has placed it.
 *
 * Kept small: the hooks load it on every event.
 */

export const HOOK_CALL_LIMITS = {
  timeout_seconds: { min: 1, max: 600, default: 20 },
  retries: { min: 0, max: 10, default: 2 },
  backoff_seconds: { min: 0, max: 60, default: 1 },
} as const;

export interface HookCall {
  /** One try's wait (agent_hooks.timeout_seconds). */
  timeoutMs: number;
  /** Tries after the first (agent_hooks.retries). */
  retries: number;
  /** The first pause between tries, doubling (agent_hooks.backoff_seconds). */
  backoffMs: number;
}

export const HOOK_CALL_DEFAULT: HookCall = {
  timeoutMs: HOOK_CALL_LIMITS.timeout_seconds.default * 1000,
  retries: HOOK_CALL_LIMITS.retries.default,
  backoffMs: HOOK_CALL_LIMITS.backoff_seconds.default * 1000,
};

type Limit = { min: number; max: number; default: number };
const within = (v: unknown, l: Limit, int = false): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= l.min &&
  v <= l.max &&
  (!int || Number.isInteger(v));

/** user.yml agent_hooks.*; a missing or wrong value is its default. */
export function hookCallSettings(
  read: () => { agent_hooks?: unknown },
): HookCall {
  let b: Record<string, unknown> = {};
  try {
    const v = read().agent_hooks;
    if (v && typeof v === "object" && !Array.isArray(v))
      b = v as Record<string, unknown>;
  } catch {
    /* defaults */
  }
  const L = HOOK_CALL_LIMITS;
  return {
    timeoutMs: within(b.timeout_seconds, L.timeout_seconds)
      ? Math.round(b.timeout_seconds * 1000)
      : HOOK_CALL_DEFAULT.timeoutMs,
    retries: within(b.retries, L.retries, true)
      ? b.retries
      : HOOK_CALL_DEFAULT.retries,
    backoffMs: within(b.backoff_seconds, L.backoff_seconds)
      ? Math.round(b.backoff_seconds * 1000)
      : HOOK_CALL_DEFAULT.backoffMs,
  };
}

const FLAGS = {
  timeoutMs: "--call-timeout-ms",
  retries: "--call-retries",
  backoffMs: "--call-backoff-ms",
} as const;

/** The flags a hook's command line carries. */
export function hookCallFlags(c: HookCall): string[] {
  return (Object.keys(FLAGS) as (keyof HookCall)[]).flatMap((k) => [
    FLAGS[k],
    String(c[k]),
  ]);
}

/** A hook's flags back; a missing or wrong one is its default. */
export function hookCallOf(argv: readonly string[]): HookCall {
  const num = (k: keyof HookCall, l: Limit, scale: number, int: boolean) => {
    const i = argv.indexOf(FLAGS[k]);
    const v = i >= 0 ? Number(argv[i + 1]) : NaN;
    return within(v / scale, l, int) ? v : HOOK_CALL_DEFAULT[k];
  };
  const L = HOOK_CALL_LIMITS;
  return {
    timeoutMs: num("timeoutMs", L.timeout_seconds, 1000, false),
    retries: num("retries", L.retries, 1, true),
    backoffMs: num("backoffMs", L.backoff_seconds, 1000, false),
  };
}

/**
 * Seconds the runtime must allow the hook (its own limit on a hook):
 * every try, every pause, and a margin to start and finish.
 */
export function hookCallBudgetSeconds(c: HookCall): number {
  let ms = c.timeoutMs * (c.retries + 1);
  for (let i = 0; i < c.retries; i++) ms += c.backoffMs * 2 ** i;
  return Math.ceil(ms / 1000) + 5;
}

/** Statuses a try may be repeated after: refused, busy, or failed. */
const RETRY = (s: number) =>
  s === 403 || s === 408 || s === 425 || s === 429 || s >= 500;

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/**
 * `url` with the hook's tries. Den's answer (a success, or a status
 * not to repeat), or null when every try failed. Never throws.
 */
export async function callDen(
  url: string,
  init: RequestInit,
  c: HookCall,
  d: {
    fetch?: FetchFn;
    sleep?: (ms: number) => Promise<void>;
    /** Every try failed: the last one's reason ("no answer", a refusal). */
    onMiss?: (reason: string) => void;
  } = {},
): Promise<Response | null> {
  const f = d.fetch ?? fetch;
  const sleep =
    d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = "no answer";
  for (let i = 0; i <= c.retries; i++) {
    if (i > 0) await sleep(c.backoffMs * 2 ** (i - 1));
    try {
      const r = await f(url, {
        ...init,
        signal: AbortSignal.timeout(c.timeoutMs),
      });
      if (r.ok || !RETRY(r.status)) return r;
      last = `refused (HTTP ${r.status})`;
    } catch {
      last = "no answer";
    }
  }
  d.onMiss?.(last);
  return null;
}
