/**
 * Issue 487: the GitHub budget guard on the web.
 *   GET  /api/github/budget  the account's budget as Den last read it
 *                            (remaining, limit, reset), the reserve, the
 *                            poll interval, whether it is below the
 *                            reserve, the last hour's spend per caller
 *                            (Coach reads spend per agent), and what the
 *                            watcher watches now. A read.
 *   POST /api/ci/wait        {repo: "owner/repo", run?: id, pr?: number,
 *                            timeout_seconds?}: wait for a workflow run or
 *                            a PR's checks through Den's one watcher. Held
 *                            at most holdSeconds (the MCP tool ci_wait
 *                            asks again until its own timeout). Below the
 *                            reserve an agent's wait is 429, with the
 *                            reason and resetAt; a person's never is.
 * Who waits comes from the request's credential, never the body.
 */
import type * as http from "http";
import type { GithubBudget } from "../../shared/github-budget/budget.js";
import {
  REPO_RE,
  type CiWatcher,
} from "../../shared/github-budget/ci-watcher.js";
import type { GithubBudgetSettings } from "../../shared/github-budget/settings.js";
import { readBody, sendJson } from "./http-helpers.js";
import { principalOf } from "./request-guard.js";

export const GITHUB_BUDGET_PATHS = [
  "/api/github/budget",
  "/api/ci/wait",
] as const;

export const isGithubBudgetPath = (p: string) =>
  (GITHUB_BUDGET_PATHS as readonly string[]).includes(p);

/** The longest one POST /api/ci/wait is held, by default (seconds). */
export const CI_WAIT_HOLD_SECONDS = 50;

export interface GithubBudgetRouteDeps {
  budget: GithubBudget;
  watcher: CiWatcher;
  settings: () => GithubBudgetSettings;
  /** Who asks (agent:<id>, person:<user>); default the credential's. */
  actorOf?: (req: http.IncomingMessage) => string | undefined;
  holdSeconds?: number;
}

const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v < 2 ** 53
    ? v
    : undefined;

export async function handleGithubBudgetRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: GithubBudgetRouteDeps,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (pathname === "/api/github/budget") {
    if (method !== "GET" && method !== "HEAD")
      return sendJson(res, { ok: false, error: "GET only" }, 405);
    const s = d.settings();
    // rate_limit is free: read it again when the last reading is old.
    if (d.budget.age() > s.pollSeconds * 1000) await d.budget.refresh();
    const snap = d.budget.snapshot();
    const below = d.budget.check({ actor: "agent:" }).ok === false;
    return sendJson(res, {
      budget: snap
        ? {
            remaining: snap.remaining,
            limit: snap.limit,
            reset: snap.reset,
            readAt: snap.readAt,
          }
        : null,
      reserve: s.reserve,
      pollSeconds: s.pollSeconds,
      watchMinSeconds: s.watchMinSeconds,
      below,
      spend: d.budget.spendBy(),
      watching: d.watcher.stats(),
    });
  }
  if (pathname !== "/api/ci/wait")
    return sendJson(res, { ok: false, error: "no such route" }, 404);
  if (method !== "POST")
    return sendJson(res, { ok: false, error: "POST only" }, 405);
  let b: Record<string, unknown> = {};
  try {
    const raw = await readBody(req);
    const v: unknown = JSON.parse(raw.length > 4096 ? "{}" : raw || "{}");
    if (v && typeof v === "object" && !Array.isArray(v))
      b = v as Record<string, unknown>;
  } catch {
    /* b stays empty */
  }
  const repo = typeof b.repo === "string" ? b.repo : "";
  const run = posInt(b.run);
  const pr = posInt(b.pr);
  if (!REPO_RE.test(repo) || (run === undefined) === (pr === undefined))
    return sendJson(
      res,
      {
        ok: false,
        code: "bad_request",
        error:
          'give repo ("owner/repo") and one of run (a run id) or pr (a number)',
      },
      400,
    );
  const hold = d.holdSeconds ?? CI_WAIT_HOLD_SECONDS;
  const asked =
    typeof b.timeout_seconds === "number" && b.timeout_seconds > 0
      ? b.timeout_seconds
      : hold;
  const actor = (d.actorOf ?? principalOf)(req) ?? "person:browser";
  // Refresh the reading first when Den has none (rate_limit is free).
  if (!d.budget.current()) await d.budget.refresh();
  const r = await d.watcher.wait({
    repo,
    ...(run !== undefined ? { run } : { pr }),
    timeoutSeconds: Math.min(asked, hold),
    actor,
  });
  if (r.refused)
    return sendJson(
      res,
      {
        ok: false,
        code: "github_budget_reserve",
        error: r.refused.reason,
        resetAt: r.refused.resetAt,
        ...r,
      },
      429,
    );
  return sendJson(res, r);
}
