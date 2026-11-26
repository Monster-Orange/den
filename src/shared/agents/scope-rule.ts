import { isServerScope } from "./server-agent.js";

export interface ScopeHolder {
  workspace: string;
  grants?: readonly string[];
}

export function scopeReaches(holder: ScopeHolder, ws: string): boolean {
  return (
    isServerScope(holder.workspace) ||
    ws === holder.workspace ||
    (holder.grants ?? []).includes(ws)
  );
}

export function scopeWords(holder: ScopeHolder): string {
  const g = holder.grants ?? [];
  return `project ${holder.workspace}${g.length ? ` (or ${g.join(", ")}, its grants)` : ""}`;
}

export interface WorkspaceShape {
  maps?: readonly string[];
  lists?: readonly string[];
  names?: readonly string[];
  rows?: readonly string[];
}

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
