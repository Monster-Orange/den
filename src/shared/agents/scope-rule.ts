/**
 * An agent's project scope: the one rule the MCP server (mcp/scope.ts) and
 * the web server (request-guard.ts) both apply.
 *
 * An agent reaches its own project and the projects its grants name
 * (agents.<id>.grants in the org config, recorded with its token when it
 * was minted). The server agent's reserved scope reaches every project: it
 * is Den's own setup partner, and its MCP server is unscoped too.
 */
import { isServerScope } from "./server-agent.js";

export interface ScopeHolder {
  /** Its project (or the server agent's reserved scope). */
  workspace: string;
  /** The other projects it may name. */
  grants?: readonly string[];
}

/** Whether `holder` may name project `ws`. */
export function scopeReaches(holder: ScopeHolder, ws: string): boolean {
  return (
    isServerScope(holder.workspace) ||
    ws === holder.workspace ||
    (holder.grants ?? []).includes(ws)
  );
}

/** "project a (or b, c, its grants)": what the holder reaches, in words. */
export function scopeWords(holder: ScopeHolder): string {
  const g = holder.grants ?? [];
  return `project ${holder.workspace}${g.length ? ` (or ${g.join(", ")}, its grants)` : ""}`;
}

/** Which parts of a response are per project (narrowByWorkspace). */
export interface WorkspaceShape {
  /** Objects keyed by project name. */
  maps?: readonly string[];
  /** Lists of project names. */
  lists?: readonly string[];
  /** One project's name; dropped when it isn't kept. */
  names?: readonly string[];
  /** Lists of rows, each naming its project in `workspace`. */
  rows?: readonly string[];
}

/**
 * `body` with only the projects `keep` passes, in the fields `shape`
 * names. Every other field is left as it is.
 */
export function narrowByWorkspace<T extends Record<string, unknown>>(
  body: T,
  keep: (ws: string) => boolean,
  shape: WorkspaceShape,
): T {
  const out: Record<string, unknown> = { ...body };
  for (const k of shape.maps ?? []) {
    const v = out[k];
    if (v && typeof v === "object" && !Array.isArray(v))
      out[k] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([ws]) => keep(ws)),
      );
  }
  for (const k of shape.lists ?? []) {
    const v = out[k];
    if (Array.isArray(v))
      out[k] = v.filter((ws) => typeof ws === "string" && keep(ws));
  }
  for (const k of shape.names ?? []) {
    const v = out[k];
    if (typeof v === "string" && !keep(v)) delete out[k];
  }
  for (const k of shape.rows ?? []) {
    const v = out[k];
    if (Array.isArray(v))
      out[k] = v.filter((r) => {
        const ws = (r as { workspace?: unknown } | null)?.workspace;
        return typeof ws === "string" && keep(ws);
      });
  }
  return out as T;
}
