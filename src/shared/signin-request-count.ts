/**
 * Issue 1333: the activity trail's sign-in requests (verb `signin-request`,
 * written by the server's signin-request-log.ts), counted for doctor.
 */

export const SIGNIN_REQUEST_VERB = "signin-request";

/**
 * Doctor's counts over the last day of the trail: the requests started,
 * and those nobody approved (denied, withdrawn, expired, or still open).
 */
export function signinRequestCounts(
  entries: { ts: string; verb: string; detail: string }[],
  now: number = Date.now(),
): { requests: number; notApproved: number } {
  const since = now - 24 * 3_600_000;
  const started = new Set<string>();
  const approved = new Set<string>();
  for (const e of entries) {
    if (e.verb !== SIGNIN_REQUEST_VERB) continue;
    const at = Date.parse(e.ts);
    if (!(at >= since && at <= now)) continue;
    const m = /^(start|end) ([A-Za-z0-9_-]+):\s*(\S*)/.exec(e.detail);
    if (!m) continue;
    if (m[1] === "start") started.add(m[2]);
    else if (m[3] === "approved") approved.add(m[2]);
  }
  const ok = [...started].filter((r) => approved.has(r)).length;
  return { requests: started.size, notApproved: started.size - ok };
}
