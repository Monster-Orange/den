/**
 * The MCP tools. Read tools are always registered; action tools only when the
 * org names them in `mcp.actions`. Every tool is a thin call to the web API
 * (see api.ts); the guards (guards.ts) run first, and all text returned is
 * passed through the secret redactor.
 */
import { z } from "zod";
import {
  MCP_ACTIONS,
  type McpAction,
  type ResolvedMcpConfig,
} from "../../shared/den-config.js";
import { redactSecrets } from "../../shared/redact.js";
import {
  DenHttpError,
  DenWebDown,
  ForeignWebServer,
  UnidentifiedWebServer,
  type DenApi,
  type Query,
  type StreamResult,
} from "./api.js";
import {
  Refusal,
  assertLifecycleCmd,
  assertLocalEnv,
  assertLogsEnv,
  assertRunTestsAllowed,
  assertRunsLocally,
  assertSecurityPlanOk,
  assertSyncableRepo,
  type LifecycleCmd,
  type ServiceEntryLike,
  type SecurityPlanLike,
} from "./guards.js";
import {
  ScopeRefusal,
  assertGrantExists,
  assertPathInScope,
  assertScopeExists,
  assertScopeFocused,
  assertServicesInScope,
  crossedWorkspace,
  filterWorkspacesBody,
  pinWorkspace,
  type McpScope,
} from "./scope.js";
import {
  graphInScope,
  mergeGraphs,
  orgSummary,
  scopeBlock,
  statusView,
  workspaceRepos,
} from "./views.js";

export interface ToolContext {
  api: DenApi;
  cfg: ResolvedMcpConfig;
  /** The CLI name, for messages (`<cli> web up`). */
  cli: string;
  /**
   * A scoped server's workspace and actor (AG-2a-core); absent, every tool
   * behaves as it always has.
   */
  scope?: McpScope;
}

type Args = Record<string, unknown>;

export interface DenTool {
  name: string;
  title: string;
  description: string;
  action: boolean;
  shape: z.ZodRawShape;
  run(args: Args, ctx: ToolContext): Promise<unknown>;
}

const ENVS = [
  "local",
  "dev",
  "sandbox",
  "staging",
  "beta",
  "prod",
  "production",
] as const;
const PILLARS = [
  "synthetic",
  "integration",
  "performance",
  "smoke",
  "journeys",
  "security",
  "suites",
] as const;

const envArg = z.enum(ENVS).optional().describe("Environment (default local)");
const workspaceArg = z
  .string()
  .optional()
  .describe("Den workspace (default: the focused one)");

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const envOf = (args: Args): string => str(args.env) ?? "local";

/** Keep the last `n` lines of a stream's output. */
function tail(r: StreamResult, n: number): string[] {
  return r.lines.slice(-n);
}

/** One line per stream: how it ended and its exit code. */
/**
 * Whether a streamed action failed: a non-zero exit, a detached service whose
 * launcher exited non-zero, or a run that never finished (timeout).
 */
export function streamFailed(r: StreamResult): boolean {
  if (r.ended === "timeout") return true;
  if (r.exitCode !== undefined && r.exitCode !== 0) return true;
  return r.events.some(
    (e) =>
      e.type === "service-exited" &&
      typeof e.exitCode === "number" &&
      e.exitCode !== 0,
  );
}

/** An action that ran and failed: its output goes back with isError set. */
export class ActionFailed extends Error {
  constructor(readonly out: Record<string, unknown>) {
    super("action failed");
    this.name = "ActionFailed";
  }
}

/**
 * How the call ended, in words an agent reads about the service: a stream
 * stopped at `ready` is "ready", at a launcher's exit "handed-off".
 */
function endedLabel(r: StreamResult): string {
  if (r.ended !== "stopped") return r.ended;
  const last = r.events.at(-1)?.type;
  if (last === "ready") return "ready";
  if (last === "service-exited") return "handed-off";
  return r.ended;
}

function streamSummary(r: StreamResult, keep: number) {
  return {
    ended: endedLabel(r),
    ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
    lines: r.lines.length,
    output: tail(r, keep),
  };
}

/** The action's result; thrown as ActionFailed when the stream failed. */
function actionResult(
  r: StreamResult,
  keep: number,
  head: Record<string, unknown> = {},
): Record<string, unknown> {
  const out = { ...head, ...streamSummary(r, keep) };
  if (streamFailed(r)) throw new ActionFailed({ failed: true, ...out });
  return out;
}

// ── Read tools ──────────────────────────────────────────────────────────────

const read = (
  name: string,
  title: string,
  description: string,
  shape: z.ZodRawShape,
  run: DenTool["run"],
): DenTool => ({ name, title, description, action: false, shape, run });

const READ_TOOLS: DenTool[] = [
  read(
    "status",
    "Service health",
    "Health of every service in the workspace (what `status` shows): `counts`, then each service's `state` (up, down, redirect, pending, unknown, not-checked; `why` when there is no plain verdict), mode, and what was checked: `url` for an HTTP check, `check` for a shell command or a container check (`container <project>/<service>`). A redirect (302 → /login) answers, so it is not down.",
    { env: envArg, workspace: workspaceArg },
    async (a, { api, scope }) => {
      const env = envOf(a);
      const view = statusView(
        await api.get("/api/health", { env, workspace: str(a.workspace) }),
        env,
      );
      return scope
        ? await withScope(api, scope, a, view, {
            count: (view.services as unknown[]).length,
            noun: "service",
          })
        : view;
    },
  ),
  read(
    "services",
    "Services",
    "The workspace's services: repo, service, mode (managed or dev-managed), lifecycle commands, dependencies.",
    { env: envArg, workspace: workspaceArg },
    async (a, { api, scope }) => {
      const list = await api.get("/api/services", {
        env: envOf(a),
        workspace: str(a.workspace),
      });
      if (!scope) return list;
      const services = Array.isArray(list) ? list : [];
      return withScope(
        api,
        scope,
        a,
        { services },
        { count: services.length, noun: "service" },
      );
    },
  ),
  read(
    "applications",
    "Applications",
    "Org > Application > Repo > Services for a workspace (what `apps --json` shows).",
    { workspace: workspaceArg },
    async (a, { api, scope }) => {
      const tree = await api.get("/api/applications", {
        workspace: str(a.workspace),
      });
      if (!scope) return tree;
      const t =
        tree && typeof tree === "object" && !Array.isArray(tree)
          ? (tree as Record<string, unknown>)
          : { applications: tree };
      const apps = Array.isArray(t.applications) ? t.applications : [];
      return withScope(api, scope, a, t, {
        count: apps.length,
        noun: "application",
      });
    },
  ),
  read(
    "graph",
    "Dependency graph",
    "The derived dependency graph; `seed` narrows it to one repo's closure. Unscoped with no `workspace` it is the org-wide map (`map: \"org-wide\"`: every active workspace's repos and edges, `workspaces` naming them; `order` only when one is active), with `workspace` that workspace's (`map: \"workspace\"`, with its startup order). Scoped, the workspace's own repos and the edges out of them (`outside` names the repos they depend on elsewhere; the org-wide map is `org_summary.graph`).",
    {
      seed: z.string().optional().describe("Repo whose closure to show"),
      workspace: workspaceArg,
    },
    async (a, { api, scope }) => {
      // Unscoped and naming nothing: the org-wide map, every active
      // workspace's graph merged (the web server derives one per workspace).
      if (!scope && !str(a.seed) && !str(a.workspace))
        return orgGraph(api, (p, q) => api.get(p, q));
      const graph = await api.get("/api/graph", {
        seed: str(a.seed),
        workspace: str(a.workspace),
      });
      if (!scope)
        return graph && typeof graph === "object" && !Array.isArray(graph)
          ? {
              map: str(a.seed) ? "closure" : "workspace",
              ...(str(a.workspace) ? { workspace: str(a.workspace) } : {}),
              ...(graph as Record<string, unknown>),
            }
          : graph;
      const body = await scopeWorkspacesBody(api, scope);
      const shown = String(a.workspace);
      const view = graphInScope(graph, workspaceRepos(body, shown));
      const { hiddenNodes, ...rest } = view;
      return {
        ...rest,
        scope: scopeBlock(
          scope,
          body,
          shown,
          { count: (view.nodes as unknown[]).length, noun: "repo" },
          { graphNodes: hiddenNodes as number },
        ),
      };
    },
  ),
  read(
    "workspaces",
    "Workspaces",
    "Workspaces, which are active and which is focused.",
    {},
    async (_a, { api, scope }) => {
      const body = await api.get("/api/workspaces");
      if (!scope) return body;
      const filtered = filterWorkspacesBody(body, scope);
      return {
        ...filtered,
        scope: {
          ...(filtered.scope as Record<string, unknown>),
          ...scopeBlock(scope, body, scope.workspace, {
            count: 1,
            noun: "workspace",
          }),
        },
      };
    },
  ),
  read(
    "org_summary",
    "Org summary",
    'The whole org at a glance, for every agent: each workspace and repo with status counts (running, partial, stopped; up, down, redirect, not checked), the dependency graph (names and edge kinds), the edge (up, TLS, whether HTTPS serves) and the environments. Scoped, `yours` adds your own workspace\'s services in full. It never carries logs, env values, commands, URLs or check output from outside your workspace. Start here for "what are our servers?".',
    {},
    async (_a, { api, scope }) => {
      const workspaces = await api.get("/api/workspaces");
      const [health, graph, edge, environments, own] = await Promise.all([
        api.get("/api/health", { env: "local" }),
        // Names and edge kinds only (orgSummary drops the evidence).
        orgGraph(api, (p, q) => softGet(api, p, q), workspaces),
        softGet(api, "/api/edge"),
        api.get("/api/environments"),
        scope
          ? api.get("/api/health", {
              env: "local",
              workspace: scope.workspace,
            })
          : Promise.resolve(undefined),
      ]);
      return orgSummary(
        { workspaces, health, graph, edge, environments, own },
        scope,
      );
    },
  ),
  read(
    "environments",
    "Environments",
    "The environment names this org enables (names only, never their values).",
    {},
    (_a, { api }) => api.get("/api/environments"),
  ),
  read(
    "logs_search",
    "Search logs",
    "Search the full log history of services (repo/service targets) for text. Local sources only unless mcp.logs.remote is on. Secrets are redacted.",
    {
      q: z.string().min(2).describe("Text to find (2+ characters)"),
      targets: z
        .array(z.string())
        .min(1)
        .max(40)
        .describe("repo/service names"),
      env: envArg,
    },
    async (a, { api, cfg, scope }) => {
      const env = envOf(a);
      assertLogsEnv(env, cfg);
      if (scope)
        await assertServicesInScope(
          "logs_search",
          api,
          scope,
          (a.targets as string[]).map((t) => {
            const slash = t.lastIndexOf("/");
            return { repo: t.slice(0, slash), service: t.slice(slash + 1) };
          }),
        );
      return api.get("/api/logs/search", {
        q: String(a.q),
        env,
        targets: (a.targets as string[]).join(","),
      });
    },
  ),
  read(
    "logs_tail",
    "Tail logs",
    "The last lines of one service's log (no follow). Local sources only unless mcp.logs.remote is on. Secrets are redacted.",
    {
      repo: z.string(),
      service: z.string(),
      lines: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Lines to return (default 200)"),
      env: envArg,
    },
    async (a, { api, cfg, scope }) => {
      const env = envOf(a);
      assertLogsEnv(env, cfg);
      if (scope)
        await assertServicesInScope("logs_tail", api, scope, [
          { repo: String(a.repo), service: String(a.service) },
        ]);
      const n = (a.lines as number | undefined) ?? 200;
      const query: Query = { repo: String(a.repo), service: String(a.service) };
      const r =
        env === "local"
          ? await api.stream("/api/service/taillog", query, {
              maxLines: 5000,
              timeoutMs: 8000,
              idleMs: 1500,
            })
          : await api.stream(
              "/api/service/logs",
              { ...query, env },
              {
                maxLines: 5000,
                timeoutMs: 15000,
                idleMs: 3000,
              },
            );
      return { repo: a.repo, service: a.service, env, lines: tail(r, n) };
    },
  ),
  read(
    "tests_available",
    "Available tests",
    "The test modules of a pillar, and which repos (branch + SHA) they come from.",
    { pillar: z.enum(PILLARS) },
    async (a, { api, scope }) => {
      if (scope)
        await crossIfGranted(
          { api, scope },
          "tests_available",
          await assertScopeFocused("tests_available", api, scope),
        );
      return {
        modules: await api.get("/api/modules", { pillar: String(a.pillar) }),
        sources: await api.get("/api/test-sources", {
          pillar: String(a.pillar),
        }),
      };
    },
  ),

  read(
    "security_latest",
    "Latest security scans",
    "The newest security (ZAP) scan summary per mode for an environment.",
    { env: envArg },
    (a, { api }) => api.get("/api/security/latest", { env: envOf(a) }),
  ),
  read(
    "release_status",
    "Release status",
    "Recent CD runs per repo and, with env, the deployed-version table for it. Read only: there is no deploy tool.",
    {
      env: z
        .string()
        .optional()
        .describe("Release environment for the verify table"),
    },
    async (a, { api }) => ({
      runs: await api.get("/api/release/runs"),
      ...(str(a.env)
        ? { status: await api.get("/api/release/status", { env: str(a.env) }) }
        : {}),
    }),
  ),
  read(
    "manifest_validate",
    "Validate a manifest",
    "Validate a service manifest: a repo path (or file), or the YAML content itself.",
    {
      path: z.string().optional().describe("Repo directory or manifest file"),
      content: z.string().optional().describe("Manifest YAML to validate"),
    },
    async (a, { api, scope }) => {
      if (str(a.content) !== undefined)
        return api.get("/api/manifest/validate", {}, "POST", {
          content: a.content,
        });
      if (str(a.path) === undefined)
        throw new Refusal("give a path or the manifest content.");
      if (scope)
        await assertPathInScope(
          "manifest_validate",
          api,
          scope,
          String(a.path),
        );
      return api.get("/api/manifest/validate", { path: str(a.path) });
    },
  ),
  read(
    "stacks",
    "Stacks",
    "Compose stacks (what `stack ls/ps/health` show): name, project, routes and container health. An empty list says why (`why`).",
    {
      workspace: workspaceArg,
      health: z
        .boolean()
        .optional()
        .describe("Check container health (default true)"),
    },
    async (a, { api, scope }) => {
      const body = (await api.get("/api/stacks", {
        workspace: str(a.workspace),
        health: a.health === false ? "0" : "1",
      })) as Record<string, unknown>;
      const all = Array.isArray(body?.stacks)
        ? (body.stacks as { repo?: unknown }[])
        : [];
      if (!scope) {
        if (all.length || body?.why !== undefined) return body;
        return {
          ...body,
          why: "no stacks (the web server gave no reason; it predates 0.4.4)",
        };
      }
      const wsBody = await scopeWorkspacesBody(api, scope);
      const shown = String(a.workspace);
      const mine = new Set(workspaceRepos(wsBody, shown));
      const stacks = all.filter((s) => mine.has(String(s.repo)));
      const hiddenStacks = all.length - stacks.length;
      const why = stacks.length
        ? undefined
        : hiddenStacks
          ? `no stacks in workspace "${shown}": the ${hiddenStacks} stack${hiddenStacks === 1 ? "" : "s"} listed belong to repos outside it`
          : ((body?.why as string | undefined) ??
            "no stacks (the web server gave no reason; it predates 0.4.4)");
      return withScope(
        api,
        scope,
        a,
        { ...body, stacks, ...(why ? { why } : {}) },
        { count: stacks.length, noun: "stack" },
        { stacks: hiddenStacks },
      );
    },
  ),
  read(
    "edge_status",
    "Edge status",
    "The HTTPS edge: up or down, its routes and its cert names. `https` says the TLS strategy, who supplies the cert (den, or the distribution under tls strategy files) and whether HTTPS is serving; `certIssuedByDen` replaces the deprecated `certIssued`.",
    {},
    async (_a, { api }) => {
      const edge = await api.get("/api/edge");
      const e =
        edge && typeof edge === "object"
          ? (edge as Record<string, unknown>)
          : null;
      // A web server before 0.4.4: say what certIssued means.
      if (e && e.certIssued !== undefined && e.https === undefined)
        return {
          ...e,
          certIssuedMeans:
            "whether Den minted the cert itself (mkcert); false under tls strategy files, where the distribution supplies it, even while HTTPS serves. Restart the web server for https.serving.",
        };
      return edge;
    },
  ),
];

/**
 * The /api/workspaces body a scoped answer is counted against, read at most
 * once every few seconds per scope (one tool call often makes several).
 */
const WORKSPACES_TTL_MS = 5_000;
const workspacesSeen = new WeakMap<McpScope, { at: number; body: unknown }>();
async function scopeWorkspacesBody(
  api: DenApi,
  scope: McpScope,
): Promise<unknown> {
  const hit = workspacesSeen.get(scope);
  if (hit && Date.now() - hit.at < WORKSPACES_TTL_MS) return hit.body;
  const body = await api.get("/api/workspaces");
  workspacesSeen.set(scope, { at: Date.now(), body });
  return body;
}

/** `answer` with the scope it was served under (MCP-2.2). */
async function withScope(
  api: DenApi,
  scope: McpScope,
  args: Args,
  answer: Record<string, unknown>,
  shows: { count: number; noun: string },
  extraHidden: Record<string, number> = {},
): Promise<Record<string, unknown>> {
  const body = await scopeWorkspacesBody(api, scope);
  return {
    scope: scopeBlock(
      scope,
      body,
      str(args.workspace) ?? scope.workspace,
      shows,
      extraHidden,
    ),
    ...answer,
  };
}

/** A read whose HTTP error is part of the answer, not the whole call's. */
async function softGet(
  api: DenApi,
  path: string,
  query?: Query,
): Promise<unknown> {
  try {
    return await api.get(path, query);
  } catch (e) {
    if (e instanceof DenHttpError)
      return { error: `${e.status} from ${e.path}` };
    throw e;
  }
}

/**
 * The org-wide graph: each active workspace's /api/graph, merged
 * (mergeGraphs). With no active workspace, the web server's default one.
 * `read`: an /api/workspaces body already read.
 */
async function orgGraph(
  api: DenApi,
  get: (path: string, query?: Query) => Promise<unknown>,
  read?: unknown,
): Promise<unknown> {
  const body = read ?? (await api.get("/api/workspaces"));
  const active =
    body &&
    typeof body === "object" &&
    Array.isArray((body as Record<string, unknown>).active)
      ? ((body as Record<string, unknown>).active as unknown[]).map(String)
      : [];
  if (!active.length) {
    const g = await get("/api/graph");
    return g && typeof g === "object" && !Array.isArray(g)
      ? { map: "org-wide", ...(g as Record<string, unknown>) }
      : g;
  }
  const graphs = await Promise.all(
    active.map(async (workspace) => ({
      workspace,
      graph: await get("/api/graph", { workspace }),
    })),
  );
  return mergeGraphs(graphs);
}

// ── Action tools ────────────────────────────────────────────────────────────

/** Find the /api/services entry an action names (repo + optional service). */
async function findService(
  api: DenApi,
  repo: string,
  service: string | undefined,
  workspace: string | undefined,
): Promise<ServiceEntryLike & { repo: string; service: string }> {
  const list = (await api.get("/api/services", {
    env: "local",
    workspace,
  })) as (ServiceEntryLike & {
    repo: string;
    service: string;
    isEntrypoint?: boolean;
  })[];
  const inRepo = list.filter((s) => s.repo === repo);
  const hit = service
    ? inRepo.find((s) => s.service === service)
    : inRepo.length === 1
      ? inRepo[0]
      : inRepo.find((s) => s.isEntrypoint);
  if (!hit)
    throw new Refusal(
      inRepo.length === 0
        ? `no service in repo "${repo}" in the workspace.`
        : `name the service: ${repo} has ${inRepo.map((s) => s.service).join(", ")}.`,
    );
  return hit;
}

function lifecycleTool(cmd: LifecycleCmd): DenTool {
  const verb = { up: "Start", down: "Stop", restart: "Restart" }[cmd];
  return {
    name: `service_${cmd}`,
    title: `${verb} a service`,
    description: `${verb} one locally run service (its manifest's local "${cmd}"; env local only).`,
    action: true,
    shape: {
      repo: z.string(),
      service: z
        .string()
        .optional()
        .describe("Service in a multi-service repo"),
      workspace: workspaceArg,
      env: z.string().optional().describe("Must be local (the default)"),
    },
    async run(a, { api }) {
      assertLifecycleCmd(cmd);
      const env = envOf(a);
      assertLocalEnv(env);
      const workspace = str(a.workspace);
      const entry = await findService(
        api,
        String(a.repo),
        str(a.service),
        workspace,
      );
      assertRunsLocally(entry, cmd);
      const r = await api.stream(
        "/api/service/exec",
        {
          repo: entry.repo,
          service: entry.service,
          cmd,
          env: "local",
          ...(workspace ? { workspace } : {}),
        },
        {
          method: "GET",
          maxLines: 2000,
          timeoutMs: 180_000,
          // A detached start keeps streaming the service's log. It is done
          // when the server says it is ready (health green, or still running
          // with no check), or when its launch script exits (the hand-off).
          stopOn: (e) => e.type === "ready" || e.type === "service-exited",
        },
      );
      const ready = r.events.find((e) => e.type === "ready");
      return actionResult(r, 200, {
        service: `${entry.repo}/${entry.service}`,
        cmd,
        ...(ready
          ? { ready: true, healthChecked: ready.checked === true }
          : {}),
      });
    },
  };
}

/** An agent id or workspace name (WORKSPACE_NAME_RE). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * MCP agent_resume (AG-14.4): resume a stopped or interrupted agent of this
 * workspace (or a granted one) in its own conversation. Opt-in through
 * mcp.actions; for orchestrators. The web server checks the scope again.
 */
const agentResumeTool: DenTool = {
  name: "agent_resume",
  title: "Resume an agent",
  description:
    "Resume a stopped or interrupted agent in the same conversation, persona, workspace and folder. Never starts a new conversation: an agent whose runtime can't resume is refused. Never the caller itself.",
  action: true,
  shape: {
    agent: z.string().describe("The agent's id"),
    workspace: workspaceArg,
  },
  async run(a, { api, scope }) {
    const agent = str(a.agent);
    if (!agent || !NAME_RE.test(agent))
      throw new Refusal("agent_resume: agent must be an agent id");
    let ws = str(a.workspace) ?? scope?.workspace;
    if (!ws) {
      const focused = (await api.get("/api/workspaces")) as {
        focus?: unknown;
      };
      ws = typeof focused?.focus === "string" ? focused.focus : undefined;
    }
    if (!ws || !NAME_RE.test(ws))
      throw new Refusal("agent_resume: name the agent's workspace");
    // Scoped: callTool's scopeArgs pinned `workspace` to the scope (or a
    // granted one, reported) before this runs.
    if (scope && ws !== scope.workspace && !(scope.grants ?? []).includes(ws))
      throw new ScopeRefusal(
        `agent_resume: workspace "${ws}" is outside this agent's scope ("${scope.workspace}")`,
      );
    if (scope && `agent:${agent}` === scope.actor)
      throw new Refusal("agent_resume: an agent can't resume itself");
    return api.get(
      `/api/workspaces/${encodeURIComponent(ws)}/agents/${encodeURIComponent(agent)}/resume`,
      {},
      "POST",
      {},
    );
  },
};

const ACTION_TOOLS: Record<McpAction, DenTool> = {
  service_up: lifecycleTool("up"),
  service_down: lifecycleTool("down"),
  service_restart: lifecycleTool("restart"),
  workspace_sync: {
    name: "workspace_sync",
    title: "Sync managed repos",
    description:
      "Bring managed clones up to date (down, pull, setup; never starts them). Never touches a dev-managed checkout.",
    action: true,
    shape: {
      repo: z.string().optional().describe("One managed repo (default: all)"),
    },
    async run(a, { api, scope }) {
      const repo = str(a.repo);
      // Scoped: the sync names the scoped workspace (the web server's own
      // default is the focused one).
      const ws = scope ? { workspace: scope.workspace } : {};
      if (repo) {
        const services = (await api.get("/api/services", {
          env: "local",
          ...ws,
        })) as ServiceEntryLike[];
        assertSyncableRepo(repo, services);
      }
      const r = await api.stream(
        "/api/workspace/sync",
        repo ? { repo, ...ws } : { ...ws },
        {
          method: "POST",
          maxLines: 5000,
          timeoutMs: 15 * 60_000,
        },
      );
      return actionResult(r, 300);
    },
  },
  run_tests: {
    name: "run_tests",
    title: "Run tests",
    description:
      "Run a test pillar (optionally some modules) in an allowed env (mcp.run_tests.envs, default local; never production). Security runs must pass the owned-host plan; mode full is local only.",
    action: true,
    shape: {
      pillar: z.enum(PILLARS),
      modules: z.array(z.string()).optional(),
      env: envArg,
      mode: z
        .enum(["baseline", "api", "full"])
        .optional()
        .describe("Security scan mode (default baseline)"),
    },
    async run(a, { api, cfg, scope }) {
      const pillar = String(a.pillar);
      const env = envOf(a);
      const modules = (a.modules as string[] | undefined) ?? [];
      const mode =
        pillar === "security" ? (str(a.mode) ?? "baseline") : undefined;
      assertRunTestsAllowed({ pillar, env, mode }, cfg);
      if (scope)
        await crossIfGranted(
          { api, scope },
          "run_tests",
          await assertScopeFocused("run_tests", api, scope),
        );
      if (pillar === "security") {
        for (const service of modules.length ? modules : [undefined]) {
          const plan = (await api.get("/api/security/plan", {
            env,
            mode,
            ...(service ? { service } : {}),
          })) as SecurityPlanLike;
          assertSecurityPlanOk(plan);
        }
      }
      const r = await api.stream(
        "/api/run",
        {
          pillar,
          ...(modules.length ? { module: modules } : {}),
          env,
          ...(mode ? { mode } : {}),
        },
        { method: "GET", maxLines: 20_000, timeoutMs: 60 * 60_000 },
      );
      return actionResult(r, 300, { pillar, env });
    },
  },
  agent_resume: agentResumeTool,
};

export const READ_TOOL_NAMES: readonly string[] = READ_TOOLS.map((t) => t.name);
export const ACTION_TOOL_NAMES: readonly McpAction[] = MCP_ACTIONS;

/** The tools to register: every read tool, plus the actions the org named. */
export function toolsFor(cfg: ResolvedMcpConfig, scope?: McpScope): DenTool[] {
  const tools = [
    ...READ_TOOLS,
    ...MCP_ACTIONS.filter((a) => cfg.actions.includes(a)).map(
      (a) => ACTION_TOOLS[a],
    ),
  ];
  return scope ? tools.map((t) => pinnedTool(t, scope)) : tools;
}

/**
 * Tools that answer about one workspace, and so are "this workspace only"
 * on a scoped server. The rest are the org's (environments, the edge,
 * releases, security scans, the org summary) or take no workspace data.
 */
const WORKSPACE_TOOLS = new Set([
  "status",
  "services",
  "applications",
  "graph",
  "workspaces",
  "logs_search",
  "logs_tail",
  "tests_available",
  "manifest_validate",
  "stacks",
  "service_up",
  "service_down",
  "service_restart",
  "workspace_sync",
  "run_tests",
  "agent_resume",
]);

/**
 * A tool as a scoped server registers it (MCP-2.2): its description says
 * "this workspace only", and its `workspace` parameter is dropped, since it
 * can only be the pinned one. With grants the parameter stays, to name a
 * granted workspace, and says which those are. callTool still refuses a
 * `workspace` naming another one (a one-shot or an old client may send it).
 */
export function pinnedTool(t: DenTool, scope: McpScope): DenTool {
  if (!WORKSPACE_TOOLS.has(t.name)) return t;
  const grants = scope.grants ?? [];
  const only =
    ` This workspace only ("${scope.workspace}"` +
    (grants.length ? `, or a granted one: ${grants.join(", ")}` : "") +
    "); every other workspace is in org_summary, names and counts only.";
  let shape = t.shape;
  if ("workspace" in t.shape) {
    const rest = { ...t.shape };
    delete rest.workspace;
    // A string, not an enum of the allowed names: a schema rejection
    // ("expected one of …") would hide Den's refusal, which names
    // agents.<id>.grants and how a person grants one (MCP-2.3).
    shape = grants.length
      ? {
          ...rest,
          workspace: z
            .string()
            .optional()
            .describe(
              `"${scope.workspace}" (the default) or a granted workspace: ${grants.map((g) => `"${g}"`).join(", ")}; any other is refused`,
            ),
        }
      : rest;
  }
  return { ...t, description: t.description + only, shape };
}

/**
 * The Den version that added each web route a tool reads. The web server keeps
 * running its old code until it is restarted, so an MCP server can be newer
 * than the web server it talks to.
 */
export const ROUTE_SINCE: Readonly<Record<string, string>> = {
  "/api/stacks": "0.2.0",
  "/api/edge": "0.2.0",
  "/api/security/plan": "0.2.0",
};

/** `a` is older than `b`, by major.minor.patch (a pre-release counts as its release). */
export function versionBefore(a: string, b: string): boolean {
  const core = (v: string) =>
    v
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const [x, y] = [core(a), core(b)];
  for (let i = 0; i < 3; i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** The running web server's /api/server-info, or null when it has none. */
async function readServerInfo(
  api: DenApi,
): Promise<Record<string, unknown> | null> {
  try {
    const info = (await api.get("/api/server-info")) as unknown;
    return info && typeof info === "object"
      ? (info as Record<string, unknown>)
      : null;
  } catch (e) {
    if (e instanceof DenHttpError) return null;
    throw e;
  }
}

/**
 * What a 404 means for `tool`. For a route newer than the web server (read
 * from /api/server-info only now, once a call has 404'd), the restart that
 * fixes it; otherwise the plain error.
 */
async function notFoundMessage(
  e: DenHttpError,
  tool: string,
  ctx: ToolContext,
  info: () => Promise<Record<string, unknown> | null>,
): Promise<string> {
  const plain = `Error: ${tool}: the web server answered 404 for ${e.method} ${e.path}: ${e.body}`;
  const since = ROUTE_SINCE[e.path];
  if (!since) return plain;
  const v = (await info())?.version;
  const version = typeof v === "string" ? v : undefined;
  if (version !== undefined && !versionBefore(version, since)) return plain;
  return (
    `web server is Den ${version ?? `< ${since}`}; ` +
    `${tool} needs >= ${since}: run ${ctx.cli} web restart`
  );
}

/**
 * Run one tool: its result as (redacted) text, or an error naming the guard
 * that refused, how to start the web server, or (when it runs an older Den
 * than the tool needs) how to restart it.
 */
/**
 * Tell the web server a guard refused an action, so the activity trail shows
 * the attempt (F2). Best effort: a report that fails changes nothing.
 */
async function reportRefusal(
  ctx: ToolContext,
  tool: string,
  args: Args,
  reason: string,
): Promise<void> {
  try {
    await ctx.api.get("/api/activity", {}, "POST", {
      tool,
      ...(typeof args.repo === "string" ? { repo: args.repo } : {}),
      ...(typeof args.service === "string" ? { service: args.service } : {}),
      ...(Array.isArray(args.targets) ? { targets: args.targets } : {}),
      // A path (manifest_validate): the server records it under the catalog
      // repo it is inside, never as the path itself.
      ...(typeof args.path === "string" ? { path: args.path } : {}),
      reason,
    });
  } catch {
    /* the refusal is still returned to the agent */
  }
}

/**
 * MD-2: when the web server runs an older engine than the one on disk (a
 * pin upgraded Den under it), every failed call says so, naming both
 * versions and the restart. Null when the engines agree or it can't tell.
 */
function staleEngineMessage(
  tool: string,
  ctx: ToolContext,
  info: Record<string, unknown> | null,
): string | null {
  if (info?.engineStale !== true) return null;
  const ver = (x: unknown) =>
    x &&
    typeof x === "object" &&
    typeof (x as { version?: unknown }).version === "string"
      ? (x as { version: string }).version
      : "unknown";
  return (
    `Error: ${tool}: Den was updated to ${ver(info.onDisk)}, but the web server ` +
    `is still running ${ver(info.loaded)}. Restart it: ${ctx.cli} web restart ` +
    `(or your service restart).`
  );
}

/**
 * A scoped server's arguments: the workspace exists (checked once per
 * server), and a tool that takes a workspace gets the scoped one; naming
 * another is refused.
 */
const verifiedScopes = new WeakSet<McpScope>();
async function scopeArgs(
  tool: DenTool,
  args: Args,
  ctx: ToolContext,
  scope: McpScope,
): Promise<Args> {
  if (!verifiedScopes.has(scope)) {
    // The body is the one scoped answers count against (one read).
    await assertScopeExists(
      ctx.api,
      scope,
      await scopeWorkspacesBody(ctx.api, scope),
    );
    verifiedScopes.add(scope);
  }
  if (!("workspace" in tool.shape)) return args;
  const pinned = pinWorkspace(tool.name, args, scope);
  const crossed = crossedWorkspace(pinned, scope);
  if (crossed) {
    await assertGrantExists(tool.name, ctx.api, scope, crossed);
    await reportCrossWorkspace(ctx.api, tool.name, crossed);
  }
  return pinned;
}

/**
 * A call into a granted workspace (AG-2a, §5b) is recorded before it runs,
 * with both workspaces named: the server's entry takes the scoped one from
 * the actor's headers and the target from this report.
 */
async function reportCrossWorkspace(
  api: DenApi,
  tool: string,
  target: string,
): Promise<void> {
  await api.get("/api/activity", {}, "POST", { tool, crossWorkspace: target });
}

/** Report `ws` when it is a granted workspace, not the scope's own. */
async function crossIfGranted(
  ctx: { api: DenApi; scope: McpScope },
  tool: string,
  ws: string,
): Promise<void> {
  if (ws !== ctx.scope.workspace) await reportCrossWorkspace(ctx.api, tool, ws);
}

export async function callTool(
  name: string,
  args: Args,
  ctx: ToolContext,
): Promise<{ text: string; isError: boolean }> {
  const tool = toolsFor(ctx.cfg).find((t) => t.name === name);
  if (!tool)
    return {
      text: `Unknown or disabled tool "${name}". Actions must be named in mcp.actions.`,
      isError: true,
    };
  try {
    const out = await tool.run(
      ctx.scope ? await scopeArgs(tool, args, ctx, ctx.scope) : args,
      ctx,
    );
    const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    return { text: redactSecrets(text), isError: false };
  } catch (e) {
    if (e instanceof ActionFailed)
      return {
        text: redactSecrets(JSON.stringify(e.out, null, 2)),
        isError: true,
      };
    // server-info is read lazily, once, and only after a call failed.
    let infoRead: Promise<Record<string, unknown> | null> | null = null;
    const info = () => (infoRead ??= readServerInfo(ctx.api).catch(() => null));
    if (e instanceof DenHttpError) {
      const stale = staleEngineMessage(name, ctx, await info());
      if (stale)
        return {
          text: redactSecrets(
            `${stale} (${e.method} ${e.path} answered ${e.status}: ${e.body})`,
          ),
          isError: true,
        };
    }
    if (e instanceof DenHttpError && e.status === 404) {
      const text = await notFoundMessage(e, name, ctx, info).catch(
        (inner: Error) => `Error: ${inner.message}`,
      );
      return { text: redactSecrets(text), isError: true };
    }
    // A call outside a scoped server's workspace is recorded whatever the
    // tool: it is an attempt to cross the boundary (AG-2a-core).
    if (e instanceof Refusal && (tool.action || e instanceof ScopeRefusal))
      await reportRefusal(ctx, name, args, e.message);
    const msg =
      e instanceof Refusal
        ? `Refused: ${e.message}`
        : e instanceof DenWebDown ||
            e instanceof ForeignWebServer ||
            e instanceof UnidentifiedWebServer
          ? e.message
          : `Error: ${(e as Error).message}`;
    return { text: redactSecrets(msg), isError: true };
  }
}
