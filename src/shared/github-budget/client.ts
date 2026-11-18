/**
 * Issue 487: the GitHub REST calls Den's server makes for the CI watcher,
 * over HTTP with conditional requests: each GET carries the ETag of the
 * last answer (If-None-Match), and a 304 (unchanged) costs the account
 * nothing. rate_limit costs nothing either.
 *
 * The token comes from `token()` (the server reads the person's own gh
 * sign-in once); it is sent only to apiBase and never logged or returned.
 */
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

export const GITHUB_API = "https://api.github.com";

export function createGithubHttp(o: {
  apiBase?: string;
  token: () => Promise<string | null>;
  timeoutMs?: number;
}): GithubHttp {
  const apiBase = (o.apiBase ?? GITHUB_API).replace(/\/+$/, "");
  const timeoutMs = o.timeoutMs ?? 15_000;
  async function get(p: string, etag?: string | null): Promise<GithubGet> {
    const token = await o.token();
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "den-ci-watcher",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (etag) headers["if-none-match"] = etag;
    const res = await fetch(`${apiBase}${p}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = res.status === 304 ? "" : await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return {
      status: res.status,
      etag: res.headers.get("etag"),
      body,
      rate: rateFromHeaders(res.headers),
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
