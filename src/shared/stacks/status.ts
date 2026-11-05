/**
 * Read-only stack status: what `stack ls` and `stack health` show, as data.
 * The CLI prints it; the web server serves it at /api/stacks (and through it
 * the MCP `stacks` tool).
 */
import { spawnSync } from "child_process";
import { readEdgeConfig } from "../edge/config.js";
import { routeUrl } from "../edge/render.js";
import {
  getFocusedWorkspaceName,
  getWorkspaceByName,
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

/** A compose stack a workspace's repo declares, by its Compose project. */
export interface WorkspaceStack {
  name: string;
  repo: string;
  project: string;
}

/**
 * The Compose projects with running containers, from one `docker ps`; null
 * when docker can't be asked (not installed, daemon down, too slow).
 */
export function runningComposeProjects(): Set<string> | null {
  const r = spawnSync(
    "docker",
    ["ps", "--format", '{{.Label "com.docker.compose.project"}}'],
    { encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
  );
  if (r.error || r.status !== 0) return null;
  return new Set(
    (r.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * `workspace`'s compose stacks (declared by its repos' manifests) that are
 * running: what `workspace deactivate` leaves up, since it releases only the
 * daemons Den tracks. Null when docker could not be asked.
 */
export function runningWorkspaceStacks(
  workspace: string,
  running: () => Set<string> | null = runningComposeProjects,
): WorkspaceStack[] | null {
  const ws = getWorkspaceByName(workspace);
  if (!ws) return [];
  let stacks: WorkspaceStack[];
  try {
    const { stackWorkspace: suffix } = resolveStackWorkspaces(workspace);
    stacks = Object.values(readManifestStacks(workspace)).map((s) => ({
      name: s.name,
      repo: s.repo,
      project: projectName(s.name, suffix),
    }));
  } catch {
    return null; // an unreadable manifest or workspace name: can't tell
  }
  if (stacks.length === 0) return [];
  const up = running();
  if (!up) return null;
  return stacks.filter((s) => up.has(s.project));
}
