/**
 * Read-only stack status: what `stack ls` and `stack health` show, as data.
 * The CLI prints it; the web server serves it at /api/stacks (and through it
 * the MCP `stacks` tool).
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { readCatalog } from "../environment-manager/catalog.js";
import { readEdgeConfig } from "../edge/config.js";
import { routeUrl } from "../edge/render.js";
import {
  getFocusedWorkspaceName,
  getWorkspaceByName,
  listWorkspaceServices,
} from "../environment-manager/workspaces.js";
import { readManifestStacks, readStacks } from "./config.js";
import { projectName, stackWorkspace } from "./render.js";
import { stackHealth, type StackContext } from "./runtime.js";

export interface StackRoute {
  name: string;
  url: string;
  /** `<service>:<container port>`. */
  target: string;
}

export interface StackStatus {
  name: string;
  repo: string;
  dir: string | null;
  /** The Compose project: `<stack>-<workspace>`. */
  project: string;
  routes: StackRoute[];
  uses: string[];
  /** Container health (only when asked for: it runs `docker ps`). */
  health?: { ok: boolean; detail: string };
}

const WS_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The den workspace stacks read their manifests from, and the Compose
 * project suffix they run under. `denWorkspace` defaults to the CLI's
 * -w override, then the focused workspace, then `default`.
 */
export function resolveStackWorkspaces(
  denWorkspace?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { denWorkspace: string; stackWorkspace: string } {
  const fkWs =
    denWorkspace ||
    env.DEN_WORKSPACE_OVERRIDE ||
    getFocusedWorkspaceName() ||
    "default";
  const ws = env.DEN_STACK_WORKSPACE || stackWorkspace(fkWs);
  if (!WS_RE.test(ws))
    throw new Error(
      `workspace "${ws}" must be lowercase letters, digits and dashes`,
    );
  return { denWorkspace: fkWs, stackWorkspace: ws };
}

/** The edge, the known stacks and the project suffix for one workspace. */
export function loadStackContext(denWorkspace?: string | null): StackContext {
  const { denWorkspace: fkWs, stackWorkspace: ws } =
    resolveStackWorkspaces(denWorkspace);
  const edge = readEdgeConfig();
  // Repo manifests come from that den workspace's checkouts.
  const stacks = readStacks(undefined, {
    workspace: getWorkspaceByName(fkWs) ? fkWs : undefined,
  });
  return { edge, stacks, workspace: ws };
}

/** Each stack's name, project, routes and (optionally) container health. */
export function stackStatuses(
  ctx: StackContext,
  opts: { health?: boolean; healthOf?: typeof stackHealth } = {},
): StackStatus[] {
  const healthOf = opts.healthOf ?? stackHealth;
  return Object.values(ctx.stacks).map((s) => {
    const status: StackStatus = {
      name: s.name,
      repo: s.repo,
      dir: s.dir ?? null,
      project: projectName(s.name, ctx.workspace),
      routes: Object.entries(s.routes).map(([route, target]) => ({
        name: route,
        url: routeUrl(`${route}.${s.name}`, ctx.edge),
        target,
      })),
      uses: [...s.uses],
    };
    if (opts.health) {
      try {
        status.health = healthOf(ctx, s);
      } catch (e) {
        status.health = { ok: false, detail: (e as Error).message };
      }
    }
    return status;
  });
}

/** A running Compose project started from one of a workspace's repos. */
export interface WorkspaceStack {
  /** The Den stack name, or the project name for a stack the repo runs. */
  name: string;
  repo: string;
  project: string;
}

/** A running Compose project and the directory it was started from. */
export interface RunningProject {
  project: string;
  /** `com.docker.compose.project.working_dir`; "" when unlabelled. */
  workingDir: string;
}

/**
 * The Compose projects with running containers, from one `docker ps`; null
 * when docker can't be asked (not installed, daemon down, too slow).
 */
export function runningComposeProjects(): RunningProject[] | null {
  const r = spawnSync(
    "docker",
    [
      "ps",
      "--format",
      '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
    ],
    { encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
  );
  if (r.error || r.status !== 0) return null;
  const seen = new Map<string, RunningProject>();
  for (const line of (r.stdout ?? "").split("\n")) {
    const [project = "", workingDir = ""] = line.trim().split("\t");
    if (project && !seen.has(project))
      seen.set(project, { project, workingDir: workingDir.trim() });
  }
  return [...seen.values()];
}

/** `p` and its realpath (compose may record either form). */
function pathForms(p: string): string[] {
  try {
    const real = fs.realpathSync(p);
    return real === p ? [p] : [p, real];
  } catch {
    return [p];
  }
}

/**
 * `workspace`'s running compose stacks: what `workspace deactivate` leaves
 * up, since it releases only the daemons Den tracks. A project counts when
 * it is a Den stack one of the workspace's repos declares (`compose:`, named
 * by projectName), or when Compose started it from inside one of the
 * workspace's checkouts (its working_dir label): the stacks a repo runs
 * itself, e.g. from `make up`. Null when docker could not be asked.
 */
export function runningWorkspaceStacks(
  workspace: string,
  running: () => RunningProject[] | null = runningComposeProjects,
): WorkspaceStack[] | null {
  const ws = getWorkspaceByName(workspace);
  if (!ws) return [];
  const denStacks = new Map<string, { name: string; repo: string }>();
  const checkouts: { repo: string; forms: string[] }[] = [];
  try {
    const { stackWorkspace: suffix } = resolveStackWorkspaces(workspace);
    for (const s of Object.values(readManifestStacks(workspace)))
      denStacks.set(projectName(s.name, suffix), {
        name: s.name,
        repo: s.repo,
      });
    const seen = new Set<string>();
    for (const svc of listWorkspaceServices(ws.config, readCatalog(), ws.name))
      if (svc.repoPath && !seen.has(svc.repoPath)) {
        seen.add(svc.repoPath);
        checkouts.push({ repo: svc.repoName, forms: pathForms(svc.repoPath) });
      }
  } catch {
    return null; // an unreadable manifest or workspace name: can't tell
  }
  if (denStacks.size === 0 && checkouts.length === 0) return [];
  const up = running();
  if (!up) return null;
  const inside = (dir: string, root: string): boolean =>
    dir === root || dir.startsWith(`${root}${path.sep}`);
  const out: WorkspaceStack[] = [];
  for (const { project, workingDir } of up) {
    const den = denStacks.get(project);
    if (den) {
      out.push({ ...den, project });
      continue;
    }
    if (!workingDir) continue;
    const dirs = pathForms(workingDir);
    const owner = checkouts.find((c) =>
      c.forms.some((root) => dirs.some((d) => inside(d, root))),
    );
    if (owner) out.push({ name: project, repo: owner.repo, project });
  }
  return out;
}
