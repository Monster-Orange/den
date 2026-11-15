/**
 * Whether Den may open (or focus) a browser now (0.4.48). Test runs left
 * a person's browser full of sign-in tabs: a test or CI run never opens
 * one. `DEN_NO_OPEN=1` is `--no-open` everywhere; under Jest
 * (JEST_WORKER_ID) or CI only `DEN_ALLOW_OPEN=1` lets it open.
 *
 * Null: it may. Else why not, for the line that says it was skipped.
 */
export function browserOpenRefusal(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.DEN_NO_OPEN === "1") return "DEN_NO_OPEN=1";
  if (env.DEN_ALLOW_OPEN === "1") return null;
  if (env.JEST_WORKER_ID) return "a test run";
  if (env.CI) return "CI";
  return null;
}
