/**
 * The fields of a /api/health row that say what was checked. `url` is only
 * ever a URL (or null): a shell check's command (a compose stack's
 * `<cli> stack health …`, or any declared shell check) goes in `check`, as
 * does a container check's `container <project>/<service>` (or
 * `container <name>`).
 */
export type HealthCheckType = "shell" | "http" | "container" | "none";

export function healthCheckFields(
  checkType: HealthCheckType,
  target: string,
): { url: string | null; check?: string } {
  if (checkType === "shell" || checkType === "container")
    return { url: null, check: target };
  if (checkType === "http") return { url: target };
  return { url: null };
}
