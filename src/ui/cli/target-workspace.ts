/**
 * Which workspace a lifecycle command (`setup`, `up`, `down`, `restart`)
 * names its services in, when no `-w` says.
 *
 * The focused workspace is the default target (WS-6.1). A name it doesn't
 * hold resolves across the other active workspaces, as the web API does
 * with `&workspace=` (resolveService(address, workspace)):
 *
 *  - in the focus: the focus (nothing changes);
 *  - in exactly one other active workspace: that one;
 *  - in several: an error that lists them (`-w <workspace>` picks one);
 *  - nowhere: an error (exit 1, never a silent exit 0).
 *
 * Every name must land in one workspace; names in different workspaces are
 * an error (run them one workspace at a time, with `-w`).
 */
import {
  resolveService,
  serviceAliasCandidates,
} from "../../shared/environment-manager/service-runner.js";
import {
  getActiveWorkspaces,
  getFocusedWorkspaceName,
} from "../../shared/environment-manager/workspaces.js";

export type TargetWorkspace =
  | { ok: true; workspace: string | null }
  | { ok: false; error: string };

/** Whether `name` names a service (a repo, an address or an alias) in `ws`. */
export function nameResolvesIn(name: string, ws: string): boolean {
  return (
    resolveService(name, ws) !== null ||
    serviceAliasCandidates(name, ws).length > 0
  );
}

/**
 * The workspace `names` resolve in, given the focus and the active set:
 * `workspace: null` when it is the focus (or there are no names). Pure
 * apart from `resolves`.
 */
export function targetWorkspaceFor(
  names: readonly string[],
  o: {
    cli: string;
    command: string;
    focus: string | null;
    active: readonly string[];
    resolves: (name: string, ws: string) => boolean;
  },
): TargetWorkspace {
  if (names.length === 0) return { ok: true, workspace: null };
  const others = o.active.filter((w) => w !== o.focus);
  const where = new Map<string, string>();
  for (const name of names) {
    if (o.focus && o.resolves(name, o.focus)) {
      where.set(name, o.focus);
      continue;
    }
    const hits = others.filter((w) => o.resolves(name, w));
    if (hits.length === 0) {
      const looked = [o.focus, ...others].filter(Boolean).join(", ");
      return {
        ok: false,
        error: `"${name}" is not a service in any workspace on this machine (${looked || "none"}).`,
      };
    }
    if (hits.length > 1)
      return {
        ok: false,
        error:
          `"${name}" is in more than one workspace on this machine: ` +
          `${hits.map((w) => `${w} (${o.cli} ${o.command} ${name} -w ${w})`).join(", ")}. ` +
          "Name one with -w.",
      };
    where.set(name, hits[0]);
  }
  const workspaces = [...new Set(where.values())];
  if (workspaces.length > 1)
    return {
      ok: false,
      error:
        "These names are in different workspaces: " +
        `${[...where].map(([n, w]) => `${n} (${w})`).join(", ")}. ` +
        `Run ${o.cli} ${o.command} once per workspace, with -w.`,
    };
  const ws = workspaces[0];
  return { ok: true, workspace: ws === o.focus ? null : ws };
}

/** targetWorkspaceFor over this distribution's workspaces. */
export function resolveTargetWorkspace(
  names: readonly string[],
  cli: string,
  command: string,
): TargetWorkspace {
  return targetWorkspaceFor(names, {
    cli,
    command,
    focus: getFocusedWorkspaceName(),
    active: getActiveWorkspaces(),
    resolves: nameResolvesIn,
  });
}
