/**
 * Every route the web server dispatches, with its class (SEC-1 spec §3, §4).
 * One source for the request checks (request-guard.ts) and for which routes
 * need a signed-in session (SEC-1b).
 *
 *   readonly     reads state, and starts no process on the request. On
 *                loopback a GET passes with the Host check alone (§6). A
 *                GET that starts a process (a `tail`, a `docker logs`, a
 *                probe command) is `mutating`, never `readonly` (0.4.71).
 *   mutating     changes state or runs something: config, workspaces, the
 *                lock, a deploy, a service's up/down, a test run, a sync,
 *                an SSO login (§4: "up, down, restart, …"), a log tail.
 *                A sign-in (a session or a bearer), then Origin and the
 *                session's CSRF.
 *   shell-grade  a shell for the caller, or what manages them: an agent's
 *                start or resume (a runtime in a PTY), the browser
 *                sessions, and (AG-4a-term) /api/sessions/*. As mutating;
 *                an agent's token never reaches one but its own session's.
 *
 * Beyond loopback (the edge hostname, or a peer that isn't loopback) every
 * class needs a signed-in session or a bearer (§4); on loopback every class
 * but `readonly` does (0.4.71). SIGNIN_FREE lists the only routes that
 * never do (how a browser gets a session, and what it asks first).
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
    // Issue 482: the Terminals page.
    "/terminals",
    "/server-agent",
    "/server-agent.html",
    "/tests",
    "/verify",
    "/verify.html",
    "/test-runs",
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
    "/project-colour-picker.js",
    "/favicon.ico",
    // Issue 644: the kit's site files (its head snippet names them).
    "/favicon.svg",
    "/apple-touch-icon.png",
    "/icon-192.png",
    "/icon-512.png",
    "/icon-maskable-512.png",
    "/site.webmanifest",
    // Issue 172: the app manifest (a phone's home screen, for push).
    "/manifest.webmanifest",
    "/theme.css",
    "/theme/*",
    "/theme-favicon",
    "/theme-favicon/*",
    "/vendor/*",
    // den-ui (UK-1): the kit's tokens, base and fonts.
    "/kit/*",
    "/report",
    "/report/*",
    "/reports/security/*",
  ].map((p) => R(p)),
  R(
    "/p/:project/agents/:id",
    "issue 103: a deep link to one agent; the page, its composer filled, nothing sent",
  ),
  R(
    "/embed/p/:project/agents/:id",
    "issue 103: the embedded agent pane, framed only by listed origins; holds no data (sign-in free)",
  ),
  R(
    "/embed/connect",
    "issue 103: the pop-up that lets a listed web app use an agent (a person, signed in)",
  ),
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
    // Issue 455: the address check (banner, Edge) and the
    // identity probe's other end.
    "/api/edge/address",
    "/api/den-identity",
    "/api/activity",
    "/api/server-log",
    "/api/perf-report/current",
    "/api/health/stream",
    "/api/services",
    "/api/service/daemons",
    "/api/catalog",
    "/api/:cli/config",
    "/api/session",
    "/api/server-info",
    // BUSY-1: how a write sent with the working pop-up's id ended.
    "/api/requests/*",
    // UK-2: the same, at the kit's path (the /api name goes in 0.4.49).
    "/requests/*",
    "/api/release/config",
    "/api/release/status",
    "/api/release/runs",
    // 0.4.17: each repo's last test run, from the run-history file.
    "/api/runs/last",
    "/api/release/branches",
    "/api/release/deploy/active",
    "/api/changelog",
    // Issue 52: the Coach's settings and last report (counts only).
    "/api/coach",
    "/api/sudo-password/status",
    "/api/sudo-password/vault-status",
    "/api/scope",
    "/api/settings",
    // MODE-5: this install's address, and its check's other end.
    "/api/web-url",
    "/api/web-url/probe",
    // FB (den#81): Report an issue's destinations, diagnostics and drafts.
    "/api/report",
    "/api/report/diagnostics",
    "/api/report/drafts",
    "/api/report/drafts/:id",
    "/api/report/github-send/:id",
    // Issue 403: where a report's screenshot goes (Hub's answer, a read),
    // and a kept one (the person or this install's own agent only).
    "/api/report/shot-share",
    "/api/report/shots/:id",
    "/api/themes",
    "/api/workspaces",
    "/api/workspaces/cleanup-preview",
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
    "lists a runtime's own conversations in the project's folder: titles only, the ends of each file (AG-17.1)",
  ),
  R(
    "/api/workspaces/:ws/agents/:id/paths",
    "which paths an agent printed exist in its project (stat only, AG-4b)",
  ),
  R(
    "/api/workspaces/:ws/agents/:id/file",
    "AG-DROP-2: a file in an agent's project, cwd or uploads, as a download (audited)",
  ),
  R(
    "/api/workspaces/:ws/agents/:id/helpers",
    "D32: the helpers an agent started in its own session, read from the runtime's files (never written)",
  ),
  R(
    "/api/workspaces/:ws/agents/:id/details",
    "D45: a stopped agent's details: what it was last asked (one line from its transcript) and how its session ended (exit code, last line, redacted)",
  ),
  R(
    "/api/workspaces/:ws/agents/:id/tools",
    "D44: whether an agent's MCP servers are current (Hub connected, loaded in its session, a restart needed); an agent may read its own",
  ),
  R(
    "/api/agents/stale",
    "D44: the running agents whose MCP servers are out of date (ids and projects)",
  ),
  R(
    "/api/workspaces/:ws/agents/:id/helpers/:helper",
    "D32: one helper's transcript, tool calls summarized, read-only (no stop or steer)",
  ),
  R(
    "/api/sessions/helpers",
    "D32: how many helpers the agents have running (a count, for the rail's badge)",
  ),
  R(
    "/api/sessions",
    "lists the sessions and agents (names and states, never their output)",
  ),
  R(
    "/api/server-agent",
    "the server agent's name, runtime and state (ON-6): reads only",
  ),
  R(
    "/api/server-agent/update",
    "#176: Den's last update and the new Den's doctor lines: file reads",
  ),
  R("/api/health", "runs the manifests' health probes: read-only checks"),
  R("/api/test-sources", "git rev-parse in each repo: read-only"),
  M(
    ["GET", "HEAD"],
    "/api/manifest/validate",
    "reads a file at a path, inside a repo: Den's own page or a token",
  ),
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
  M(
    ["POST"],
    "/api/approvals/:id/withdraw",
    "the asker takes back its own held write (issue 142); nothing runs",
  ),
  // 0.4.71: each starts a process for its output (a log command, `tail`,
  // `docker logs`, `grep`): a sign-in, as every GET that runs something.
  M(
    ["GET", "HEAD"],
    "/api/service/logs",
    "follows a service's log: runs its log command",
  ),
  M(
    ["GET", "HEAD"],
    "/api/service/taillog",
    "tails a service's log (tail, docker logs)",
  ),
  M(
    ["GET", "HEAD"],
    "/api/service/history",
    "a service's log history (docker ps, docker logs)",
  ),
  M(
    ["GET", "HEAD"],
    "/api/logs/search",
    "searches the logs (grep, docker logs)",
  ),
  // They run gh as the person: what its sign-in can see, and its quota.
  M(["GET", "HEAD"], "/api/github/branches", "lists a repo's branches (gh)"),
  M(["GET", "HEAD"], "/api/github/repos", "lists the person's repos (gh)"),
  M(
    ["GET", "HEAD"],
    "/api/report/mine",
    "the person's own reports, live (gh; an agent gets 403)",
  ),
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
    "runs a project's lifecycle command over its services",
  ),
  M(
    ["GET", "HEAD", "POST"],
    "/api/workspace/sync",
    "runs git in the project's checkouts (clone, pull)",
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
  R(
    "/attest",
    'D17: "This is my computer", on localhost only: a 303 back to one of this server\'s edge hosts with a short-lived code (it never makes a session)',
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
  M(
    ["DELETE"],
    "/api/signin/code/:id",
    "D67: the signed-out page is going; its pending code request ends",
  ),
  M(
    ["POST"],
    "/api/signin/code/:id/withdraw",
    "issue 320: the same, as the signed-out page's beacon sends it",
  ),
  R(
    "/api/web/fixture-person",
    "issue 810: whether this is a test install and its fixture person is set up (never the secret)",
  ),
  M(
    ["POST"],
    "/api/coach/run",
    "issue 52: the Coach's Run now, a person's (read-only: it reads transcripts and saves counts)",
  ),
  M(
    ["POST"],
    "/api/coach/dismiss",
    "issue 52: Dismiss a Coach finding, a person's, with the reason kept",
  ),
  M(
    ["POST"],
    "/api/web/fixture-person",
    "issue 810: Set up test person, a person's, on a test install only",
  ),
  M(
    ["POST"],
    "/api/web/fixture-person/setup-secret",
    "issue 1018: the person's CLI makes the test person from the launcher's one-time setup value, on a test install only",
  ),
  M(
    ["POST"],
    "/api/web/test-person",
    "issue 636: a test bed's CLI starts a --test-person command (the person's token, on a test bed only)",
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
  S(
    ["POST"],
    "/api/edge/up",
    "issue 395: Settings' Start the edge runs `edge up` (docker); a person's only, never an agent's token",
  ),
  S(
    ["POST"],
    "/api/edge/address/check",
    "issue 455: Check again; may set edge.publish: false for the person (user.yml); a person's only",
  ),
  S(
    ["POST"],
    "/api/edge/address/take-over",
    "issue 455: Take over stops an old Den edge holding the port and starts Den's own (docker); a person's only",
  ),

  // ── Mutations (checked by method) ───────────────────────────────────────
  M(["POST"], "/api/activity", "an agent's refused-call report"),
  M(["POST"], "/api/web/restart", "restarts this server"),
  M(["PUT"], "/api/release/config"),
  M(["POST", "DELETE"], "/api/release/deploy", "starts or dismisses a deploy"),
  M(["POST"], "/api/manifest/validate", "validates posted content (no write)"),
  R("/api/verify/overview", "issue 209: Verify's answer on each environment"),
  R("/api/verify/runs/:id", "issue 209: one Verify run's record"),
  R("/api/verify/runs/:id/report", "issue 209: a module's kept output"),
  M(
    ["POST"],
    "/api/verify/plan",
    "issue 208: plans a Verify run; runs nothing",
  ),
  M(
    ["POST"],
    "/api/verify/run",
    "issue 208: runs Verify's checks on local; any other environment is held",
  ),
  R("/api/verify/schedules", "issue 214: Verify's schedules and their Allows"),
  M(
    ["POST"],
    "/api/verify/schedules/allow",
    "issue 214: a person's standing Allow for a schedule's plan (a signed-in browser only)",
  ),
  M(
    ["POST"],
    "/api/verify/schedules/run",
    "issue 214: runs a schedule now, under its own Allow (a signed-in browser only)",
  ),
  M(
    ["POST"],
    "/api/verify/schedules/revoke",
    "issue 964: takes back a schedule's standing Allow (a signed-in browser only)",
  ),
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
  // MODE-5: Check and save this install's address (a person's only).
  M(["POST"], "/api/web-url"),
  // Issue 666: Make <alias> this Den's address (the owner's only).
  M(["POST"], "/api/web-url/adopt"),
  // Issue 163: Keep agents running after logout › Apply (a person's only).
  M(
    ["POST"],
    "/api/keep-running-after-logout",
    "re-installs Den's launchd jobs in the chosen mode",
  ),
  // #299: Keep agents running after logout › Sign-in token (a person's only).
  M(
    ["POST", "DELETE"],
    "/api/agents/signin-token",
    "saves (or removes) the agents' sign-in token in the install's secrets store",
  ),
  // Issue 339: the agents' sign-in accounts (a person's only).
  M(["POST"], "/api/agents/accounts", "adds a {vendor} account for agents"),
  M(
    ["POST"],
    "/api/agents/accounts/token",
    "saves a {vendor} account's token in the install's secrets store",
  ),
  M(
    ["POST"],
    "/api/agents/accounts/order",
    "changes the order agents use {vendor} accounts in",
  ),
  // FB: the preview composes (no write); a send is a person's only.
  M(
    ["POST"],
    "/api/report/preview",
    "composes the exact issue text (no write)",
  ),
  M(
    ["POST"],
    "/api/report/send",
    "files the report as the person, with their gh",
  ),
  M(["POST"], "/api/report/drafts", "saves a report draft on this computer"),
  M(["DELETE"], "/api/report/drafts/:id", "a person discards a draft"),
  M(
    ["POST"],
    "/api/report/github-send",
    "holds a report for the person's GitHub approval, then files it",
  ),
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
    "forgets every stopped agent of the projects named (AG-14.1b)",
  ),
  M(["POST"], "/api/agents/restore", "Undo: brings removed agents back"),
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/keep",
    "D28 Keep this conversation: resets its rotation count (and, asked, sets its override to never); a person's only",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/settings",
    "D59 an agent's own settings (resumeOnRestart: on, off, or null for its persona's); a person's only",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/mode",
    "issue 199 an agent's own mode, or null to follow its project's; a person's only (an agent asks with agent_mode)",
  ),
  R(
    "/api/workspaces/:ws/mcp-servers",
    "issue 335: a project's extra MCP servers, names and urls only (an agent adds one with project_mcp_add)",
  ),
  R(
    "/api/workspaces/:ws/event-feeds",
    "issue 459: a project's app event feeds and their state, names, agents and urls only",
  ),
  M(
    ["POST", "DELETE"],
    "/api/workspaces/:ws/mcp-servers/:name",
    "issue 352: a person changes one's url or bearer reference, or removes it; a person's only (an agent asks with project_mcp_update or project_mcp_remove)",
  ),
  R(
    "/api/workspaces/:ws/agent-modes",
    "issue 225: a project's mode and each agent's actual mode with where it comes from",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/agent-modes",
    "issue 225: a project's mode, and its agents with their own setting follow it; a person's only (an agent asks with project_mode)",
  ),
  M(
    ["POST"],
    "/api/embed/keys",
    "issue 103: a short-lived key for an embedded pane, for a listed origin; a person's only",
  ),
  R(
    "/api/embed/app-keys",
    "issue 334: the app keys a person made (agent, origin, name, last used); never a key; a person's only",
  ),
  R(
    "/api/embed/p/:project/agents/:id/state",
    "issue 334: one agent's state for a web app, its app key the proof (X-Den-Embed-Key)",
  ),
  S(
    ["POST"],
    "/api/embed/say",
    "issue 103: an embedded pane's Send, its key the proof (X-Den-Embed-Key): types into that one agent",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/say",
    "issue 103 a composer's Send: types a person's message into the agent's terminal, then Enter; a person's only",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/clear-helpers",
    "D34 Clear done: hides an agent's finished helpers (a mark in its files; Claude Code's are never touched); a person's only",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/compacting-clear",
    "issue 278: a person looked at an agent stuck compacting: its loop is over for now and held deliveries go again; a person's only",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/move",
    "D72 move an agent to another project ({to, when}): same conversation, at its next idle by default; a person's only",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/order",
    "Issue 96: move an agent in its project's order ({to}: up, down, top, bottom or a place); a person's only",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/link",
    "D65 v2 link an agent to a repo of its project ({repo}: a name, or null for none), kept through every restart; a person's only",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/agents/:id/handoff",
    "D28 Write handoff: types the handoff prompt into the agent's running session",
  ),
  R(
    "/api/agents/rotation",
    "D28: rotation settings, the overrides and an agent's effective values",
  ),
  R(
    "/api/workspaces/:ws/hub-project",
    "H5: the Hub project a project works on, and Hub's suggestions and projects for it (names only)",
  ),
  M(
    ["PUT"],
    "/api/workspaces/:ws/hub-project",
    "H5: link a project to one of the company's Hub projects, or unlink it; a person's only",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/hub-rename",
    "issue 167: ask Hub to rename a linked project's Hub project, as a held change a person decides in Hub; a person's only",
  ),
  M(
    ["POST"],
    "/api/workspaces/:ws/hub-create",
    "issue 271: ask Hub for a new project to link a project to, as a held change an owner decides in Hub; linked once allowed; a person's only (an agent asks with hub_project_create)",
  ),
  R(
    "/api/hub",
    "HUB-1.5: Den Hub: its URL, connected or not, the team and the install's label (never the token)",
  ),
  R(
    "/api/hub/github",
    "H5: how many of the company's GitHub repos Den Hub's GitHub App can read, live from Hub, with Hub's github.com install or change link",
  ),
  R(
    "/api/gate-slots",
    "Issue 144: who holds this machine's heavy-test slots and who waits, with the machine's settings",
  ),
  M(
    ["POST"],
    "/api/gate-slots/end",
    "Issue 144: a person ends a gate slot early (never an agent); the run is not stopped",
  ),
  M(
    ["POST"],
    "/api/gate-slots/ask",
    "Issue 621: a CI runner asks for a gate slot with its gate-only runner token (RUNNER_ROUTES); it holds by lease",
  ),
  M(
    ["POST"],
    "/api/gate-slots/renew",
    "Issue 621: a CI runner renews its slot's lease and hears where it stands; its runner token only",
  ),
  M(
    ["POST"],
    "/api/gate-slots/release",
    "Issue 621: a CI runner gives back its own slot; its runner token only",
  ),
  R(
    "/api/gate-slots/runners",
    "Issue 621: the gate-only runner tokens, for Settings: names and dates, never a token or its hash; a person's only",
  ),
  M(
    ["POST"],
    "/api/gate-slots/runners/revoke",
    "Issue 621: a person revokes a runner token; it answers 401 at once",
  ),
  R(
    "/api/gate-slots/boxes",
    "Issue 625: the test boxes (browser slots on other machines) as set; a person's only",
  ),
  M(
    ["POST"],
    "/api/gate-slots/boxes",
    "Issue 625: a person adds or replaces a test box; never an agent",
  ),
  M(
    ["POST"],
    "/api/gate-slots/boxes/remove",
    "Issue 625: a person removes a test box; its running slots finish",
  ),
  M(
    ["POST"],
    "/api/gate-slots/boxes/enable",
    "Issue 625: a person turns a test box on or off; off, it gets no slot and no contact",
  ),
  R(
    "/api/notifications",
    "NT-3: the bell: notifications grouped by project then agent, and who waits now",
  ),
  R(
    "/api/agents/self/app-feeds",
    "issue 459: an agent's own app feeds and their unread counts (its own token only)",
  ),
  R(
    "/api/agents/self/app-feeds/:name",
    "issue 459: an agent's own app feed's events, capped per call (its own token only)",
  ),
  M(
    ["POST"],
    "/api/agents/self/view",
    "Issue 796: an agent (its own token only) asks for a read-only view of these pages; a one-time link",
  ),
  M(
    ["POST"],
    "/api/agents/self/attention",
    "NT-1: an agent (its own token only) says it waits for its person or finished its turn",
  ),
  M(
    ["POST"],
    "/api/agents/self/review-submit",
    "Issue 476, review_submit: a review leg (its own token only) hands Den its findings once; the handler accepts only the leg's own agent, PR and head, and audits a refusal",
  ),
  M(
    ["POST"],
    "/api/agents/self/issue-write",
    "issue_write: an agent (its own token only) writes a GitHub issue in its own project's repos; audited",
  ),
  R(
    "/api/agents/self/github-watches",
    "An agent's own watches in the shared GitHub watcher (its token only); reads Den's state, asks GitHub nothing",
  ),
  M(
    ["POST"],
    "/api/agents/self/github-watches",
    "An agent asks the shared GitHub watcher to watch a pull request's checks or a run in its project's repo; one GitHub call at most",
  ),
  M(
    ["POST"],
    "/api/agents/self/github-watches/cancel",
    "An agent stops one of its own GitHub watches",
  ),
  M(["POST"], "/api/notifications/read", "NT-3: mark notifications read"),
  M(["POST"], "/api/notifications/clear", "NT-3: clear the read ones"),
  M(
    ["POST"],
    "/api/notifications/mute",
    "NT-3: mute an agent or a project for a time",
  ),
  M(
    ["POST"],
    "/api/notifications/withdraw",
    "Issue 1008: withdraw a question settled elsewhere (the agent that asked, or the person); audited",
  ),
  M(
    ["POST"],
    "/api/notifications/looking",
    "NT-2: a page shows these agents now, so they don't notify",
  ),
  R(
    "/api/alerts",
    "Issue 172: the person's new alerts (an agent needs them) for an open tab to show; never an agent's",
  ),
  R(
    "/api/alerts/push-key",
    "Issue 172: this install's push public key (VAPID), for a device to subscribe; never an agent's",
  ),
  M(
    ["POST"],
    "/api/alerts/subscribe",
    "Issue 172: a person adds this device to get alerts by push",
  ),
  M(
    ["POST"],
    "/api/alerts/unsubscribe",
    "Issue 172: a person stops push alerts to a device",
  ),
  R(
    "/api/alerts/devices",
    "Issue 172: the person's devices that get push (what each is, its push service, when added); never an endpoint, never an agent's",
  ),
  M(
    ["POST"],
    "/api/alerts/test",
    "Issue 172: a person sends a test alert to each device that gets push",
  ),
  M(
    ["POST"],
    "/api/alerts/forget",
    "Issue 172: a person stops push alerts to one device, by its id",
  ),
  R(
    "/api/hub/link-suggestions",
    "#68: each project, its Hub project, and Hub's first suggestion for an unlinked one (names only)",
  ),
  M(
    ["POST"],
    "/api/hub/link-suggestions",
    "#68: link the ticked projects to Hub's suggestions in one confirm; a person's only",
  ),
  R(
    "/api/hub/names-check",
    "issue 167: when Hub last answered Den's check of its project names, and when it last didn't (times only)",
  ),
  M(
    ["POST"],
    "/api/hub/names-check",
    "issue 167: Try again: check Hub's project names now; answers the times",
  ),
  M(
    ["POST"],
    "/api/hub/sync",
    "H5: send this install's project list to Hub again now (after a GitHub App install); answers the last sync",
  ),
  M(
    ["POST"],
    "/api/hub/connect",
    "HUB-1.7: start Connect to Hub: a PKCE verifier and single-use state kept here; answers Hub's /connect URL",
  ),
  M(
    ["POST"],
    "/api/hub/disconnect",
    "HUB-1.7: revoke this install's Hub token on Hub, then remove it here",
  ),
  R(
    "/hub/*",
    "D52: Hub's read paths, for an agent, through Den (hub-proxy-routes.ts): its own Den token only, Hub's agent paths only; Den attaches the install token",
  ),
  M(
    ["POST", "PUT", "DELETE"],
    "/hub/*",
    "D52: Hub's MCP, import and artifact-file calls (den#49), for an agent, through Den: its own Den token only, Hub's agent paths only; Den attaches the install token",
  ),
  R(
    "/hub/callback",
    "HUB-1.7: Hub sends the person back here. Sign-in free: Hub's redirect may arrive signed out. It acts only for a state this install issued to a signed-in Connect (single-use, 10 min), with the PKCE verifier only this install holds; anything else changes nothing",
  ),
  M(
    ["PUT"],
    "/api/agents/rotation",
    "D28: sets or clears one rotation setting at one scope; a person's only",
  ),
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
    "/api/workspaces/:ws/agents/:id/restart",
    "D44 Restart: at its next idle (or now) an agent's session stops and the same conversation resumes, a runtime in a PTY; a person's only",
  ),
  S(
    ["POST"],
    "/api/agents/restart-stale",
    "D44: restarts every agent with out-of-date tools at its next idle, same conversation: runtimes in PTYs; a person's only",
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
  S(
    ["POST"],
    "/api/server-agent/fresh",
    "0.4.46 Start fresh: stops, removes and starts the Den agent (a runtime in a PTY); never an agent's token",
  ),
  M(
    ["POST"],
    "/api/server-agent/runtime",
    "the person's choice of the server agent's runtime (user.yml); never an agent's token",
  ),
  S(
    ["POST"],
    "/api/server-agent/trust",
    "the person's answer to the Den agent's trust prompt (SRV-1b): types into its PTY; never an agent's token",
  ),
  M(
    ["POST"],
    "/api/server-agent/model",
    "the person's choice of the server agent's model (user.yml); never an agent's token",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/conversations/:id/import",
    "brings in a conversation: its runtime's resume in a PTY (AG-17.1)",
  ),
  S(
    ["POST"],
    "/api/workspaces/:ws/sessions",
    "starts a plain session: the person's login shell in the project (AG-10.1)",
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
    ["POST"],
    "/api/sessions/:id/close",
    "stops a plain session as closing its terminal does (HUP, then KILL) and forgets it; a person's only, never an agent's session", // words-ok: the route register, not shown
  ),
  S(
    ["POST"],
    "/api/sessions/:id/uploads",
    "writes a file dropped or pasted onto a session's terminal (AG-DROP), for its path to be typed there",
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
  // D17: "This is my computer" answers for itself: on localhost a 303,
  // anywhere else its own "only on this computer" page (never a code).
  "/attest",
  // SEC-2a: Sign in with GitHub, from the signed-out page.
  "/api/github/signin",
  "/api/github/signin/:id",
  // SEC-2a: approve this computer with a code, from the signed-out page.
  "/api/signin/code",
  "/api/signin/code/:id",
  // Issue 320: the page's beacon withdraw (its poll id is the proof).
  "/api/signin/code/:id/withdraw",
  // HUB-1.7: Hub's redirect back (no session cookie on it): the state
  // this server issued is the proof (hub-connect.ts).
  "/hub/callback",
  // MODE-5: the address check comes back in through the edge with no
  // cookie; it answers 204 or 404 for a one-time token, nothing else.
  "/api/web-url/probe",
  // Issue 455: the identity probe comes in through another proxy with no
  // cookie; it answers a challenge with this Den's proof, nothing else.
  "/api/den-identity",
  // Issue 103: the embedded pane has no cookie. Its page holds no data,
  // and its Send carries its own key (embed-keys.ts).
  "/embed/p/:project/agents/:id",
  "/api/embed/say",
  // Issue 334: a web app's server reads its agent's state with its key.
  "/api/embed/p/:project/agents/:id/state",
];

/**
 * Issue 334: the only routes an embed key (X-Den-Embed-Key: a pane's or a
 * server's) reaches. A request carrying one anywhere else is refused
 * (request-guard.ts), whatever else it carries: the key never rides along
 * to a route loopback would let through.
 */
/**
 * Issue 621: the only routes a gate-only runner token reaches (POST): ask
 * for a gate slot, renew its lease, give it back. Any other route answers
 * 403 to it, before anything else looks at the request.
 */
export const RUNNER_ROUTES: readonly string[] = [
  "/api/gate-slots/ask",
  "/api/gate-slots/renew",
  "/api/gate-slots/release",
];

export const EMBED_KEY_ROUTES: readonly string[] = [
  "/api/embed/say",
  "/api/embed/p/:project/agents/:id/state",
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
  // Issue 103: the embedded pane's key is in a header no other site can
  // send (no CORS here): it is the proof, as a CSRF token would be.
  "/api/embed/say",
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

/**
 * D67: DELETEs whose path carries their own unguessable proof (the code
 * request's poll id, which only its page holds): an allowed Origin, no
 * CSRF token, signed in or not. The page withdraws its request as it
 * goes, and by then it may have signed in another way.
 */
export const SIGNIN_ID_DELETES: readonly string[] = ["/api/signin/code/:id"];

/**
 * Issue 320: the same withdraw, as a POST: `navigator.sendBeacon` sends
 * only a POST, and Safari drops a keepalive DELETE as a page goes. Guarded
 * as SIGNIN_ID_DELETES: an allowed Origin, no CSRF token, signed in or not.
 */
export const SIGNIN_ID_BEACONS: readonly string[] = [
  "/api/signin/code/:id/withdraw",
];

/** The dispatchers' route regexes, by `<file>:<const>`, and their entries. */
export const REGEX_ROUTES: Readonly<Record<string, readonly string[]>> = {
  // UK-2: how a write sent with the working pop-up's id ended.
  "index.ts:requestStatusPath": ["/requests/*", "/api/requests/*"],
  // Sign-in's API calls on a loopback name, once Den's own address works.
  "index.ts:SIGNIN_APIS": [
    "/api/github/signin",
    "/api/github/signin/:id",
    "/api/signin/code",
    "/api/signin/code/:id",
    "/api/signin/code/:id/withdraw",
  ],
  "agent-link-routes.ts:LINK_PATH": ["/p/:project/agents/:id"],
  "embed-routes.ts:EMBED_PATH": ["/embed/p/:project/agents/:id"],
  "embed-routes.ts:STATE_PATH": ["/api/embed/p/:project/agents/:id/state"],
  "report-routes.ts:DRAFT_PATH": ["/api/report/drafts/:id"],
  "report-routes.ts:FLOW_PATH": ["/api/report/github-send/:id"],
  "report-routes.ts:SHOT_PATH": ["/api/report/shots/:id"],
  "agent-routes.ts:AGENTS_PATH": [
    "/api/workspaces/:ws/agents",
    "/api/workspaces/:ws/agents/:id/stop",
    "/api/workspaces/:ws/agents/:id/resume",
    "/api/workspaces/:ws/agents/:id/fresh",
    "/api/workspaces/:ws/agents/:id/relaunch",
    "/api/workspaces/:ws/agents/:id/remove",
    "/api/workspaces/:ws/agents/:id/name",
    "/api/workspaces/:ws/agents/:id/paths",
    "/api/workspaces/:ws/agents/:id/file",
    "/api/workspaces/:ws/agents/:id/persona",
    "/api/workspaces/:ws/agents/:id/keep",
    "/api/workspaces/:ws/agents/:id/settings",
    "/api/workspaces/:ws/agents/:id/mode",
    "/api/workspaces/:ws/agents/:id/handoff",
    "/api/workspaces/:ws/agents/:id/clear-helpers",
    "/api/workspaces/:ws/agents/:id/compacting-clear",
    "/api/workspaces/:ws/agents/:id/restart",
    "/api/workspaces/:ws/agents/:id/link",
    "/api/workspaces/:ws/agents/:id/move",
    "/api/workspaces/:ws/agents/:id/say",
    "/api/workspaces/:ws/agents/:id/order",
  ],
  "agent-routes.ts:TOOLS_PATH": ["/api/workspaces/:ws/agents/:id/tools"],
  "agent-routes.ts:RUNTIME_PATH": ["/api/agents/runtimes/:id/path"],
  "agent-routes.ts:PERSONA_PATH": ["/api/personas/:id"],
  "agent-routes.ts:PLAIN_PATH": ["/api/workspaces/:ws/sessions"],
  "agent-routes.ts:DETAILS_PATH": ["/api/workspaces/:ws/agents/:id/details"],
  "agent-routes.ts:MODES_PATH": ["/api/workspaces/:ws/agent-modes"],
  "agent-routes.ts:MCP_SERVERS_PATH": ["/api/workspaces/:ws/mcp-servers"],
  "agent-routes.ts:MCP_SERVER_PATH": ["/api/workspaces/:ws/mcp-servers/:name"],
  "agent-routes.ts:EVENT_FEEDS_PATH": ["/api/workspaces/:ws/event-feeds"],
  "app-feed-routes.ts:LIST": ["/api/agents/self/app-feeds"],
  "app-feed-routes.ts:ONE": ["/api/agents/self/app-feeds/:name"],
  "hub-project-routes.ts:HUB_PROJECT_ROUTE": [
    "/api/workspaces/:ws/hub-project",
  ],
  "hub-rename-routes.ts:HUB_RENAME_ROUTE": ["/api/workspaces/:ws/hub-rename"],
  "hub-create-routes.ts:HUB_CREATE_ROUTE": ["/api/workspaces/:ws/hub-create"],
  "agent-routes.ts:HELPERS_PATH": [
    "/api/workspaces/:ws/agents/:id/helpers",
    "/api/workspaces/:ws/agents/:id/helpers/:helper",
  ],
  "agent-routes.ts:CONVERSATIONS_PATH": [
    "/api/workspaces/:ws/conversations",
    "/api/workspaces/:ws/conversations/:id/import",
  ],
  "session-routes.ts:IO_PATH": ["/api/sessions/:id/io"],
  "session-routes.ts:UPLOAD_PATH": ["/api/sessions/:id/uploads"],
  "session-routes.ts:CLOSE_PATH": ["/api/sessions/:id/close"],
  "github-routes.ts:SIGNIN_PATH": ["/api/github/signin/:id"],
  "github-routes.ts:LINK_PATH": ["/api/web/owner/link/:id"],
  "pair-routes.ts:POLL_PATH": ["/api/signin/code/:id"],
  "pair-routes.ts:WITHDRAW_PATH": ["/api/signin/code/:id/withdraw"],
  "index.ts:LOGIN_WAIT_PATH": ["/api/web/logins/:id"],
  "approval-routes.ts:ONE_PATH": ["/api/approvals/:id"],
  "approval-routes.ts:DECIDE_PATH": ["/api/approvals/:id/decide"],
  "approval-routes.ts:WITHDRAW_PATH": ["/api/approvals/:id/withdraw"],
  // Issue 209: a Verify run's record, and a module's kept output.
  "verify-routes.ts:RUN_PATH": [
    "/api/verify/runs/:id",
    "/api/verify/runs/:id/report",
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
