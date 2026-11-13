/**
 * A scoped MCP server (AG-2a-core): `<cli> mcp --workspace <ws> --actor
 * agent:<id>`. It pins one workspace, refuses any call that names another,
 * filters lists to it, and stamps the actor on every web API call (the
 * x-den-mcp-agent / x-den-mcp-workspace headers, see shared/agent-actor.ts).
 *
 * `--grant <ws>` (AG-2a, AG spec §5b; repeatable) widens the scope to another
 * workspace, and only as far as the org config's `agents.<id>.grants` says
 * (checkGrants): an agent never grants itself one. A call that names a
 * granted workspace is served, and reported to the audit trail with both
 * workspaces named. Lists show the scoped workspace and its grants.
 *
 * It binds cooperating agents only: the scope lives in this process, and the
 * web server's HTTP API does not check it yet (WS-3a).
 */
import * as path from "path";
import { AGENT_ACTOR_RE, WORKSPACE_NAME_RE } from "../../shared/agent-actor.js";
import type { ResolvedAgentsConfig } from "../../shared/den-config.js";
import type { DenApi } from "./api.js";
import { Refusal } from "./guards.js";

export interface McpScope {
  /** The one workspace this server serves. */
  workspace: string;
  /** Who acts: `agent:<id>`. */
  actor: string;
  /**
   * Other workspaces it may name (`--grant`, from agents.<id>.grants);
   * absent when there are none.
   */
  grants?: string[];
}

/** The workspaces a scope serves: its own first, then its grants. */
export function scopeWorkspaces(scope: McpScope): string[] {
  return [scope.workspace, ...(scope.grants ?? [])];
}

/** A call reached outside the scoped workspace. Always reported (F2). */
export class ScopeRefusal extends Refusal {
  constructor(message: string) {
    super(message);
    this.name = "ScopeRefusal";
  }
}

/** `--workspace` / `--actor` were given wrongly: a usage error (exit 2). */
export class ScopeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeUsageError";
  }
}

const FLAGS: Record<string, "workspace" | "actor" | "grant"> = {
  "--workspace": "workspace",
  "-w": "workspace",
  "--actor": "actor",
  "--grant": "grant",
};

/**
 * Take `--workspace <ws>` (or `-w`) and `--actor agent:<id>` out of `argv`,
 * also in the `--flag=value` form. Both or neither: a scope without an actor
 * would act unattributed, an actor without a scope would look bound when it
 * is not. Returns the scope (null when neither is given) and the rest of
 * argv, unchanged otherwise.
 */
export function parseScopeFlags(argv: readonly string[]): {
  scope: McpScope | null;
  rest: string[];
} {
  const got: Partial<Record<"workspace" | "actor", string>> = {};
  const grants: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("-") && eq !== -1 ? a.slice(0, eq) : a;
    const key = FLAGS[name];
    if (!key) {
      rest.push(a);
      continue;
    }
    let value: string | undefined;
    if (name !== a) value = a.slice(eq + 1);
    else {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("-"))
        throw new ScopeUsageError(`${name} needs a value`);
      i++;
    }
    if (key === "grant") {
      if (!WORKSPACE_NAME_RE.test(value))
        throw new ScopeUsageError(
          `--grant "${printable(value)}" is not a project name`,
        );
      if (!grants.includes(value)) grants.push(value);
      continue;
    }
    if (got[key] !== undefined && got[key] !== value)
      throw new ScopeUsageError(`--${key} given twice`);
    got[key] = value;
  }
  if (got.workspace === undefined && got.actor === undefined) {
    if (grants.length)
      throw new ScopeUsageError(
        "--grant needs --workspace and --actor: a grant widens a scoped server",
      );
    return { scope: null, rest };
  }
  if (got.workspace === undefined)
    throw new ScopeUsageError(
      "--actor needs --workspace: a scoped server serves one project",
    );
  if (got.actor === undefined)
    throw new ScopeUsageError(
      "--workspace needs --actor agent:<id>: a scoped server says who acts",
    );
  if (!WORKSPACE_NAME_RE.test(got.workspace))
    throw new ScopeUsageError(
      `--workspace "${printable(got.workspace)}" is not a project name ` +
        "(letters, digits, dots, dashes, underscores; at most 64)",
    );
  if (!AGENT_ACTOR_RE.test(got.actor))
    throw new ScopeUsageError(
      `--actor "${printable(got.actor)}" is not agent:<id> ` +
        "(the id: letters, digits, dots, dashes, underscores; at most 64)",
    );
  const widened = grants.filter((g) => g !== got.workspace);
  return {
    scope: {
      workspace: got.workspace,
      actor: got.actor,
      ...(widened.length ? { grants: widened } : {}),
    },
    rest,
  };
}

/**
 * Null when every `--grant` is one the org config gives this agent
 * (`agents.<id>.grants`), else the refusal. A grant is config in git,
 * reviewed like code: a flag alone never widens a scope.
 */
export function checkGrants(
  scope: McpScope,
  agents: Pick<ResolvedAgentsConfig, "agents">,
): string | null {
  const id = scope.actor.slice("agent:".length);
  const allowed = agents.agents[id]?.grants ?? [];
  for (const g of scope.grants ?? [])
    if (!allowed.includes(g))
      return (
        `--grant ${g}: ${scope.actor} has no such grant in agents.${id}.grants ` +
        "of the org config; a grant is config, never a flag alone"
      );
  return null;
}

/** A value echoed back in an error: one printable line, bounded. */
function printable(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
}

/**
 * A path echoed back in an error: one printable line, never cut mid-name
 * (0.3.0-dev.40, a consumer's 0.2.8 nit: printable's 80-character cap cut
 * the filename). Up to `max` characters it is whole; a longer one keeps its
 * start and its last segment whole, eliding the middle with "…".
 */
export function printablePath(v: string, max = 160): string {
  const s = v.replace(/[^\x20-\x7e]/g, "?");
  if (s.length <= max) return s;
  const cut = s.lastIndexOf("/");
  const tail = cut >= 0 ? s.slice(cut) : s;
  // The last segment is kept whole whatever its length; the room left is
  // shared between the path's start and the directories just before it.
  const room = max - tail.length - 1;
  if (room <= 0) return `…${tail}`;
  const head = s.slice(0, Math.ceil(room / 2));
  const end = s.length - tail.length;
  const more = s.slice(end - (room - head.length), end);
  return `${head}…${more}${tail}`;
}

/** "grants: a, b" or "no grants": what else the scope reaches. */
function grantsNote(scope: McpScope): string {
  return scope.grants?.length
    ? `grants: ${scope.grants.join(", ")}`
    : "no grants";
}

/**
 * How a person gives `scope`'s agent a grant to `other` (MCP-2.3, AG spec
 * §5b): config in git, then a restart. An agent never grants itself one.
 */
export function grantHint(scope: McpScope, other: string): string {
  const id = scope.actor.slice("agent:".length);
  return (
    `To reach it, a person adds "${printable(other)}" to agents.${id}.grants ` +
    `in the org config and restarts the agent (agents start passes --grant); ` +
    "an agent can't grant itself one. For names and status counts of every " +
    "project, call org_summary."
  );
}

/** The refusal for a call that names `other`; it names the agent's grants. */
export function otherWorkspace(
  tool: string,
  scope: McpScope,
  other: string,
): ScopeRefusal {
  return new ScopeRefusal(
    `${tool}: this MCP server is scoped to project "${scope.workspace}" ` +
      `(${scope.actor}; ${grantsNote(scope)}); "${printable(other)}" is another project, so nothing was read or run. ` +
      grantHint(scope, other),
  );
}

/**
 * A tool's arguments with the workspace pinned: absent, it becomes the
 * scoped one; another one is refused before anything is asked of the API.
 */
export function pinWorkspace(
  tool: string,
  args: Record<string, unknown>,
  scope: McpScope,
): Record<string, unknown> {
  const ws = args.workspace;
  if (ws === undefined || ws === null || ws === "")
    return { ...args, workspace: scope.workspace };
  if (!scopeWorkspaces(scope).includes(String(ws)))
    throw otherWorkspace(tool, scope, String(ws));
  return { ...args, workspace: String(ws) };
}

/** The granted workspace `args` names, or null for the scope's own. */
export function crossedWorkspace(
  args: Record<string, unknown>,
  scope: McpScope,
): string | null {
  const ws = args.workspace;
  return typeof ws === "string" && ws && ws !== scope.workspace ? ws : null;
}

/** What /api/workspaces answers (the fields the scope reads). */
interface WorkspacesBody {
  active?: unknown;
  focus?: unknown;
  workspaces?: unknown;
  [k: string]: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/**
 * /api/workspaces narrowed to the scoped workspace: only its entry, its
 * resolved directory and code-workspace path, `active` holding it or empty,
 * and `focus` only when it is the focus. Everything else is left out.
 */
export function filterWorkspacesBody(
  body: unknown,
  scope: McpScope,
): Record<string, unknown> {
  const b = asRecord(body) as WorkspacesBody;
  const ws = scope.workspace;
  const served = scopeWorkspaces(scope);
  const only = (v: unknown): Record<string, unknown> => {
    const r = asRecord(v);
    return Object.fromEntries(
      served.filter((n) => n in r).map((n) => [n, r[n]]),
    );
  };
  return {
    active: Array.isArray(b.active)
      ? b.active.filter((n) => served.includes(n as string))
      : [],
    ...(typeof b.focus === "string" && served.includes(b.focus)
      ? { focus: b.focus }
      : {}),
    workspaces: only(b.workspaces),
    ...(b.resolvedDirs !== undefined
      ? { resolvedDirs: only(b.resolvedDirs) }
      : {}),
    ...(b.codeWorkspacePaths !== undefined
      ? { codeWorkspacePaths: only(b.codeWorkspacePaths) }
      : {}),
    scope: {
      workspace: ws,
      actor: scope.actor,
      ...(scope.grants?.length ? { grants: scope.grants } : {}),
    },
  };
}

/** The workspace /api/workspaces says is focused (focus, else active[0]). */
function focusedOf(body: unknown): string | null {
  const b = asRecord(body) as WorkspacesBody;
  if (typeof b.focus === "string" && b.focus) return b.focus;
  if (Array.isArray(b.active) && typeof b.active[0] === "string")
    return b.active[0];
  return null;
}

/**
 * Throws unless the scoped workspace exists in this distribution. A missing
 * one must not fall through to the web server's "no workspace" defaults,
 * which list services outside any workspace.
 */
export async function assertScopeExists(
  api: DenApi,
  scope: McpScope,
  /** An /api/workspaces body already read (else it is read now). */
  read?: unknown,
): Promise<unknown> {
  const body = read ?? (await api.get("/api/workspaces"));
  if (!(scope.workspace in asRecord(asRecord(body).workspaces)))
    throw new ScopeRefusal(
      `this MCP server is scoped to project "${scope.workspace}", which does not exist in this distribution.`,
    );
  return body;
}

/** Throws unless the granted workspace `ws` exists in this distribution. */
export async function assertGrantExists(
  tool: string,
  api: DenApi,
  scope: McpScope,
  ws: string,
): Promise<void> {
  const body = await api.get("/api/workspaces");
  if (!(ws in asRecord(asRecord(body).workspaces)))
    throw new ScopeRefusal(
      `${tool}: ${scope.actor} has a grant for project "${printable(ws)}", which does not exist in this distribution; nothing was read or run.`,
    );
}

/**
 * Tests run against the focused workspace (the web server has no workspace
 * argument for them): a scoped server runs or lists them only when that is
 * its own or a granted one. Returns the focused workspace.
 */
export async function assertScopeFocused(
  tool: string,
  api: DenApi,
  scope: McpScope,
): Promise<string> {
  const focused = focusedOf(await api.get("/api/workspaces"));
  // A granted workspace that is focused is served too (and audited).
  if (focused && scopeWorkspaces(scope).includes(focused)) return focused;
  throw new ScopeRefusal(
    `${tool}: tests run against the focused project` +
      `${focused ? ` ("${focused}")` : ""}, and this MCP server is scoped to ` +
      `"${scope.workspace}". Focus "${scope.workspace}" first; nothing was read or run.`,
  );
}

/** The fields of an /api/services entry the scope checks read. */
interface ScopedEntry {
  repo?: unknown;
  service?: unknown;
  repoPath?: unknown;
}

async function scopedEntries(
  api: DenApi,
  scope: McpScope,
): Promise<ScopedEntry[]> {
  const list = await api.get("/api/services", {
    env: "local",
    workspace: scope.workspace,
  });
  return Array.isArray(list) ? (list as ScopedEntry[]) : [];
}

/** Every `repo/service` must be one of the scoped workspace's services. */
export async function assertServicesInScope(
  tool: string,
  api: DenApi,
  scope: McpScope,
  targets: readonly { repo: string; service: string }[],
): Promise<void> {
  const entries = await scopedEntries(api, scope);
  const have = new Set(entries.map((e) => `${e.repo}/${e.service}`));
  const outside = targets
    .map((t) => `${t.repo}/${t.service}`)
    .filter((t) => !have.has(t));
  if (outside.length)
    throw new ScopeRefusal(
      `${tool}: ${outside.map(printable).join(", ")} ${outside.length === 1 ? "is" : "are"} not a service ` +
        `of project "${scope.workspace}", the only one this MCP server serves; nothing was read. ` +
        "Logs and service details stay inside each project (logs can hold " +
        "secrets), and a grant does not widen them; org_summary has every " +
        "project's status counts.",
    );
}

/** A manifest path must be absolute and inside one of the workspace's repos. */
export async function assertPathInScope(
  tool: string,
  api: DenApi,
  scope: McpScope,
  p: string,
): Promise<void> {
  if (!path.isAbsolute(p))
    throw new ScopeRefusal(
      `${tool}: a scoped MCP server takes an absolute path inside project "${scope.workspace}"'s repos (or the manifest content).`,
    );
  const target = path.resolve(p);
  const roots = (await scopedEntries(api, scope))
    .map((e) => e.repoPath)
    .filter((r): r is string => typeof r === "string" && r.length > 0)
    .map((r) => path.resolve(r));
  if (!roots.some((r) => target === r || target.startsWith(r + path.sep)))
    throw new ScopeRefusal(
      `${tool}: ${printablePath(p)} is not inside a repo of project "${scope.workspace}", the only one this MCP server serves; nothing was read.`,
    );
}
