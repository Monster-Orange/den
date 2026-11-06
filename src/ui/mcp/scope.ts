/**
 * A scoped MCP server (AG-2a-core): `<cli> mcp --workspace <ws> --actor
 * agent:<id>`. It pins one workspace, refuses any call that names another,
 * filters lists to it, and stamps the actor on every web API call (the
 * x-den-mcp-agent / x-den-mcp-workspace headers, see shared/agent-actor.ts).
 *
 * It binds cooperating agents only: the scope lives in this process, and the
 * web server's HTTP API does not check it yet (WS-3a).
 */
import * as path from "path";
import { AGENT_ACTOR_RE, WORKSPACE_NAME_RE } from "../../shared/agent-actor.js";
import type { DenApi } from "./api.js";
import { Refusal } from "./guards.js";

export interface McpScope {
  /** The one workspace this server serves. */
  workspace: string;
  /** Who acts: `agent:<id>`. */
  actor: string;
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

const FLAGS: Record<string, "workspace" | "actor"> = {
  "--workspace": "workspace",
  "-w": "workspace",
  "--actor": "actor",
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
    if (got[key] !== undefined && got[key] !== value)
      throw new ScopeUsageError(`--${key} given twice`);
    got[key] = value;
  }
  if (got.workspace === undefined && got.actor === undefined)
    return { scope: null, rest };
  if (got.workspace === undefined)
    throw new ScopeUsageError(
      "--actor needs --workspace: a scoped server serves one workspace",
    );
  if (got.actor === undefined)
    throw new ScopeUsageError(
      "--workspace needs --actor agent:<id>: a scoped server says who acts",
    );
  if (!WORKSPACE_NAME_RE.test(got.workspace))
    throw new ScopeUsageError(
      `--workspace "${printable(got.workspace)}" is not a workspace name ` +
        "(letters, digits, dots, dashes, underscores; at most 64)",
    );
  if (!AGENT_ACTOR_RE.test(got.actor))
    throw new ScopeUsageError(
      `--actor "${printable(got.actor)}" is not agent:<id> ` +
        "(the id: letters, digits, dots, dashes, underscores; at most 64)",
    );
  return { scope: { workspace: got.workspace, actor: got.actor }, rest };
}

/** A value echoed back in an error: one printable line, bounded. */
function printable(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, "?").slice(0, 80);
}

/** The refusal for a call that names `other`. */
export function otherWorkspace(
  tool: string,
  scope: McpScope,
  other: string,
): ScopeRefusal {
  return new ScopeRefusal(
    `${tool}: this MCP server is scoped to workspace "${scope.workspace}" ` +
      `(${scope.actor}); "${printable(other)}" is another workspace, so nothing was read or run.`,
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
  if (ws !== undefined && ws !== null && ws !== "" && ws !== scope.workspace)
    throw otherWorkspace(tool, scope, String(ws));
  return { ...args, workspace: scope.workspace };
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
  const only = (v: unknown): Record<string, unknown> => {
    const r = asRecord(v);
    return ws in r ? { [ws]: r[ws] } : {};
  };
  return {
    active: Array.isArray(b.active) ? b.active.filter((n) => n === ws) : [],
    ...(b.focus === ws ? { focus: ws } : {}),
    workspaces: only(b.workspaces),
    ...(b.resolvedDirs !== undefined
      ? { resolvedDirs: only(b.resolvedDirs) }
      : {}),
    ...(b.codeWorkspacePaths !== undefined
      ? { codeWorkspacePaths: only(b.codeWorkspacePaths) }
      : {}),
    scope: { workspace: ws, actor: scope.actor },
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
): Promise<unknown> {
  const body = await api.get("/api/workspaces");
  if (!(scope.workspace in asRecord(asRecord(body).workspaces)))
    throw new ScopeRefusal(
      `this MCP server is scoped to workspace "${scope.workspace}", which does not exist in this distribution.`,
    );
  return body;
}

/**
 * Tests run against the focused workspace (the web server has no workspace
 * argument for them): a scoped server runs or lists them only when that is
 * its own.
 */
export async function assertScopeFocused(
  tool: string,
  api: DenApi,
  scope: McpScope,
): Promise<void> {
  const focused = focusedOf(await api.get("/api/workspaces"));
  if (focused !== scope.workspace)
    throw new ScopeRefusal(
      `${tool}: tests run against the focused workspace` +
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
        `of workspace "${scope.workspace}", the only one this MCP server serves; nothing was read.`,
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
      `${tool}: a scoped MCP server takes an absolute path inside workspace "${scope.workspace}"'s repos (or the manifest content).`,
    );
  const target = path.resolve(p);
  const roots = (await scopedEntries(api, scope))
    .map((e) => e.repoPath)
    .filter((r): r is string => typeof r === "string" && r.length > 0)
    .map((r) => path.resolve(r));
  if (!roots.some((r) => target === r || target.startsWith(r + path.sep)))
    throw new ScopeRefusal(
      `${tool}: ${printable(p)} is not inside a repo of workspace "${scope.workspace}", the only one this MCP server serves; nothing was read.`,
    );
}
