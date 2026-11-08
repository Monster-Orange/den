/**
 * Every route the web server dispatches, with its class (SEC-1 spec §3, §4).
 * One source for the request checks (request-guard.ts) and for which routes
 * need a signed-in session (SEC-1b).
 *
 *   readonly     reads state. On loopback a GET passes with the Host check
 *                alone (§6), even when it runs a read-only probe (a health
 *                check, a `git rev-parse`, a `docker logs` tail).
 *   mutating     changes state or runs a declared lifecycle command: config,
 *                workspaces, the lock, a deploy, a service's up/down, a test
 *                run, a sync, an SSO login (§4: "up, down, restart, …").
 *                Origin and CSRF; the session's CSRF when one is signed in.
 *   shell-grade  a shell for the caller, or what manages them: an agent's
 *                start or resume (a runtime in a PTY), the browser
 *                sessions, and (AG-4a-term) /api/sessions/*. On loopback
 *                Origin and CSRF, as mutating, and no sign-in (Ward,
 *                2026-11-06); an agent's token never reaches one but its
 *                own session's.
 *
 * Beyond loopback (the edge hostname, or a peer that isn't loopback) every
 * class needs a signed-in session or a bearer (§4); SIGNIN_FREE lists the
 * only routes that don't (how a browser gets a session, and what it asks
 * first).
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
    "/agents",
    "/agents.html",
    "/server-agent",
    "/server-agent.html",
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
    "/report",
    "/report/*",
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
    // 0.4.17: each repo's last test run, from the run-history file.
    "/api/runs/last",
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
    "/api/agents/runtimes",
    "/api/workspaces/:ws/agents",
  ].map((p) => R(p)),
  R("/api/personas/:id", "one persona with its instructions (AG-10.6 Details)"),
  M(
    ["POST"],
    "/api/personas",
    "New persona: a person's own, in the state dir (AG-10.7); never an agent's token",
  ),
  M(
    ["POST", "DELETE"],
    "/api/personas/:id",
    "edits or deletes a person's own persona (AG-10.7); never an agent's token",
  ),
  R(
    "/api/workspaces/:ws/conversations",
    "lists a runtime's own conversations in the workspace's folder: titles only, the ends of each file (AG-17.1)",
  ),
  R(
    "/api/workspaces/:ws/agents/:id/paths",
    "which paths an agent printed exist in its workspace (stat only, AG-4b)",
  ),
  R(
    "/api/sessions",
    "lists the sessions and agents (names and states, never their output)",
  ),
  R(
    "/api/server-agent",
    "the server agent's name, runtime and state (ON-6): reads only",
  ),
  R("/api/health", "runs the manifests' health probes: read-only checks"),
  R("/api/test-sources", "git rev-parse in each repo: read-only"),
  R("/api/manifest/validate", "GET validates a file at a path: read-only"),
  // ON-3 (onboard-routes.ts): reads only; nothing written, no repo tool run.
  R("/api/onboard/status", "what's set up and the next step (file reads)"),
  R(
    "/api/onboard/repos",
    "lists the git repos in a folder in home; never follows a symlink",
  ),
  R(
    "/api/onboard/manifest",
    "drafts and validates a side-car manifest; writes nothing",
  ),
  // ON-3's held writes (approval-routes.ts): asking runs nothing; Allow is
  // the person's signed-in browser only (approvals.ts approverAllowed).
  R("/api/approvals", "what waits for the person (never an agent's token)"),
  R("/api/approvals/:id", "one held request: the asker's own, or the person's"),
  M(
    ["POST"],
    "/api/approvals",
    "holds an agent's write for the person; nothing runs until they allow it",
  ),
  M(
    ["POST"],
    "/api/approvals/:id/decide",
    "the person's Allow runs the held write once; Deny runs nothing",
  ),
  R("/api/service/logs", "reads (and follows) a service's log"),
  R("/api/service/taillog", "tails a service's log (tail, docker logs)"),
  R(
    "/api/release/deploy",
    "GET attaches to a deploy session's log; it starts nothing",
  ),

  // ── GETs that run something (SSE, so they are GETs): mutating (§4) ─────
  M(
    ["GET", "HEAD"],
    "/api/service/exec",
    "runs a service's lifecycle command (up, down, restart, …)",
  ),
  M(["GET", "HEAD"], "/api/run", "starts a test run (playwright, k6, ZAP)"),
  M(
    ["GET", "HEAD"],
    "/api/workspace/exec",
    "runs a workspace's lifecycle command over its services",
  ),
  M(
    ["GET", "HEAD", "POST"],
    "/api/workspace/sync",
    "runs git in the workspace's checkouts (clone, pull)",
  ),
  M(["GET", "HEAD"], "/api/aws/login", "runs `aws sso login`"),

  // ── Sign-in (SEC-1b, §2) ────────────────────────────────────────────────
  M(
    ["GET", "HEAD", "POST"],
    "/auth",
    "swaps a one-time login code for a session cookie (POST: with the code `web login` printed)",
  ),
  R(
    "/signin",
    "the signed-out landing page (§6b.3): it renders signed out; signed in, it goes on to `next`",
  ),
  M(["POST"], "/api/session/logout", "ends this browser's session"),
  S(
    ["GET", "HEAD"],
    "/api/web/sessions",
    "lists the browser sessions (`web sessions`)",
  ),
  S(
    ["POST"],
    "/api/web/logout",
    "ends browser sessions, and rotates web.secret (`web logout`)",
  ),
  // ── SEC-2a: GitHub sign-in, the owner, pairing ─────────────────────────
  M(
    ["POST"],
    "/api/github/signin",
    "starts a GitHub sign-in (a device flow the server runs)",
  ),
  M(
    ["GET", "HEAD"],
    "/api/github/signin/:id",
    "a GitHub sign-in's outcome; once the owner approved it, sets the session cookie",
  ),
  R("/api/web/owner", "who the owner is (`web owner show`)"),
  S(
    ["POST"],
    "/api/web/owner/link",
    "links the owner's GitHub account (`web owner link`)",
  ),
  S(
    ["GET", "HEAD"],
    "/api/web/owner/link/:id",
    "an owner link's device code and outcome",
  ),
  S(
    ["POST"],
    "/api/web/owner/unlink",
    "unlinks the owner (`web owner unlink`)",
  ),
  R("/api/web/pair", "the edge hostnames a pairing link can be for"),
  // ── SEC-2a: approve this computer with a code (pair-routes.ts) ─────────
  M(
    ["POST"],
    "/api/signin/code",
    "asks for a code the owner approves this browser with (in memory, 10 minutes)",
  ),
  M(
    ["GET", "HEAD"],
    "/api/signin/code/:id",
    "a code request's state; once approved, sets the session cookie (once)",
  ),
  S(
    ["GET", "HEAD"],
    "/api/web/waiting",
    "lists the devices waiting for approval (Settings › Access, `web approve --list`)",
  ),
  S(
    ["POST"],
    "/api/web/approve",
    "approves a waiting device: it signs in (`web approve <code>`)",
  ),
  S(["POST"], "/api/web/deny", "denies a waiting device"),
  S(
    ["POST"],
    "/api/web/logins",
    "registers `web login`'s link and its code, to wait on",
  ),
  S(
    ["GET", "HEAD"],
    "/api/web/logins/:id",
    "`web login`'s wait: whether its link was used, by which browser",
  ),
  S(
    ["POST"],
    "/api/web/pair",
    "mints a one-time sign-in link for another device (Pair a device)",
  ),

  // ── Mutations (checked by method) ───────────────────────────────────────
  M(["POST"], "/api/activity", "an agent's refused-call report"),
  M(["POST"], "/api/web/restart", "restarts this server"),
  M(["PUT"], "/api/release/config"),
  M(["POST", "DELETE"], "/api/release/deploy", "starts or dismisses a deploy"),
  M(["POST"], "/api/manifest/validate", "validates posted content (no write)"),
  M(["POST"], "/api/local-dev"),
  M(["POST"], "/api/sudo-password", "sets the admin password, for sudo (R8)"),
  M(
    ["POST"],
    "/api/sudo-password/load-from-vault",
    "sets the admin password from the vault, for sudo (R8)",
  ),
  M(["POST"], "/api/sudo-password/forget", "forgets the admin password (R8)"),
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
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/name",
    "the name a person gave an agent (AG-4b); its id never changes",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/remove",
    "forgets a stopped agent (AG-14.1b); its record waits for Undo",
  ),
  M(
    ["POST"],
    "/api/agents/clear-stopped",
    "forgets every stopped agent of the workspaces named (AG-14.1b)",
  ),
  M(["POST"], "/api/agents/restore", "Undo: brings removed agents back"),
  S(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/fresh",
    "starts an agent afresh: a runtime in a PTY",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/persona",
    "changes an agent's persona (AG-18): its session stops and the same conversation resumes, a runtime in a PTY; a person's only",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/relaunch",
    "relaunches a rotated agent from its handoff: a runtime in a PTY (den#4)",
  ),
  S(
    ["POST"],
    "/api/agents/resume-interrupted",
    "resumes interrupted agents: runtimes in PTYs (AG-14.3)",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/agents",
    "starts an agent: a runtime in a PTY",
  ),
  S(
    ["POST"],
    "/api/server-agent/start",
    "starts the server agent (ON-6): a runtime in a PTY; never an agent's token",
  ),
  M(
    ["POST"],
    "/api/server-agent/runtime",
    "the person's choice of the server agent's runtime (user.yml); never an agent's token",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/conversations/:id/import",
    "brings in a conversation: its runtime's resume in a PTY (AG-17.1)",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/sessions",
    "starts a plain session: the person's login shell in the workspace (AG-10.1)",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/resume",
    "resumes an agent: a runtime in a PTY",
  ),
  S(
    ["POST"],
    "/api/agents/runtimes/:id/path",
    "runs the path given (its version command) before saving it as a runtime's CLI (AG-0.5)",
  ),
  S(
    ["GET", "HEAD"],
    "/api/sessions/:id/io",
    "a session's terminal (AG-4a-term): a WebSocket, its input a shell's",
  ),
  S(
    ["GET", "HEAD", "POST", "DELETE"],
    "/api/sessions/*",
    "a session's own routes (AG-4a-term's io): an agent's token reaches its own session's only",
  ),
];

/**
 * The routes that never need a signed-in session, even beyond loopback:
 * the sign-in itself, the signed-out landing page (it checks the session
 * itself), and the session probe the shell and the signed-out page ask
 * first (it hands out a CSRF token only to a session, or on loopback).
 */
export const SIGNIN_FREE: readonly string[] = [
  "/auth",
  "/signin",
  "/api/session",
  // SEC-2a: Sign in with GitHub, from the signed-out page.
  "/api/github/signin",
  "/api/github/signin/:id",
  // SEC-2a: approve this computer with a code, from the signed-out page.
  "/api/signin/code",
  "/api/signin/code/:id",
];

/**
 * SIGNIN_FREE mutations a signed-out page makes, which holds no CSRF token:
 * they need an allowed Origin only (SEC-2a: starting a GitHub sign-in, and
 * asking for a code to be approved with).
 */
export const SIGNIN_CSRF_FREE: readonly string[] = [
  "/api/github/signin",
  "/api/signin/code",
  // SEC-2a: a waited-on link's page posts the code `web login` printed.
  "/auth",
];

/**
 * Sign-in GETs that carry their own unguessable credential: /auth a one-time
 * code derived from web.secret, the GitHub sign-in poll its flow id, the
 * code request's poll its own id (never the code). They
 * may come with no fetch metadata at all (request-guard.ts,
 * mutatingGetRefusal): a plain-http LAN origin gets none from the browser.
 */
export const SIGNIN_GETS: readonly string[] = [
  "/auth",
  "/api/github/signin/:id",
  "/api/signin/code/:id",
];

/** The dispatchers' route regexes, by `<file>:<const>`, and their entries. */
export const REGEX_ROUTES: Readonly<Record<string, readonly string[]>> = {
  "agent-routes.ts:AGENTS_PATH": [
    "/api/workspaces/:ws/agents",
    "/api/workspaces/:ws/agents/:id/stop",
    "/api/workspaces/:ws/agents/:id/resume",
    "/api/workspaces/:ws/agents/:id/fresh",
    "/api/workspaces/:ws/agents/:id/relaunch",
    "/api/workspaces/:ws/agents/:id/remove",
    "/api/workspaces/:ws/agents/:id/name",
    "/api/workspaces/:ws/agents/:id/paths",
    "/api/workspaces/:ws/agents/:id/persona",
  ],
  "agent-routes.ts:RUNTIME_PATH": ["/api/agents/runtimes/:id/path"],
  "agent-routes.ts:PERSONA_PATH": ["/api/personas/:id"],
  "agent-routes.ts:PLAIN_PATH": ["/api/workspaces/:ws/sessions"],
  "agent-routes.ts:CONVERSATIONS_PATH": [
    "/api/workspaces/:ws/conversations",
    "/api/workspaces/:ws/conversations/:id/import",
  ],
  "session-routes.ts:IO_PATH": ["/api/sessions/:id/io"],
  "github-routes.ts:SIGNIN_PATH": ["/api/github/signin/:id"],
  "github-routes.ts:LINK_PATH": ["/api/web/owner/link/:id"],
  "pair-routes.ts:POLL_PATH": ["/api/signin/code/:id"],
  "index.ts:LOGIN_WAIT_PATH": ["/api/web/logins/:id"],
  "approval-routes.ts:ONE_PATH": ["/api/approvals/:id"],
  "approval-routes.ts:DECIDE_PATH": ["/api/approvals/:id/decide"],
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
