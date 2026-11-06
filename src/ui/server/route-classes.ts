/**
 * Every route the web server dispatches, with its class (SEC-1 spec §3, §4).
 * One source for the request checks (request-guard.ts) and, in SEC-1b, for
 * which routes need a signed-in session.
 *
 *   readonly     reads state. A GET passes with the Host check alone (§6),
 *                even when it runs a read-only probe (a health check, a
 *                `git rev-parse`, a `docker logs` tail).
 *   mutating     changes state: config, workspaces, the lock, a deploy.
 *   shell-grade  runs a command or a process for the caller: a service's
 *                lifecycle command, a test run, a workspace command, a sync
 *                (git in the checkouts), an SSO login, an agent's start or
 *                resume. SEC-1b adds "needs a signed-in session"; until
 *                then it gets the mutating checks.
 *
 * POST, PUT, PATCH and DELETE are checked as mutations by method, whatever
 * the table says; they are listed so SEC-1b reads one table. A GET that is
 * `mutating` or `shell-grade` (an EventSource can't send a header, so these
 * stream over GET) gets the mutating-GET check in request-guard.ts:
 * same-origin only, or a CLI's bearer.
 *
 * Paths: literal segments, `:name` for one segment, a trailing `*` for a
 * prefix. tests/unit/server/route-classes.test.ts scans the dispatchers'
 * source and fails on a route this table doesn't classify.
 */

export type RouteClass = "readonly" | "mutating" | "shell-grade";
export type RouteMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteEntry {
  methods: readonly RouteMethod[];
  path: string;
  cls: RouteClass;
  /** Why, when the class isn't obvious from the name. */
  why?: string;
}

const R = (path: string, why?: string): RouteEntry => ({
  methods: ["GET", "HEAD"],
  path,
  cls: "readonly",
  ...(why ? { why } : {}),
});
const M = (methods: RouteMethod[], path: string, why?: string): RouteEntry => ({
  methods,
  path,
  cls: "mutating",
  ...(why ? { why } : {}),
});
const S = (methods: RouteMethod[], path: string, why: string): RouteEntry => ({
  methods,
  path,
  cls: "shell-grade",
  why,
});

export const ROUTES: readonly RouteEntry[] = [
  // ── Pages and the UI's files ────────────────────────────────────────────
  ...[
    "/",
    "/local-dev",
    "/local-dev.html",
    "/graph",
    "/graph.html",
    "/tests",
    "/index.html",
    "/services",
    "/services.html",
    "/environments",
    "/environments.html",
    "/release",
    "/release.html",
    "/edge",
    "/edge.html",
    "/logs",
    "/settings",
    "/settings.html",
    "/header.js",
    "/perf-report.js",
    "/workspace-picker.js",
    "/favicon.ico",
    "/theme.css",
    "/theme/*",
    "/theme-favicon",
    "/theme-favicon/*",
    "/vendor/*",
    "/report*",
    "/reports/security/*",
  ].map((p) => R(p)),
  R("/_den/throw", "a test-only route (DEN_DEBUG_ROUTES): it throws"),
  R("/api/_den/throw", "a test-only route (DEN_DEBUG_ROUTES): it throws"),

  // ── Read-only /api ──────────────────────────────────────────────────────
  ...[
    "/api/orgs",
    "/api/environments",
    "/api/app-url",
    "/api/modules",
    "/api/security/latest",
    "/api/security/plan",
    "/api/stacks",
    "/api/edge",
    "/api/activity",
    "/api/server-log",
    "/api/perf-report/current",
    "/api/health/stream",
    "/api/services",
    "/api/service/daemons",
    "/api/service/history",
    "/api/logs/search",
    "/api/catalog",
    "/api/:cli/config",
    "/api/session",
    "/api/server-info",
    "/api/release/config",
    "/api/release/status",
    "/api/release/runs",
    "/api/release/branches",
    "/api/release/deploy/active",
    "/api/changelog",
    "/api/sudo-password/status",
    "/api/sudo-password/vault-status",
    "/api/scope",
    "/api/settings",
    "/api/themes",
    "/api/workspaces",
    "/api/workspaces/cleanup-preview",
    "/api/github/branches",
    "/api/github/repos",
    "/api/workspaces/available-repos",
    "/api/workspaces/services",
    "/api/workspaces/settings",
    "/api/workspaces/deps-check",
    "/api/graph",
    "/api/applications",
    "/api/personas",
    "/api/workspaces/:ws/agents",
  ].map((p) => R(p)),
  R("/api/health", "runs the manifests' health probes: read-only checks"),
  R("/api/test-sources", "git rev-parse in each repo: read-only"),
  R("/api/manifest/validate", "GET validates a file at a path: read-only"),
  R("/api/service/logs", "reads (and follows) a service's log"),
  R("/api/service/taillog", "tails a service's log (tail, docker logs)"),
  R(
    "/api/release/deploy",
    "GET attaches to a deploy session's log; it starts nothing",
  ),

  // ── Shell-grade GETs: they run something (SSE, so they are GETs) ────────
  S(
    ["GET", "HEAD"],
    "/api/service/exec",
    "runs a service's lifecycle command (up, down, restart, …)",
  ),
  S(["GET", "HEAD"], "/api/run", "starts a test run (playwright, k6, ZAP)"),
  S(["GET", "HEAD"], "/api/workspace/exec", "runs a workspace command"),
  S(
    ["GET", "HEAD", "POST"],
    "/api/workspace/sync",
    "runs git in the workspace's checkouts (clone, pull)",
  ),
  S(["GET", "HEAD"], "/api/aws/login", "runs `aws sso login`"),

  // ── Mutations (checked by method) ───────────────────────────────────────
  M(["POST"], "/api/activity", "an agent's refused-call report"),
  M(["POST"], "/api/web/restart", "restarts this server"),
  M(["PUT"], "/api/release/config"),
  M(["POST", "DELETE"], "/api/release/deploy", "starts or dismisses a deploy"),
  M(["POST"], "/api/manifest/validate", "validates posted content (no write)"),
  M(["POST"], "/api/local-dev"),
  M(["POST"], "/api/sudo-password", "opens the lock (R8)"),
  M(["POST"], "/api/sudo-password/load-from-vault", "opens the lock (R8)"),
  M(["POST"], "/api/scope"),
  M(["POST"], "/api/settings"),
  M(
    ["POST"],
    "/api/editor/open",
    "opens a checkout in the person's editor app",
  ),
  M(
    ["POST"],
    "/api/terminal/open",
    "opens a terminal app window at a checkout; nothing is typed into it",
  ),
  M(["POST", "DELETE"], "/api/workspaces"),
  M(["POST"], "/api/workspaces/rename"),
  M(["POST"], "/api/workspaces/create"),
  M(["POST"], "/api/workspaces/services/autostart"),
  M(["POST"], "/api/workspaces/services/mode"),
  M(["POST", "DELETE"], "/api/workspaces/services"),
  M(["POST"], "/api/workspaces/settings"),
  M(["POST"], "/api/workspaces/:ws/agents/:id/stop", "TERM to its session"),
  S(
    ["POST"],
    "/api/workspaces/:ws/agents",
    "starts an agent: a runtime in a PTY",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/resume",
    "resumes an agent: a runtime in a PTY",
  ),
];

/** The dispatchers' route regexes, by `<file>:<const>`, and their entries. */
export const REGEX_ROUTES: Readonly<Record<string, readonly string[]>> = {
  "agent-routes.ts:AGENTS_PATH": [
    "/api/workspaces/:ws/agents",
    "/api/workspaces/:ws/agents/:id/stop",
    "/api/workspaces/:ws/agents/:id/resume",
  ],
};

/** Whether `pathname` matches a table path. */
export function pathMatches(pattern: string, pathname: string): boolean {
  if (pattern.endsWith("*")) return pathname.startsWith(pattern.slice(0, -1));
  const a = pattern.split("/");
  const b = pathname.split("/");
  if (a.length !== b.length) return false;
  return a.every((seg, i) =>
    seg.startsWith(":") ? b[i] !== "" : seg === b[i],
  );
}

/**
 * The class of `method pathname`: the most specific entry that lists the
 * method (a literal path before a pattern, a pattern before a prefix).
 * Null when no entry matches.
 */
export function routeClass(
  method: string,
  pathname: string,
): RouteClass | null {
  const m = method.toUpperCase();
  const hits = ROUTES.filter(
    (e) =>
      (e.methods as readonly string[]).includes(m) &&
      pathMatches(e.path, pathname),
  );
  if (!hits.length) return null;
  const rank = (e: RouteEntry) =>
    e.path.endsWith("*") ? 2 : e.path.includes(":") ? 1 : 0;
  hits.sort((x, y) => rank(x) - rank(y));
  return hits[0].cls;
}

/** A GET (or HEAD) that runs or changes something: the mutating-GET check. */
export function isMutatingGet(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  const c = routeClass(m, pathname);
  return c === "mutating" || c === "shell-grade";
}
