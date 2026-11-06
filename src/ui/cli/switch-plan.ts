/**
 * What `<cli> switch <ws> [--stop-others]` does (WS-6.7, WS-6.8), worked
 * out from the workspaces' repos before anything runs.
 *
 * - **Starts:** the target's repos (`up -a -w <ws>` starts what isn't
 *   running and leaves what is).
 * - **Stops** (only with --stop-others): every other workspace's repos on
 *   this machine, except repos the target also has. A repo two other
 *   workspaces share is stopped once.
 * - **Keeps running:** the target's repos that another workspace also has
 *   (shared), and every agent and session: services are stopped, sessions
 *   never are.
 *
 * The web UI's dialog works the same plan out from live health
 * (public/workspace-status.js switchPlan), so it lists only what runs.
 */
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import { listWorkspaceServices } from "../../shared/environment-manager/workspaces.js";
import { hasRuntime, repoKind } from "../../shared/repo-kind.js";
import type { WorkspacesFile } from "../../shared/types/index.js";

export interface SwitchPlan {
  target: string;
  starts: string[];
  stops: { workspace: string; repos: string[] }[];
  keeps: { repo: string; with: string[] }[];
}

/** A workspace's repos that run (modules and libraries never do). */
export function runtimeRepos(file: WorkspacesFile, name: string): string[] {
  const config = file.workspaces[name];
  if (!config) return [];
  let catalog = {};
  try {
    catalog = readCatalog();
  } catch {
    catalog = {};
  }
  const repos: string[] = [];
  for (const svc of listWorkspaceServices(config, catalog, name))
    if (hasRuntime(repoKind(svc.repoPath)) && !repos.includes(svc.repoName))
      repos.push(svc.repoName);
  return repos;
}

/** The plan for switching to `target`. Pure apart from `reposOf`. */
export function switchPlanFor(
  target: string,
  active: readonly string[],
  file: WorkspacesFile,
  reposOf: (ws: string) => string[] = (ws) => runtimeRepos(file, ws),
): SwitchPlan {
  const mine = reposOf(target);
  const own = new Set(mine);
  const others = active.filter((w) => w !== target);
  const seen = new Set<string>();
  const stops: SwitchPlan["stops"] = [];
  const shared = new Map<string, string[]>();
  for (const ws of others) {
    const repos: string[] = [];
    for (const r of reposOf(ws)) {
      if (own.has(r)) {
        shared.set(r, [...(shared.get(r) ?? []), ws]);
        continue;
      }
      if (seen.has(r)) continue;
      seen.add(r);
      repos.push(r);
    }
    if (repos.length) stops.push({ workspace: ws, repos });
  }
  return {
    target,
    starts: mine,
    stops,
    keeps: mine
      .filter((r) => shared.has(r))
      .map((r) => ({ repo: r, with: shared.get(r)! })),
  };
}

/** The plan as `switch` prints it (and `--dry-run` stops after). */
export function switchPlanLines(
  plan: SwitchPlan,
  stopOthers: boolean,
): string[] {
  const out = [
    stopOthers
      ? `Stop & Switch to ${plan.target}`
      : `Switch to ${plan.target}: nothing else stops`,
  ];
  if (stopOthers)
    out.push(
      plan.stops.length
        ? `Stops: ${plan.stops.map((s) => `${s.workspace} (${s.repos.join(", ")})`).join(", ")}`
        : "Stops: nothing (no other workspace has repos of its own)",
    );
  out.push(
    `Starts: what isn't running in ${plan.target} (${plan.starts.join(", ") || "no repos"})`,
  );
  const keeps = [
    ...plan.keeps.map((k) => `${k.repo} (shared with ${k.with.join(", ")})`),
    "agents and sessions",
  ];
  out.push(`Keeps running: ${keeps.join(", ")}`);
  return out;
}
