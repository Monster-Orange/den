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
  DenWebDown,
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

export interface ToolContext {
  api: DenApi;
  cfg: ResolvedMcpConfig;
  /** The CLI name, for messages (`<cli> web up`). */
  cli: string;
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
function streamSummary(r: StreamResult, keep: number) {
  return {
    ended: r.ended,
    ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
    lines: r.lines.length,
    output: tail(r, keep),
  };
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
    "Health of every service in the workspace (what `status` shows): up/down, URL, mode.",
    { env: envArg, workspace: workspaceArg },
    (a, { api }) =>
      api.get("/api/health", { env: envOf(a), workspace: str(a.workspace) }),
  ),
  read(
    "services",
    "Services",
    "The workspace's services: repo, service, mode (managed or dev-managed), lifecycle commands, dependencies.",
    { env: envArg, workspace: workspaceArg },
    (a, { api }) =>
      api.get("/api/services", { env: envOf(a), workspace: str(a.workspace) }),
  ),
  read(
    "applications",
    "Applications",
    "Org > Application > Repo > Services for a workspace (what `apps --json` shows).",
    { workspace: workspaceArg },
    (a, { api }) =>
      api.get("/api/applications", { workspace: str(a.workspace) }),
  ),
  read(
    "graph",
    "Dependency graph",
    "The derived dependency graph and its startup order; `seed` narrows it to one repo's closure.",
    {
      seed: z.string().optional().describe("Repo whose closure to show"),
      workspace: workspaceArg,
    },
    (a, { api }) =>
      api.get("/api/graph", { seed: str(a.seed), workspace: str(a.workspace) }),
  ),
  read(
    "workspaces",
    "Workspaces",
    "Workspaces, which are active and which is focused.",
    {},
    (_a, { api }) => api.get("/api/workspaces"),
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
    async (a, { api, cfg }) => {
      const env = envOf(a);
      assertLogsEnv(env, cfg);
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
    async (a, { api, cfg }) => {
      const env = envOf(a);
      assertLogsEnv(env, cfg);
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
    async (a, { api }) => ({
      modules: await api.get("/api/modules", { pillar: String(a.pillar) }),
      sources: await api.get("/api/test-sources", { pillar: String(a.pillar) }),
    }),
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
    async (a, { api }) => {
      if (str(a.content) !== undefined)
        return api.get("/api/manifest/validate", {}, "POST", {
          content: a.content,
        });
      if (str(a.path) === undefined)
        throw new Refusal("give a path or the manifest content.");
      return api.get("/api/manifest/validate", { path: str(a.path) });
    },
  ),
  read(
    "stacks",
    "Stacks",
    "Compose stacks (what `stack ls/ps/health` show): name, project, routes and container health.",
    {
      workspace: workspaceArg,
      health: z
        .boolean()
        .optional()
        .describe("Check container health (default true)"),
    },
    (a, { api }) =>
      api.get("/api/stacks", {
        workspace: str(a.workspace),
        health: a.health === false ? "0" : "1",
      }),
  ),
  read(
    "edge_status",
    "Edge status",
    "The HTTPS edge: up or down, its routes and its cert names.",
    {},
    (_a, { api }) => api.get("/api/edge"),
  ),
];

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
      assertRunsLocally(entry);
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
          // A detached `up` keeps streaming the service's log; its launch
          // script exiting is the hand-off.
          stopOn: (e) => e.type === "service-exited",
        },
      );
      return {
        service: `${entry.repo}/${entry.service}`,
        cmd,
        ...streamSummary(r, 200),
      };
    },
  };
}

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
    async run(a, { api }) {
      const repo = str(a.repo);
      if (repo) {
        const services = (await api.get("/api/services", {
          env: "local",
        })) as ServiceEntryLike[];
        assertSyncableRepo(repo, services);
      }
      const r = await api.stream("/api/workspace/sync", repo ? { repo } : {}, {
        method: "POST",
        maxLines: 5000,
        timeoutMs: 15 * 60_000,
      });
      return streamSummary(r, 300);
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
    async run(a, { api, cfg }) {
      const pillar = String(a.pillar);
      const env = envOf(a);
      const modules = (a.modules as string[] | undefined) ?? [];
      const mode =
        pillar === "security" ? (str(a.mode) ?? "baseline") : undefined;
      assertRunTestsAllowed({ pillar, env, mode }, cfg);
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
      return { pillar, env, ...streamSummary(r, 300) };
    },
  },
};

export const READ_TOOL_NAMES: readonly string[] = READ_TOOLS.map((t) => t.name);
export const ACTION_TOOL_NAMES: readonly McpAction[] = MCP_ACTIONS;

/** The tools to register: every read tool, plus the actions the org named. */
export function toolsFor(cfg: ResolvedMcpConfig): DenTool[] {
  return [
    ...READ_TOOLS,
    ...MCP_ACTIONS.filter((a) => cfg.actions.includes(a)).map(
      (a) => ACTION_TOOLS[a],
    ),
  ];
}

/**
 * Run one tool: its result as (redacted) text, or an error naming the guard
 * that refused, or how to start the web server.
 */
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
    const out = await tool.run(args, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    return { text: redactSecrets(text), isError: false };
  } catch (e) {
    const msg =
      e instanceof Refusal
        ? `Refused: ${e.message}`
        : e instanceof DenWebDown
          ? e.message
          : `Error: ${(e as Error).message}`;
    return { text: redactSecrets(msg), isError: true };
  }
}
