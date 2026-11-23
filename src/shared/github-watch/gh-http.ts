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

/**
 * One GET of a REST path (`repos/o/r/...`, no leading slash). With `etag`
 * it sends If-None-Match, so an unchanged answer is a 304 with no body and
 * costs no rate limit (issue 476).
 */
export type GhGet = (
  path: string,
  opts?: { etag?: string },
) => Promise<GhResponse>;

/** A write: the method, the REST path, and the JSON body (on stdin). */
export type GhSend = (
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body: unknown,
) => Promise<GhResponse>;

type GhRun = (
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A REST path gh takes as a path, never as an option or a URL. */
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9_./%-]*(\?[A-Za-z0-9_.=&%,+-]*)?$/;
/** An ETag as GitHub sends it: no quotes inside, no line breaks. */
const ETAG_RE = /^(W\/)?"[^"\r\n]{1,200}"$/;

function checkPath(path: string): void {
  if (!PATH_RE.test(path)) throw new Error(`not a REST path: ${path}`);
}

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
export function ghGet(run: GhRun): GhGet {
  return async (path, opts) => {
    checkPath(path);
    const args = ["api", "-i"];
    if (opts?.etag !== undefined) {
      if (!ETAG_RE.test(opts.etag)) throw new Error("not an ETag");
      args.push("-H", `If-None-Match: ${opts.etag}`);
    }
    args.push(path);
    const r = await run(args);
    return parseGhInclude(r.stdout, r.code, r.stderr);
  };
}

/** A GhSend over gh: the JSON goes on stdin, never in argv. */
export function ghSend(run: GhRun): GhSend {
  return async (method, path, body) => {
    checkPath(path);
    const r = await run(
      ["api", "-i", "--method", method, path, "--input", "-"],
      JSON.stringify(body ?? {}),
    );
    return parseGhInclude(r.stdout, r.code, r.stderr);
  };
}
