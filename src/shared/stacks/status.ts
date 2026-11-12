/**
 * Read-only stack status: what `stack ls` and `stack health` show, as data.
 * The CLI prints it; the web server serves it at /api/stacks (and through it
 * the MCP `stacks` tool).
 */
import { product } from "../product.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { readCatalog } from "../environment-manager/catalog.js";
import { readEdgeConfig } from "../edge/config.js";
import { routeUrl } from "../edge/render.js";
import {
  getActiveWorkspaces,
  getFocusedWorkspaceName,
  getWorkspaceByName,
  listWorkspaceServices,
} from "../environment-manager/workspaces.js";
import { readManifestStacks, readStacks } from "./config.js";
import { STACK_NAMESPACE_RE } from "../den-config.js";
import {
  resolveStackNamespace,
  type StackNamespaceSource,
} from "./namespace.js";
import { projectName } from "./render.js";
import {
  projectOwnership,
  rejoinEdgeNetworks,
  stackHealth,
  stackOwner,
  type StackContext,
} from "./runtime.js";

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
  /** `ok: null`: docker could not be asked, so the state is unknown. */
  health?: { ok: boolean | null; detail: string };
}

/**
 * The den workspace stacks read their manifests from, and the Compose
 * project suffix they run under. `denWorkspace` defaults to the CLI's
 * -w override, then the focused workspace, then `default`. The suffix is
 * the workspace's stack namespace (namespace.ts); DEN_STACK_WORKSPACE, a
 * per-command override, wins over it for this one process (source `env`).
 *
 * The one place a den workspace becomes a Compose project suffix: every
 * stack path (status, runtime, health, container lookup) comes through here.
 */
export function resolveStackWorkspaces(
  denWorkspace?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): {
  denWorkspace: string;
  stackWorkspace: string;
  source: StackNamespaceSource | "env";
} {
  const fkWs =
    denWorkspace ||
    env.DEN_WORKSPACE_OVERRIDE ||
    getFocusedWorkspaceName() ||
    "default";
  const override = env.DEN_STACK_WORKSPACE;
  const resolved = override ? null : resolveStackNamespace(fkWs);
  const ws = override || resolved!.namespace;
  if (!STACK_NAMESPACE_RE.test(ws))
    throw new Error(
      `workspace "${ws}" must be lowercase letters, digits and dashes`,
    );
  return {
    denWorkspace: fkWs,
    stackWorkspace: ws,
    source: resolved ? resolved.source : "env",
  };
}

/** The edge, the known stacks and the project suffix for one workspace. */
export function loadStackContext(denWorkspace?: string | null): StackContext {
  const {
    denWorkspace: fkWs,
    stackWorkspace: ws,
    source,
  } = resolveStackWorkspaces(denWorkspace);
  const edge = readEdgeConfig();
  // Repo manifests come from that den workspace's checkouts.
  const stacks = readStacks(undefined, {
    workspace: getWorkspaceByName(fkWs) ? fkWs : undefined,
  });
  return {
    edge,
    stacks,
    workspace: ws,
    denWorkspace: fkWs,
    namespaceSource: source,
  };
}

/** D53: a Compose project name two of Den's stacks, or something else, use. */
export interface ProjectClash {
  project: string;
  /** Den's stacks rendering to it: `<stack> (<den workspace>)`. */
  stacks: string[];
  /** Running containers in it no listed stack started. */
  foreign: string[];
}

/**
 * D53: every Compose project name the focused and active workspaces' stacks
 * render to that is not theirs alone: two stacks with different checkouts
 * (stack "a-b" in namespace "c" and "a" in "b-c" are both "a-b-c"), or a
 * project already running containers Den didn't start for it. Workspaces
 * sharing a namespace on one checkout are one stack, not a clash.
 */
export function stackProjectClashes(
  contexts: StackContext[] = allStackContexts(),
  ownership: typeof projectOwnership = projectOwnership,
): ProjectClash[] {
  const by = new Map<
    string,
    { owners: Set<string>; stacks: Set<string>; foreign: Set<string> }
  >();
  for (const ctx of contexts)
    for (const st of Object.values(ctx.stacks)) {
      const project = projectName(st.name, ctx.workspace);
      const e = by.get(project) ?? {
        owners: new Set(),
        stacks: new Set(),
        foreign: new Set(),
      };
      by.set(project, e);
      e.owners.add(stackOwner(ctx, st));
      e.stacks.add(`${st.name} (${ctx.denWorkspace ?? ctx.workspace})`);
      const o = ownership(ctx, st);
      for (const f of o.foreign) e.foreign.add(f);
    }
  const out: ProjectClash[] = [];
  for (const [project, e] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    // Two stacks: each one's containers are foreign to the other; the
    // clash says it all.
    const foreign = e.owners.size > 1 ? [] : [...e.foreign].sort();
    if (e.owners.size > 1 || foreign.length)
      out.push({ project, stacks: [...e.stacks].sort(), foreign });
  }
  return out;
}

/** The focused and active workspaces' stack contexts (unreadable: skipped). */
export function allStackContexts(): StackContext[] {
  const contexts: StackContext[] = [];
  for (const ws of new Set([null, ...getActiveWorkspaces()]))
    try {
      contexts.push(loadStackContext(ws));
    } catch {
      /* unreadable */
    }
  return contexts;
}

/**
 * After edge up: the edge back on the routed networks of every running
 * stack it routes (rejoinEdgeNetworks), across the focused and active
 * workspaces' stack namespaces. A workspace whose stacks cannot be read is
 * skipped.
 */
export function rejoinRunningStacks(
  onLine: (line: string) => void = console.log,
): string[] {
  return rejoinEdgeNetworks(allStackContexts(), onLine);
}

/**
 * Why a workspace has no stacks (MCP-2.4): an empty list with no reason
 * reads as "docker is broken". A stack is a `stacks:` entry in the org
 * config, or a repo of the workspace whose manifest has a `compose:` block.
 */
export function emptyStacksReason(o: {
  workspace: string;
  workspaceExists: boolean;
  /** How many stacks the org config itself declares. */
  configStacks: number;
}): string {
  const cfg = `the org config (${product().configFile}) declares no stacks:`;
  if (!o.workspaceExists)
    return (
      `no stacks: workspace "${o.workspace}" does not exist here, so no ` +
      `repo manifest was read, and ${cfg}`
    );
  return (
    `no stacks: ${cfg}, and no repo of workspace "${o.workspace}" has a ` +
    `compose: block in its ${product().manifestYml}`
  );
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
        status.health = { ok: null, detail: (e as Error).message };
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
