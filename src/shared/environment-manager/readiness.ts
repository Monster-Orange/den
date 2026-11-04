/**
 * Readiness polling for `depends_on: { wait: true }` gates.
 *
 * Wraps `checkServiceHealth` with a poll loop. Used by the workspace `up`
 * runner to block starting a dependent until its flagged dependencies are
 * actually green (not just "started 5 seconds ago").
 */

import { READINESS_TIMEOUT_MS, READINESS_INTERVAL_MS } from "../constants.js";
import { checkServiceHealth } from "./health.js";
import type { Environment, ResolvedService } from "../types/index.js";

export interface WaitForReadyOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Called with a short status string on each unsuccessful poll. */
  onTick?: (detail: string) => void;
  /**
   * Polled between each readiness check. When it returns true the loop exits
   * early with `ok: false, detail: "cancelled"`. Used by the SSE runner to
   * stop polling when the client disconnects mid-`up`.
   */
  isCancelled?: () => boolean;
  /** Override for tests. */
  now?: () => number;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForReadyResult {
  ok: boolean;
  /** Detail from the last check — populated on timeout or fail-open. */
  detail?: string;
  /** True when the dep has no configured health check — we fail open and proceed. */
  skipped?: boolean;
  /** Time (ms) spent waiting. */
  elapsedMs: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Poll the dep's health check until it returns ok or the timeout expires.
 *
 * Fail-open: if the dep has no `health.<env>` configured, returns immediately
 * with `skipped: true` — we never silently hang on a misconfigured dep.
 */
export async function waitForReady(
  resolved: ResolvedService,
  env: Environment,
  opts: WaitForReadyOptions = {},
): Promise<WaitForReadyResult> {
  const timeoutMs = opts.timeoutMs ?? READINESS_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? READINESS_INTERVAL_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const start = now();
  const deadline = start + timeoutMs;
  let last = await checkServiceHealth(resolved, env);

  // Fail-open: no health config → don't block.
  if (last.health === "unknown") {
    return {
      ok: true,
      skipped: true,
      detail: last.healthDetail,
      elapsedMs: now() - start,
    };
  }

  while (last.health !== "ok") {
    if (opts.isCancelled?.()) {
      return { ok: false, detail: "cancelled", elapsedMs: now() - start };
    }
    if (now() >= deadline) {
      return {
        ok: false,
        detail: last.healthDetail ?? "timeout",
        elapsedMs: now() - start,
      };
    }
    opts.onTick?.(last.healthDetail ?? "not ready");
    await sleep(intervalMs);
    if (opts.isCancelled?.()) {
      return { ok: false, detail: "cancelled", elapsedMs: now() - start };
    }
    last = await checkServiceHealth(resolved, env);
  }

  return { ok: true, elapsedMs: now() - start };
}
