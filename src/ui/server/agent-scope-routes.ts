/**
 * How each route an agent's token reaches keeps to the agent's project
 * scope, when its path names no project (a path that does, `:ws` or
 * `:project`, is held by the request guard: request-guard.ts
 * workspaceRefusal). tests/unit/server/agent-scope-inventory.test.ts reads
 * this table against route-classes.ts, in both install modes, and fails
 * on a route an agent reaches that it doesn't list.
 *
 *   filtered  the handler shows an agent its own projects' rows only, on
 *             a strict install (agentRowFilter)
 *   handler   the handler holds the agent to its scope itself
 *   own       the caller's own agent, session, asks or activity only
 *   none      no project's rows, and acts on no project or agent
 *   open      not yet held on a strict install: it can show another
 *             project's names, rows or logs. A read only, never a route
 *             that acts on another project's agent or session.
 *
 * Keys are "METHOD path", as route-classes.ts writes the path.
 */
export type AgentScopeKind = "filtered" | "handler" | "own" | "none" | "open";

export interface AgentScopeEntry {
  kind: AgentScopeKind;
  why: string;
}

const e = (kind: AgentScopeKind, why: string): AgentScopeEntry => ({
  kind,
  why,
});
const NONE = (why: string) => e("none", why);
const OWN = (why: string) => e("own", why);
const OPEN = (why: string) => e("open", why);

export const AGENT_SCOPE_ROUTES: Readonly<Record<string, AgentScopeEntry>> = {
  // ── Filtered on a strict install ────────────────────────────────────────
  "GET /api/workspaces": e("filtered", "its projects only (WORKSPACES_SHAPE)"),
  "GET /api/sessions": e("filtered", "its projects' sessions; ?ws= guarded"),
  "GET /api/agents/stale": e("filtered", "its projects' agents only"),

  // ── Held by the handler ─────────────────────────────────────────────────
  "GET /api/workspace/sync": e("handler", "the focused project, in scope"),
  "POST /api/workspace/sync": e("handler", "the focused project, in scope"),
  "POST /api/verify/plan": e("handler", "its own project only"),
  "POST /api/verify/run": e("handler", "its own project only"),

  // ── The caller's own ────────────────────────────────────────────────────
  "GET /api/session": OWN("who the caller is"),
  "POST /api/approvals": OWN("its own ask; a person decides it"),
  "POST /api/approvals/:id/withdraw": OWN("its own ask only"),
  "POST /api/activity": OWN("its own activity"),
  "POST /api/audit/cli": OWN("its own CLI call, audited"),
  "POST /api/notifications/withdraw": OWN("its own notice"),
  "GET /api/agents/self/app-feeds": OWN("its own"),
  "GET /api/agents/self/app-feeds/:name": OWN("its own"),
  "POST /api/agents/self/view": OWN("its own view"),
  "POST /api/agents/self/attention": OWN("its own"),
  "POST /api/agents/self/issue-write": OWN("its own"),
  "GET /api/agents/self/github-watches": OWN("its own"),
  "POST /api/agents/self/github-watches": OWN("its own"),
  "POST /api/agents/self/github-watches/cancel": OWN("its own"),

  // ── No project's rows ───────────────────────────────────────────────────
  "GET /api/_den/throw": NONE("a test of the error page"),
  "GET /api/app-url": NONE("this Den's address"),
  "GET /api/modules": NONE("Den's modules"),
  "GET /api/environments": NONE("the environments' names"),
  "GET /api/edge": NONE("this Den's edge"),
  "GET /api/edge/address": NONE("this Den's address"),
  "GET /api/den-identity": NONE("this Den's identity"),
  "GET /api/server-info": NONE("this Den's version"),
  "GET /api/changelog": NONE("Den's changelog"),
  "GET /api/themes": NONE("the themes"),
  "GET /api/agents/runtimes": NONE("the runtimes this machine has"),
  "GET /api/:cli/config": NONE("the CLI's settings shape"),
  "GET /api/sudo-password/status": NONE("whether one is kept"),
  "GET /api/sudo-password/vault-status": NONE("whether a vault answers"),
  "GET /api/web-url": NONE("this Den's address"),
  "GET /api/web-url/probe": NONE("whether the address answers"),
  "GET /api/server-agent": NONE("the server agent's state"),
  "GET /api/server-agent/update": NONE("Den's update state"),
  "GET /api/alerts/push-key": NONE("the push key's public half"),
  "GET /api/manifest/validate": NONE("checks the manifest it is sent"),
  "POST /api/manifest/validate": NONE("checks the manifest it is sent"),
  "POST /api/report/preview": NONE("a preview of the report it is sent"),
  "POST /api/report/drafts": NONE("a draft of the report it is sent"),

  // ── Open on a strict install (a read; a later change filters each) ──────
  "GET /api/orgs": OPEN("orgs and their repos"),
  "GET /api/security/latest": OPEN("findings by repo"),
  "GET /api/security/plan": OPEN("findings by repo"),
  "GET /api/stacks": OPEN("every project's stacks"),
  "GET /api/activity": OPEN("every project's activity"),
  "GET /api/server-log": OPEN("the server's log"),
  "GET /api/perf-report/current": OPEN("requests by route, project names"),
  "GET /api/health/stream": OPEN("every repo's services"),
  "GET /api/health": OPEN("every repo's services"),
  "GET /api/services": OPEN("every active project's services"),
  "GET /api/service/daemons": OPEN("every running service"),
  "GET /api/service/logs": OPEN("a repo's log, named by repo"),
  "GET /api/service/taillog": OPEN("a repo's log, named by repo"),
  "GET /api/service/history": OPEN("a repo's log, named by repo"),
  "GET /api/logs/search": OPEN("logs, named by repo"),
  "GET /api/catalog": OPEN("every repo"),
  "GET /api/requests/*": OPEN("a request's record"),
  "GET /api/release/config": OPEN("release settings by repo"),
  "GET /api/release/status": OPEN("releases by repo"),
  "GET /api/release/runs": OPEN("release runs by repo"),
  "GET /api/release/branches": OPEN("branches by repo"),
  "GET /api/release/deploy/active": OPEN("deploys by repo"),
  "GET /api/release/deploy": OPEN("deploys by repo"),
  "GET /api/runs/last": OPEN("the last test run"),
  "GET /api/run": OPEN("a test run of a pillar, on an environment"),
  "GET /api/test-sources": OPEN("test sources of the focused project"),
  "GET /api/coach": OPEN("suggestions, by project"),
  "GET /api/scope": OPEN("the person's view scope: project names"),
  "GET /api/settings": OPEN("settings, project rows among them"),
  "GET /api/report": OPEN("the person's reports"),
  "GET /api/report/diagnostics": OPEN("diagnostics, project names"),
  "GET /api/report/drafts": OPEN("the person's drafts"),
  "GET /api/report/drafts/:id": OPEN("a draft"),
  "GET /api/report/github-send/:id": OPEN("a sent report"),
  "GET /api/report/shot-share": OPEN("a screenshot"),
  "GET /api/report/shots/:id": OPEN("a screenshot"),
  "GET /api/workspaces/cleanup-preview": OPEN("every project's clones"),
  "GET /api/workspaces/available-repos": OPEN("the focused project's repos"),
  "GET /api/workspaces/services": OPEN("the focused project's services"),
  "GET /api/workspaces/settings": OPEN("the focused project's settings"),
  "GET /api/workspaces/deps-check": OPEN("the focused project's deps"),
  "GET /api/graph": OPEN("every project's graph"),
  "GET /api/applications": OPEN("every project's applications"),
  "GET /api/personas": OPEN("personas, project ones among them"),
  "GET /api/personas/:id": OPEN("a persona"),
  "GET /api/sessions/helpers": OPEN("helpers counted over every session"),
  "GET /api/onboard/status": OPEN("onboarding, by project"),
  "GET /api/onboard/repos": OPEN("repos to bring in"),
  "GET /api/onboard/manifest": OPEN("a repo's manifest"),
  "GET /api/approvals": OPEN("every agent's asks"),
  "GET /api/approvals/:id": OPEN("an ask"),
  "GET /api/verify/overview": OPEN("every project's runs"),
  "GET /api/verify/runs/:id": OPEN("a run"),
  "GET /api/verify/runs/:id/report": OPEN("a run's report"),
  "GET /api/verify/schedules": OPEN("every project's schedules"),
  "GET /api/embed/app-keys": OPEN("app keys, by project"),
  "GET /api/agents/rotation": OPEN("rotation, by agent"),
  "GET /api/hub": OPEN("Hub's state, project links"),
  "GET /api/hub/github": OPEN("Hub's GitHub coverage, by project"),
  "GET /api/hub/link-suggestions": OPEN("links, by project"),
  "GET /api/hub/groups": OPEN("Hub's groups"),
  "GET /api/hub/connect-review": OPEN("projects to connect"),
  "GET /api/hub/names-check": OPEN("project names"),
  "GET /api/gate-slots": OPEN("the machine's queue, labels by lane"),
  "GET /api/gate-slots/runners": OPEN("runners"),
  "GET /api/gate-slots/boxes": OPEN("test boxes"),
  "GET /api/gate-slots/runner-entries": OPEN("runner entries, by repo"),
  "GET /api/notifications": OPEN("the person's notifications"),
  "GET /api/alerts": OPEN("the person's alerts"),
  "GET /api/alerts/devices": OPEN("the person's devices"),
};
