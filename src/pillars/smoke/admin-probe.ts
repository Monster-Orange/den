/**
 * Pre-flight check: storage teardown scripts often call admin HTTP APIs (e.g. a service's
 * `POST /api/v1/admin/purge`). If admin routes are disabled, fail before Playwright/k6.
 * The probe path and 403 hint come from the manifest fixture (`adminProbePath`,
 * `adminProbe403Hint`).
 *
 * Service-specific error hints belong to the caller via `hintOn403` — this module stays
 * generic and has no knowledge of any particular service's error format.
 */

export interface AssertStorageAdminProbeOptions {
  baseUrl: string;
  /** e.g. `/api/v1/admin/status` (GET, idempotent, passes admin guard only when enabled). */
  adminProbePath: string;
  /** Shown in errors (e.g. `files-api / api`). */
  label: string;
  /**
   * Optional callback invoked on a 403 response to produce a service-specific remediation hint.
   * Return a non-empty string to append it to the error message; return "" for generic output.
   */
  hintOn403?: (body: string) => string;
}

function joinBaseUrlAndProbePath(baseUrl: string, probePath: string): string {
  const trimmedBase = baseUrl.replace(/\/$/, "");
  const path = probePath.startsWith("/") ? probePath : `/${probePath}`;
  return `${trimmedBase}${path}`;
}

/**
 * GET `{baseUrl}{adminProbePath}` — expect 2xx when admin APIs are allowed for this deployment.
 * Throws with a clear error (and optional caller-supplied hint) on non-2xx.
 */
export async function assertStorageAdminProbe(
  options: AssertStorageAdminProbeOptions,
): Promise<void> {
  const url = joinBaseUrlAndProbePath(options.baseUrl, options.adminProbePath);
  console.log(`🔒 Admin API probe (${options.label}): ${url}`);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Admin probe failed for ${options.label}: cannot reach ${url} (${message})`,
    );
  }
  const body = await response.text();
  if (response.ok) {
    console.log(`  ✓ Admin endpoints reachable (${response.status})`);
    return;
  }
  if (response.status === 403) {
    const hint = options.hintOn403?.(body) ?? "";
    const detail =
      `Admin probe failed for ${options.label}: ${url} returned 403.` +
      (hint
        ? `\n${hint}`
        : `\n  Response body (truncated): ${body.slice(0, 500)}`);
    throw new Error(detail);
  }
  throw new Error(
    `Admin probe failed for ${options.label}: ${url} returned ${response.status}: ${body.slice(0, 500)}`,
  );
}
