/**
 * What `<cli> switch <ws> [--stop-others]` does (WS-6.7, WS-6.8), worked
 * out from the workspaces' repos before anything runs.
 *
 * - **Starts:** the target's repos that aren't running (`up -a -w <ws>`
 *   starts what isn't running and leaves what is), by the web UI's rule
 *   (running.ts): a check that answers, a record whose process is alive,
 *   or compose containers. A repo runs when each of its services does.
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
import { checkServiceHealth } from "../../shared/environment-manager/health.js";
import {
  isRunning,
  trackedAddresses,
} from "../../shared/environment-manager/running.js";
import { listDaemons } from "../../shared/environment-manager/service-runner.js";
import { listWorkspaceServices } from "../../shared/environment-manager/workspaces.js";
import { processRows } from "../../shared/process/process-group.js";
import { hasRuntime, repoKind } from "../../shared/repo-kind.js";
import type { WorkspacesFile } from "../../shared/types/index.js";

export interface SwitchPlan {
  target: string;
  /** The target's repos (those that run). */
  repos: string[];
  starts: string[];
  stops: { workspace: string; repos: string[] }[];
  keeps: { repo: string; with: string[] }[];
}

function servicesOf(file: WorkspacesFile, name: string) {
  const config = file.workspaces[name];
  if (!config) return [];
  let catalog = {};
  try {
    catalog = readCatalog();
  } catch {
    catalog = {};
  }
  return listWorkspaceServices(config, catalog, name).filter((svc) =>
    hasRuntime(repoKind(svc.repoPath)),
  );
}

/** A workspace's repos that run (modules and libraries never do). */
export function runtimeRepos(file: WorkspacesFile, name: string): string[] {
  const repos: string[] = [];
  for (const svc of servicesOf(file, name))
    if (!repos.includes(svc.repoName)) repos.push(svc.repoName);
  return repos;
}

/**
 * The workspace's repos that run now: each service Den starts here runs
 * (running.ts isRunning: its check answers, its record's process is alive,
 * or compose containers are found). A repo with nothing Den starts here
 * (remote, or no commands for local) is never "not running".
 */
export async function runningRepos(
  file: WorkspacesFile,
  name: string,
): Promise<Set<string>> {
  const daemons = listDaemons();
  const rows = daemons.some((d) => typeof d.pgid === "number")
    ? await processRows()
    : null;
  const tracked = trackedAddresses(daemons, rows);
  const notRunning = new Set<string>();
  const repos = new Set<string>();
  await Promise.all(
    servicesOf(file, name).map(async (svc) => {
      repos.add(svc.repoName);
      const h = await checkServiceHealth(svc, "local");
      if (h.runs === "remote" || h.runs === "none") return;
      const row = {
        repo: svc.repoName,
        service: svc.subsystem,
        ok: h.health === "ok" ? true : h.health === "error" ? false : null,
        error: h.healthDetail,
      };
      if (!isRunning(row, tracked)) notRunning.add(svc.repoName);
    }),
  );
  return new Set([...repos].filter((r) => !notRunning.has(r)));
}

/**
 * The plan for switching to `target`. Pure apart from `reposOf`. `running`
 * (runningRepos) leaves the target's repos that already run out of starts;
 * without it every repo of the target is listed.
 */
export function switchPlanFor(
  target: string,
  active: readonly string[],
  file: WorkspacesFile,
  reposOf: (ws: string) => string[] = (ws) => runtimeRepos(file, ws),
  running?: ReadonlySet<string>,
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
    repos: mine,
    starts: running ? mine.filter((r) => !running.has(r)) : mine,
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
    plan.starts.length || !plan.repos.length
      ? `Starts: what isn't running in ${plan.target} (${plan.starts.join(", ") || "no repos"})`
      : `Starts: nothing (everything in ${plan.target} runs)`,
  );
  const keeps = [
    ...plan.keeps.map((k) => `${k.repo} (shared with ${k.with.join(", ")})`),
    "agents and sessions",
  ];
  out.push(`Keeps running: ${keeps.join(", ")}`);
  return out;
}
