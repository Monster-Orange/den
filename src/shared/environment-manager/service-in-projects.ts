/**
 * Resolve one service for a route that reads it (logs, log history), across
 * projects (issue 235). Without a project the focused one alone hid a repo
 * that lives in another project: its manifest's log command never ran.
 */
import type { ResolvedService } from "../types/index.js";
import { resolveService } from "./service-runner.js";
import {
  getActiveWorkspaces,
  getFocusedWorkspaceName,
  getWorkspaceByName,
} from "./workspaces.js";

export type ServiceInProjects =
  | { resolved: ResolvedService; workspace: string | null; error?: undefined }
  | { resolved: null; error?: string };

/**
 * `addresses` are tried in order inside each project. With `workspaceName`,
 * only that project. Without it: the focused project, then the one other
 * active project that lists the service. Several such projects is an error
 * naming them, never a guess.
 */
export function resolveServiceInProjects(
  addresses: readonly string[],
  workspaceName?: string | null,
): ServiceInProjects {
  const inProject = (ws?: string): ResolvedService | null => {
    for (const a of addresses) {
      const r = resolveService(a, ws);
      if (r) return r;
    }
    return null;
  };
  if (workspaceName) {
    if (!getWorkspaceByName(workspaceName))
      return {
        resolved: null,
        error: `Project "${workspaceName}" does not exist`,
      };
    const r = inProject(workspaceName);
    return r ? { resolved: r, workspace: workspaceName } : { resolved: null };
  }
  const focused = getFocusedWorkspaceName();
  const here = inProject();
  if (here) return { resolved: here, workspace: focused };
  const found: { ws: string; r: ResolvedService }[] = [];
  for (const ws of getActiveWorkspaces()) {
    if (ws === focused) continue;
    const r = inProject(ws);
    if (r) found.push({ ws, r });
  }
  if (found.length === 1)
    return { resolved: found[0].r, workspace: found[0].ws };
  if (found.length > 1)
    return {
      resolved: null,
      error:
        `"${addresses[0]}" is in more than one project ` +
        `(${found.map((f) => f.ws).join(", ")}): name the project`,
    };
  return { resolved: null };
}
