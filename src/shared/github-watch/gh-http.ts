/**
 * GitHub's REST answers with their headers, for the shared watcher: the
 * rate-limit headers (X-RateLimit-Remaining, X-RateLimit-Reset) and
 * Retry-After are what it paces itself by. Den's GitHub calls go through
 * `gh` as the person running the server (report-routes.ts runGh); `gh api
 * -i` prints the status line and the headers before the body, so no token
 * is ever read here. On a 4xx or 5xx gh exits 1 and still prints them.
 */
export interface GhResponse {
  /** The HTTP status; 0 when GitHub never answered (no gh, not signed in). */
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: unknown;
  /** Why there is no answer (status 0), from gh's stderr. */
  error?: string;
}

/** One GET of a REST path (`repos/o/r/...`, no leading slash). */
export type GhGet = (path: string) => Promise<GhResponse>;

/** `gh api -i <path>`'s output as a response. */
export function parseGhInclude(
  stdout: string,
  code: number,
  stderr = "",
): GhResponse {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(stdout);
  if (!m)
    return {
      status: 0,
      headers: {},
      body: null,
      error:
        (stderr || stdout)
          .trim()
          .split("\n")
          .slice(-2)
          .join(" ")
          .slice(0, 300) || `gh exited ${code} with no answer`,
    };
  const rest = stdout.slice(m[0].length);
  const split = /\r?\n\r?\n/.exec(rest);
  const head = split ? rest.slice(0, split.index) : rest;
  const raw = split ? rest.slice(split.index + split[0].length) : "";
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0)
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  let body: unknown = null;
  try {
    body = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  return { status: Number(m[1]), headers, body };
}

/** A GhGet over gh (the server passes report-routes' runGh). */
export function ghGet(
  run: (
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
): GhGet {
  return async (path) => {
    const r = await run(["api", "-i", path]);
    return parseGhInclude(r.stdout, r.code, r.stderr);
  };
}
