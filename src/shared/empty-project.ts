/**
 * Issue 1334: a project with no repos, no services and no agents is
 * empty. That is a normal state (Den's own `default` often is), never a
 * problem: Doctor doesn't warn that it has no Hub project, and nothing
 * suggests or asks to link one for it.
 */
import type { WorkspaceConfig } from "./types/index.js";

/** What an agent record says about where it belongs. */
export interface AgentPlace {
  workspace: string;
  project?: string;
}

export function isEmptyProject(
  ws: string,
  cfg: WorkspaceConfig | undefined,
  agents: readonly AgentPlace[],
): boolean {
  if (cfg) {
    if (Object.keys(cfg.repos ?? {}).length) return false;
    if (Object.keys(cfg.services ?? {}).length) return false;
    if ((cfg.seeded_repos ?? []).length) return false;
  }
  return !agents.some((a) => a.workspace === ws || a.project === ws);
}

/**
 * A check for many projects, reading the file and the agent records
 * once. If either won't read, nothing counts as empty: an error never
 * hides a project.
 */
export function emptyProjectTest(
  file: () => { workspaces: Record<string, WorkspaceConfig> },
  agents: () => readonly AgentPlace[],
): (ws: string) => boolean {
  let all: Record<string, WorkspaceConfig>;
  let places: readonly AgentPlace[];
  try {
    all = file().workspaces ?? {};
    places = agents();
  } catch {
    return () => false;
  }
  return (ws) => isEmptyProject(ws, all[ws], places);
}

/** This install's check: workspaces.yml and the agent records now. */
export async function emptyProjectsNow(): Promise<(ws: string) => boolean> {
  const [w, rec, paths] = await Promise.all([
    import("./environment-manager/workspaces.js"),
    import("./agents/records.js"),
    import("./paths.js"),
  ]);
  return emptyProjectTest(
    () => w.readWorkspacesFile(),
    () => rec.listRecords(paths.getStateDir()),
  );
}
