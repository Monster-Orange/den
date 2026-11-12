/**
 * D70: `/api/workspaces/<name>/…`, `?ws=<name>` and `?workspace=<name>` with
 * a workspace's name (any case, or the slug of what was typed) become its
 * key (slug), so every route takes either. Anything else is unchanged.
 */
import { resolveWorkspaceKey } from "../../shared/workspace-name.js";

export function workspaceUrl(
  raw: string,
  workspaces: () => Record<string, { name?: unknown }>,
): string {
  const q = raw.indexOf("?");
  const p = q < 0 ? raw : raw.slice(0, q);
  let query = q < 0 ? "" : raw.slice(q + 1);
  const m = /^\/api\/workspaces\/([^/]+)(\/.*)?$/.exec(p);
  const wantsQuery = /(^|&)(ws|workspace)=/.test(query);
  if (!m && !wantsQuery) return raw;
  const all = workspaces();
  const key = (v: string): string | undefined =>
    Object.prototype.hasOwnProperty.call(all, v)
      ? undefined
      : resolveWorkspaceKey(v, all);
  let path = p;
  if (m) {
    let seg: string;
    try {
      seg = decodeURIComponent(m[1]);
    } catch {
      seg = m[1];
    }
    const k = key(seg);
    if (k) path = `/api/workspaces/${encodeURIComponent(k)}${m[2] ?? ""}`;
  }
  if (wantsQuery) {
    const sp = new URLSearchParams(query);
    let changed = false;
    for (const name of ["ws", "workspace"]) {
      const v = sp.get(name);
      const k = v ? key(v) : undefined;
      if (k) {
        sp.set(name, k);
        changed = true;
      }
    }
    if (changed) query = sp.toString();
  }
  return query ? `${path}?${query}` : path;
}
