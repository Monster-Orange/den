/**
 * The view scope (0.3.0-dev.16): which workspaces' repos are in view, the
 * one source for the header's health row, the pages and `<cli> status`.
 *
 * - **Scope** is a view filter: "all" (every active workspace) or one
 *   active workspace. It is a user preference (user.yml `view.scope`) and
 *   changes nothing else: no edge route, container or service.
 * - **Focus** is the default target for commands (`up`, `restart`, the
 *   Local Dev actions). Scope never changes it.
 *
 * "all" is the default, also with several active workspaces: the health
 * row already covered every active workspace, so a page that showed only
 * the focused one disagreed with the row above it. With one active
 * workspace "all" and that workspace are the same view.
 */
import { readUserConfig, type UserConfig } from "../den-config.js";
import type { WorkspaceConfig } from "../types/index.js";
import { readWorkspacesFile } from "./workspaces.js";

/** "all", or one workspace's name. */
export type ViewScope = string;
export const ALL_ACTIVE = "all";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The stored scope, normalised: "all" unless a plausible workspace name. */
export function storedScope(user: Pick<UserConfig, "view">): ViewScope {
  const s = user.view?.scope;
  return typeof s === "string" && s !== ALL_ACTIVE && NAME.test(s)
    ? s
    : ALL_ACTIVE;
}

/**
 * The workspaces in view, focused first, then the other active ones in
 * their file order. A named scope that is no longer active falls back to
 * all active (so a deactivated workspace never empties the view). Pure.
 */
export function scopeWorkspaceNames(
  scope: ViewScope,
  ws: { active: string[]; focus: string | null; known: string[] },
): string[] {
  const active = ws.active.filter((n) => ws.known.includes(n));
  if (scope !== ALL_ACTIVE && active.includes(scope)) return [scope];
  const focus = ws.focus && active.includes(ws.focus) ? ws.focus : null;
  return [...(focus ? [focus] : []), ...active.filter((n) => n !== focus)];
}

/** What a view resolves to: the scope asked for, and what is in it. */
export interface ScopeView {
  /** The stored scope ("all" or a workspace). */
  scope: ViewScope;
  /** True when a named scope is not active any more: showing all. */
  fellBack: boolean;
  /** The workspaces in view, focused first. */
  workspaces: { name: string; config: WorkspaceConfig }[];
  /** The focused workspace: the default target for commands. */
  focus: string | null;
}

/** The view for `scope` (default: the user's stored one). */
export function scopeView(scope?: ViewScope): ScopeView {
  const want = scope ?? storedScope(readUserConfig());
  const file = readWorkspacesFile();
  const known = Object.keys(file.workspaces);
  const focusName =
    process.env.DEN_WORKSPACE_OVERRIDE ?? file.focus ?? file.active[0] ?? null;
  const focus = focusName && file.workspaces[focusName] ? focusName : null;
  const names = scopeWorkspaceNames(want, {
    active: file.active,
    focus,
    known,
  });
  return {
    scope: want,
    fellBack: want !== ALL_ACTIVE && !names.includes(want),
    workspaces: names.map((name) => ({
      name,
      config: file.workspaces[name],
    })),
    focus,
  };
}

/** A cache key for what is in view (the scope's workspaces, in order). */
export function scopeKey(view: ScopeView): string {
  return view.workspaces.map((w) => w.name).join(",");
}

/**
 * Validate a scope a client asks for: "all", or a workspace that is active
 * now. Pure; the caller stores the result in user.yml `view`.
 */
export function parseScope(
  raw: unknown,
  active: string[],
): { ok: true; value: ViewScope } | { ok: false; error: string } {
  if (raw === ALL_ACTIVE) return { ok: true, value: ALL_ACTIVE };
  if (typeof raw !== "string" || !NAME.test(raw))
    return { ok: false, error: `scope must be "all" or a workspace name` };
  if (!active.includes(raw))
    return { ok: false, error: `workspace "${raw}" is not active` };
  return { ok: true, value: raw };
}

/** The `view` block to store: none for the default, so user.yml stays lean. */
export function storedView(scope: ViewScope): UserConfig["view"] | undefined {
  return scope === ALL_ACTIVE ? undefined : { scope };
}

/** What `/api/scope` returns: the scope, what it shows, and the focus. */
export function scopePayload(view: ScopeView): {
  scope: ViewScope;
  fellBack: boolean;
  inView: string[];
  focus: string | null;
} {
  return {
    scope: view.fellBack ? ALL_ACTIVE : view.scope,
    fellBack: view.fellBack,
    inView: view.workspaces.map((w) => w.name),
    focus: view.focus,
  };
}

/**
 * Take `--scope <all|workspace>` (or `--scope=…`) out of argv. `--all` is
 * not it: on `status` that already means verbose (one row per service).
 */
export function takeScopeFlag(argv: string[]): {
  scope: string | null;
  rest: string[];
  error?: string;
} {
  const rest: string[] = [];
  let scope: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scope") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-"))
        return { scope: null, rest, error: "--scope needs all or a workspace" };
      scope = v;
      i++;
    } else if (a.startsWith("--scope=")) scope = a.slice("--scope=".length);
    else rest.push(a);
  }
  return { scope, rest };
}

/**
 * The scope line `status` prints, so a reader sees what is in view and
 * what commands target: "Scope: all active (a, b, c) · focus: a".
 */
export function scopeLine(view: ScopeView): string {
  const names = view.workspaces.map((w) => w.name);
  const what =
    view.scope !== ALL_ACTIVE && !view.fellBack
      ? view.scope
      : `all active (${names.join(", ") || "none"})`;
  const fell = view.fellBack ? ` (${view.scope} is not active)` : "";
  return `Scope: ${what}${fell} · focus: ${view.focus ?? "none"}`;
}

/** " · a, b" after a shared service's name; "" when one workspace owns it. */
export function ownersSuffix(owners: string[] | undefined): string {
  return owners && owners.length > 1 ? ` · ${owners.join(", ")}` : "";
}
