/**
 * Issue 487: how Den's server asks GitHub for the CI watcher: through the
 * person's own gh, one `gh api -i <path>` per request. gh reads its own
 * stored sign-in, so no GitHub credential ever enters Den's process: Den
 * builds no credential header and asks gh for none.
 *
 * Conditional requests still hold: a GET with the last answer's ETag sends
 * `-H "If-None-Match: <etag>"`, and an unchanged answer is a 304 that costs
 * nothing. gh exits 1 on a 304 (and on any status from 300 up) with the
 * status line and headers still on stdout (-i), so the status comes from
 * there, never from the exit code. rate_limit costs nothing either.
 *
 * Run with execFile and an argument list (no shell), within a timeout (the
 * github_budget.gh_timeout_seconds setting). Only the parsed fields leave
 * here: gh's output is never logged.
 */
import { execFile } from "child_process";
import { rateFromHeaders, type RateLimit } from "./budget.js";

export interface GithubGet {
  status: number;
  etag: string | null;
  body: unknown;
  rate: RateLimit | null;
}

export interface GithubHttp {
  /** GET a REST path ("/repos/o/r/..."), conditional on `etag`. */
  get(p: string, etag?: string | null): Promise<GithubGet>;
  /** GET /rate_limit's core budget (free). */
  rateLimit(): Promise<RateLimit | null>;
}

/** gh's `-i` output: the status line, headers, a blank line, the body. */
export function parseIncluded(
  out: string,
): { status: number; headers: Headers; body: string } | null {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(out);
  if (!m) return null;
  const rest = out.slice(m[0].length);
  const end = /\r?\n\r?\n/.exec(rest);
  const head = end ? rest.slice(0, end.index) : rest;
  const body = end ? rest.slice(end.index + end[0].length) : "";
  const headers = new Headers();
  for (const line of head.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    try {
      headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
    } catch {
      /* a header Headers won't take: not one we read */
    }
  }
  return { status: Number(m[1]), headers, body };
}

/** An owner/repo REST path, or rate_limit: what Den may ask gh for. */
const PATH_RE =
  /^\/(rate_limit|repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/?=&-]+)$/;
/** An ETag as GitHub sends it: W/"…" or "…", printable, no newline. */
const ETAG_RE = /^(W\/)?"[\x21\x23-\x7e]{1,200}"$/;

export function createGhCliHttp(o: {
  /** gh's name or path (default "gh", found on PATH). */
  bin?: string;
  /** The env gh runs with (default this process's). */
  env?: NodeJS.ProcessEnv;
  /** github_budget.gh_timeout_seconds, in ms, read on each call. */
  timeoutMs: () => number;
}): GithubHttp {
  const bin = o.bin ?? "gh";
  const run = (args: string[]) =>
    new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          encoding: "utf-8",
          timeout: o.timeoutMs(),
          maxBuffer: 32 * 1024 * 1024,
          ...(o.env ? { env: o.env } : {}),
        },
        (err, stdout) => {
          const e = err as {
            code?: unknown;
            killed?: boolean;
            message: string;
          } | null;
          if (e && typeof e.code !== "number")
            // Not found, timed out, killed: no answer to read.
            return reject(
              new Error(
                e.code === "ENOENT"
                  ? "gh isn't installed here (Den asks GitHub through it)"
                  : `gh didn't answer (${e.killed ? "timed out" : String(e.code ?? e.message)})`,
              ),
            );
          resolve({ code: e ? (e.code as number) : 0, stdout: stdout ?? "" });
        },
      );
    });

  async function get(p: string, etag?: string | null): Promise<GithubGet> {
    if (!PATH_RE.test(p)) throw new Error(`not a path Den asks for: ${p}`);
    const args = ["api", "-i"];
    if (etag && ETAG_RE.test(etag)) args.push("-H", `If-None-Match: ${etag}`);
    args.push(p.slice(1));
    const r = await run(args);
    const parsed = parseIncluded(r.stdout);
    if (!parsed) throw new Error(`gh gave no answer for ${p} (exit ${r.code})`);
    let body: unknown = null;
    if (parsed.status !== 304 && parsed.body)
      try {
        body = JSON.parse(parsed.body);
      } catch {
        body = null;
      }
    return {
      status: parsed.status,
      etag: parsed.headers.get("etag"),
      body,
      rate: rateFromHeaders(parsed.headers),
    };
  }

  return {
    get,
    async rateLimit() {
      const r = await get("/rate_limit");
      const core = (
        r.body as {
          resources?: {
            core?: { limit?: number; remaining?: number; reset?: number };
          };
        } | null
      )?.resources?.core;
      if (
        r.status !== 200 ||
        typeof core?.remaining !== "number" ||
        typeof core.limit !== "number" ||
        typeof core.reset !== "number"
      )
        return null;
      return {
        remaining: core.remaining,
        limit: core.limit,
        reset: core.reset,
      };
    },
  };
}
