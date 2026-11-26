export type AgentScopeKind =
  | "filtered"
  | "handler"
  | "own"
  | "none"
  | "inert"
  | "person-strict"
  | "unfiltered";

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
const OPEN = (why: string) => e("unfiltered", why);

export const AGENT_SCOPE_ROUTES: Readonly<Record<string, AgentScopeEntry>> = {
  "GET /api/workspaces": e("filtered", "its projects only (WORKSPACES_SHAPE)"),
  "GET /api/sessions": e("filtered", "its projects' rows only; the ws filter is guarded"),
  "GET /api/agents/stale": e("filtered", "its projects' agents only"),
  "GET /api/notifications": e("filtered", "its projects' items and agents"),

  "GET /api/workspace/sync": e("handler", "the focused project, in scope"),
  "POST /api/workspace/sync": e("handler", "the focused project, in scope"),
  "POST /api/verify/plan": e("handler", "its own project only"),
  "POST /api/verify/run": e("handler", "its own project only"),
  "GET /api/service/exec": e(
    "handler",
    "the named or focused project, in scope",
  ),
  "GET /api/run": e("handler", "the focused project, in scope"),
  "GET /api/test-sources": e(
    "handler",
    "on strict, the focused project in scope",
  ),
  "GET /api/workspaces/available-repos": e(
    "handler",
    "on strict, the focused project in scope",
  ),
  "GET /api/workspaces/services": NONE("no GET handler: a 404"),
  "GET /api/workspaces/settings": e(
    "handler",
    "on strict, the focused project in scope",
  ),
  "GET /api/workspaces/deps-check": e(
    "handler",
    "on strict, the focused project in scope",
  ),
  "GET /api/agents/restart-status": e("handler", "a person's only"),
  "GET /api/service/logs": e("handler", "on strict, its projects' repos"),
  "GET /api/service/taillog": e("handler", "on strict, its projects' repos"),
  "GET /api/service/history": e("handler", "on strict, its projects' repos"),
  "GET /api/logs/search": e("handler", "on strict, its projects' repos"),
  "GET /api/manifest/validate": e("handler", "on strict, its projects' repos"),

  "GET /api/server-log": e("person-strict", "Den's own log, every project"),
  "GET /api/report/diagnostics": e(
    "person-strict",
    "diagnostics, every project",
  ),
  "GET /api/approvals": e("person-strict", "the person's own, every project"),
  "GET /api/alerts": e("person-strict", "the person's own, every project"),
  "GET /api/alerts/devices": e(
    "person-strict",
    "the person's own, every project",
  ),
  "GET /api/report/drafts": e(
    "person-strict",
    "the person's own, every project",
  ),
  "GET /api/report/drafts/:id": e(
    "person-strict",
    "the person's own, every project",
  ),
  "GET /api/report/shots/:id": e(
    "person-strict",
    "the person's own, every project",
  ),
  "GET /api/report/shot-share": e(
    "person-strict",
    "the person's own, every project",
  ),
  "GET /api/report/github-send/:id": e(
    "person-strict",
    "the person's own, every project",
  ),

  "GET /api/perf-report/current": e(
    "person-strict",
    "requests by route, project names",
  ),
  "GET /api/health/stream": e("person-strict", "every repo's services"),
  "GET /api/service/daemons": e("person-strict", "every running service"),
  "GET /api/catalog": e("person-strict", "every repo"),
  "GET /api/requests/*": OWN("its own request's status"),
  "GET /api/release/config": e("person-strict", "release settings by repo"),
  "GET /api/release/branches": e("person-strict", "branches by repo"),
  "GET /api/release/deploy/active": e("person-strict", "deploys by repo"),
  "GET /api/release/deploy": e("person-strict", "deploys by repo"),
  "GET /api/runs/last": e("person-strict", "the last test run"),
  "GET /api/workspaces/cleanup-preview": e(
    "person-strict",
    "every project's clones",
  ),
  "GET /api/personas": e("person-strict", "personas, project ones among them"),
  "GET /api/personas/:id": e("person-strict", "a persona"),
  "GET /api/sessions/helpers": e("filtered", "helpers in its projects only"),
  "GET /api/verify/overview": e("person-strict", "every project's runs"),
  "GET /api/verify/runs/:id": e("person-strict", "a run"),
  "GET /api/verify/runs/:id/report": e("person-strict", "a run's report"),
  "GET /api/verify/schedules": e("person-strict", "every project's schedules"),
  "GET /api/embed/app-keys": e("person-strict", "app keys, by project"),
  "GET /api/hub/github": e(
    "person-strict",
    "Hub's GitHub coverage, by project",
  ),
  "GET /api/hub/link-suggestions": e("person-strict", "links, by project"),
  "GET /api/hub/groups": e("person-strict", "Hub's groups"),
  "GET /api/hub/connect-review": e("person-strict", "projects to connect"),
  "GET /api/hub/names-check": e("person-strict", "project names"),
  "GET /api/gate-slots/runners": e("person-strict", "runners"),
  "GET /api/gate-slots/runner-entries": e(
    "person-strict",
    "runner entries, by repo",
  ),

  "GET /api/session": OWN("who the caller is"),
  "POST /api/approvals": OWN("its own ask; a person decides it"),
  "POST /api/approvals/:id/withdraw": OWN("its own ask only"),
  "GET /api/approvals/:id": OWN("its own ask only; another's is 404"),
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
  "GET /api/server-agent": NONE("Den's own agent: its state"),
  "GET /api/server-agent/update": NONE("Den's update state"),
  "GET /api/alerts/push-key": NONE("the push key's public half"),
  "POST /api/manifest/validate": e("inert", "checks the text it is sent"),
  "POST /api/report/preview": e("inert", "a preview of the report it is sent"),
  "POST /api/report/drafts": OWN("a draft of the report it writes"),

  "GET /api/orgs": OPEN("GitHub owners and their repos"),
  "GET /api/security/latest": OPEN("findings by repo"),
  "GET /api/security/plan": OPEN("findings by repo"),
  "GET /api/stacks": OPEN("every project's stacks"),
  "GET /api/activity": OPEN("every project's activity"),
  "GET /api/health": OPEN("every repo's services"),
  "GET /api/services": OPEN("every active project's services"),
  "GET /api/release/status": OPEN("releases by repo"),
  "GET /api/release/runs": OPEN("release runs by repo"),
  "GET /api/coach": OPEN("suggestions, by project"),
  "GET /api/scope": OPEN("the person's view scope: project names"),
  "GET /api/settings": OPEN("settings, project rows among them"),
  "GET /api/report": NONE("the report form's settings and destinations"),
  "GET /api/graph": OPEN("every project's graph"),
  "GET /api/applications": OPEN("every project's applications"),
  "GET /api/onboard/status": OPEN("onboarding, by project"),
  "GET /api/onboard/repos": OPEN("repos to bring in"),
  "GET /api/onboard/manifest": OPEN("a repo's manifest"),
  "GET /api/agents/rotation": OPEN("rotation, by agent"),
  "GET /api/hub": OPEN("Hub's state, project links"),
  "GET /api/gate-slots": OPEN("the machine's queue, labels by lane"),
  "GET /api/gate-slots/boxes": OPEN("test boxes"),
};
