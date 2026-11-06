/**
 * The focus (WS-6.1, 0.4.3): one value, "all" (every workspace on this
 * machine) or one of them, stored as workspaces.yml `focus`. It is what
 * every page, the top bar's status chip and `<cli> status` show, and the
 * default target for commands (`up`, `restart`, the Workspaces actions).
 *
 * - **Focus only filters.** Changing it starts, stops and routes nothing.
 * - With "all", a command that needs one workspace takes the first one on
 *   this machine; names resolve across them all (target-workspace.ts).
 * - It replaces 0.3.0's separate view scope (user.yml `view.scope`): a
 *   stored one becomes the focus the first time it is read, silently.
 *
 * "On this machine" is the file's `active` list (WS-6.2): the set that is
 * polled, listed and switchable, never "running". Health covers all of it,
 * whatever is in focus (pollView, WS-6.4).
 */
import {
  readUserConfig,
  writeUserConfig,
  type UserConfig,
} from "../den-config.js";
import type { WorkspaceConfig } from "../types/index.js";
import {
  FOCUS_ALL,
  readWorkspacesFile,
  setFocusedWorkspace,
} from "./workspaces.js";

/** "all", or one workspace's name. */
export type ViewScope = string;
export const ALL_ACTIVE = FOCUS_ALL;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A 0.3.0 view scope (user.yml `view.scope`), normalised: "all" unless a plausible name. */
export function storedScope(user: Pick<UserConfig, "view">): ViewScope {
  const s = user.view?.scope;
  return typeof s === "string" && s !== ALL_ACTIVE && NAME.test(s)
    ? s
    : ALL_ACTIVE;
}

/**
 * Fold a 0.3.0 view scope into the focus, once and silently: a stored
 * `view.scope` ("all" or a workspace on this machine) becomes the focus,
 * and `view` leaves user.yml. One naming a workspace no longer on this
 * machine is dropped and the focus stays. Never throws: an unreadable or
 * unwritable config leaves things as they are.
 */
export function migrateViewScope(): void {
  let user: UserConfig;
  try {
    user = readUserConfig();
  } catch {
    return;
  }
  if (!user.view || typeof user.view !== "object") return;
  try {
    const scope = storedScope(user);
    const file = readWorkspacesFile();
    if (scope === ALL_ACTIVE || file.active.includes(scope))
      setFocusedWorkspace(scope);
    const next = { ...user };
    delete next.view;
    writeUserConfig(next);
  } catch {
    /* a read-only config: the focus stays as stored */
  }
}

/** The stored focus: "all" or a workspace on this machine. */
export function storedFocus(): ViewScope {
  migrateViewScope();
  const file = readWorkspacesFile();
  const f = file.focus;
  if (f === ALL_ACTIVE) return ALL_ACTIVE;
  return f && file.active.includes(f) ? f : (file.active[0] ?? ALL_ACTIVE);
}

/** Store the focus ("all" or a workspace on this machine). */
export function writeFocus(value: ViewScope): void {
  migrateViewScope();
  setFocusedWorkspace(value);
}

/**
 * The workspaces in view, the command target first, then the others on
 * this machine in their file order. A named focus no longer on this
 * machine falls back to all (so removing a workspace never empties the
 * view). Pure.
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

/** What a view resolves to: the focus asked for, and what is in it. */
export interface ScopeView {
  /** The focus ("all" or a workspace). */
  scope: ViewScope;
  /** True when a named focus is not on this machine any more: showing all. */
  fellBack: boolean;
  /** The workspaces in view, the command target first. */
  workspaces: { name: string; config: WorkspaceConfig }[];
  /** The workspace commands default to (the focus, or the first with "all"). */
  focus: string | null;
}

/** The view for `scope` (default: the stored focus). */
export function scopeView(scope?: ViewScope): ScopeView {
  const want = scope ?? storedFocus();
  const file = readWorkspacesFile();
  const known = Object.keys(file.workspaces);
  const stored = file.focus === ALL_ACTIVE ? undefined : file.focus;
  const one = want !== ALL_ACTIVE && file.active.includes(want) ? want : null;
  const focusName =
    process.env.DEN_WORKSPACE_OVERRIDE ??
    one ??
    stored ??
    file.active[0] ??
    null;
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

/**
 * WS-6.4: what health covers, whatever is in focus: every workspace on
 * this machine. The focus only filters what is displayed (inViewMarker);
 * it never narrows what is polled, so a workspace outside it still shows
 * its real health on the Workspaces page.
 */
export function pollView(): ScopeView {
  return scopeView(ALL_ACTIVE);
}

/**
 * Whether a health row is in view: one of the workspaces that define it
 * (`workspaces`, its owners) is in `view`. A row without owners counts as
 * in view.
 */
export function inViewMarker(
  view: ScopeView,
): (owners: readonly string[] | undefined) => boolean {
  const names = new Set(view.workspaces.map((w) => w.name));
  return (owners) => !owners?.length || owners.some((o) => names.has(o));
}

/** A cache key for what is in view (the focus's workspaces, in order). */
export function scopeKey(view: ScopeView): string {
  return view.workspaces.map((w) => w.name).join(",");
}

/**
 * Validate a focus a client asks for: "all", or a workspace on this
 * machine. Pure; the caller stores it (writeFocus).
 */
export function parseScope(
  raw: unknown,
  active: string[],
): { ok: true; value: ViewScope } | { ok: false; error: string } {
  if (raw === ALL_ACTIVE) return { ok: true, value: ALL_ACTIVE };
  if (typeof raw !== "string" || !NAME.test(raw))
    return { ok: false, error: `focus must be "all" or a workspace name` };
  if (!active.includes(raw))
    return { ok: false, error: `workspace "${raw}" is not on this machine` };
  return { ok: true, value: raw };
}

/** What `/api/scope` returns: the focus, what it shows, and the command target. */
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
 * Take `--scope <all|workspace>` (or `--scope=…`) out of argv: a one-off
 * focus for this command (0.3.0's flag, kept for scripts). `--all` is not
 * it: on `status` that already means verbose (one row per service).
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
 * The focus line `status` prints, so a reader sees what is in view:
 * "Focus: all workspaces (a, b, c)" or "Focus: a".
 */
export function scopeLine(view: ScopeView): string {
  const names = view.workspaces.map((w) => w.name);
  const what =
    view.scope !== ALL_ACTIVE && !view.fellBack
      ? view.scope
      : `all workspaces (${names.join(", ") || "none"})`;
  const fell = view.fellBack ? ` (${view.scope} is not on this machine)` : "";
  return `Focus: ${what}${fell}`;
}

/** " · a, b" after a shared service's name; "" when one workspace owns it. */
export function ownersSuffix(owners: string[] | undefined): string {
  return owners && owners.length > 1 ? ` · ${owners.join(", ")}` : "";
}
