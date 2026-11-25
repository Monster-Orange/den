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
