/**
 * Read-only status endpoints (GET only):
 *
 *   /api/stacks          what `stack ls` + `stack health` show
 *                        ?workspace=<den workspace>  ?health=0 skips docker
 *   /api/edge            what `edge status` shows: up/down, routes, cert names
 *   /api/security/plan   the security CLI's own dry run for ?env&mode&service:
 *                        target discovery and the owned-host check, nothing run
 *   /api/activity        the audit trail for one service (?address=repo/svc) or
 *                        repo (?repo=): execs and syncs, yours and agents',
 *                        newest first (the graph panel's Activity tab)
 *
 * The MCP server's `stacks`, `edge_status` and `run_tests` (its security
 * pre-flight) read these. Collaborators are injectable for tests.
 */
import * as http from "http";
import { readEdgeConfig } from "../../shared/edge/config.js";
import { edgeStatus, type EdgeStatus } from "../../shared/edge/status.js";
import { getWorkspaceByName } from "../../shared/environment-manager/workspaces.js";
import {
  loadStackContext,
  resolveStackWorkspaces,
  stackStatuses,
  type StackStatus,
} from "../../shared/stacks/status.js";
import { send400, sendJson } from "./http-helpers.js";
import { recentActions, type AuditEntry } from "./audit.js";

export interface SecurityPlanArgs {
  env: string;
  mode: string;
  service?: string;
}

export interface SecurityPlanResult {
  exitCode: number;
  log: string[];
  errors: string[];
}

export interface ReadonlyRouteDeps {
  workspaceExists: (name: string) => boolean;
  stacks: (opts: { workspace: string | null; health: boolean }) => {
    workspace: string;
    stackWorkspace: string;
    stacks: StackStatus[];
  };
  edge: () => EdgeStatus;
  actions: () => AuditEntry[];
  securityPlan: (args: SecurityPlanArgs) => Promise<SecurityPlanResult>;
}

export const defaultReadonlyRouteDeps: ReadonlyRouteDeps = {
  workspaceExists: (name) => !!getWorkspaceByName(name),
  stacks: ({ workspace, health }) => {
    const ws = resolveStackWorkspaces(workspace);
    const ctx = loadStackContext(ws.denWorkspace);
    return {
      workspace: ws.denWorkspace,
      stackWorkspace: ws.stackWorkspace,
      stacks: stackStatuses(ctx, { health }),
    };
  },
  edge: () => edgeStatus(readEdgeConfig()),
  actions: recentActions,
  securityPlan: async ({ env, mode, service }) => {
    // The CLI's own entrypoint in --dry-run: the same discovery, mode
    // ceiling and owned-host check, with no token minted and nothing run.
    const { runSecurityCli, defaultEntrypointDeps } =
      await import("../../pillars/security/run.js");
    const log: string[] = [];
    const errors: string[] = [];
    const argv = [`--env=${env}`, `--mode=${mode}`, "--dry-run"];
    if (service) argv.push(`--service=${service}`);
    const exitCode = await runSecurityCli(argv, {
      ...defaultEntrypointDeps(),
      log: (m) => log.push(m),
      logError: (m) => errors.push(m),
    });
    return { exitCode, log, errors };
  },
};

const SAFE_NAME = /^[A-Za-z0-9._/-]{1,128}$/;

/**
 * The entries about one service or repo. An exec's detail starts with the
 * address ("shop/api up (local) [id]"); a sync names its repo ("· repo=shop").
 */
export function activityFor(
  entries: AuditEntry[],
  target: { address?: string; repo?: string },
): AuditEntry[] {
  // A repo-level entry ("core down (local)") is an attempt on the repo
  // without naming a service, as agents usually do: it shows for the repo
  // and for each of its services.
  const repoLevel = (e: AuditEntry, repo: string): boolean =>
    e.verb === "exec" && e.detail.startsWith(repo + " ");
  const matches = (e: AuditEntry): boolean => {
    if (target.address)
      return (
        (e.verb === "exec" && e.detail.startsWith(target.address + " ")) ||
        repoLevel(e, target.address.split("/")[0])
      );
    const repo = target.repo ?? "";
    if (e.verb === "exec")
      return e.detail.startsWith(repo + "/") || repoLevel(e, repo);
    if (e.verb === "sync") return e.detail.split(" ").includes(`repo=${repo}`);
    return false;
  };
  return entries.filter(matches).reverse();
}
const MODES = ["baseline", "api", "full", "all"];

/** Handles the routes above; false when `pathname` is not one of them. */
export async function handleReadonlyRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  url: URL,
  deps: ReadonlyRouteDeps = defaultReadonlyRouteDeps,
): Promise<boolean> {
  if (
    pathname !== "/api/stacks" &&
    pathname !== "/api/edge" &&
    pathname !== "/api/activity" &&
    pathname !== "/api/security/plan"
  )
    return false;
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" });
    res.end("read-only");
    return true;
  }

  if (pathname === "/api/stacks") {
    const workspace = url.searchParams.get("workspace") || null;
    if (workspace && !deps.workspaceExists(workspace)) {
      send400(res, `unknown workspace "${workspace}"`);
      return true;
    }
    try {
      sendJson(
        res,
        deps.stacks({
          workspace,
          health: url.searchParams.get("health") !== "0",
        }),
      );
    } catch (e) {
      sendJson(res, { error: (e as Error).message }, 500);
    }
    return true;
  }

  if (pathname === "/api/edge") {
    try {
      sendJson(res, { configured: true, ...deps.edge() });
    } catch (e) {
      // No edge configured is a state, not a server error.
      sendJson(res, { configured: false, error: (e as Error).message });
    }
    return true;
  }

  if (pathname === "/api/activity") {
    const address = url.searchParams.get("address") ?? undefined;
    const repo = url.searchParams.get("repo") ?? undefined;
    const name = address ?? repo;
    if (!name || !SAFE_NAME.test(name)) {
      send400(res, "address or repo is required");
      return true;
    }
    sendJson(res, { entries: activityFor(deps.actions(), { address, repo }) });
    return true;
  }

  // /api/security/plan
  const env = url.searchParams.get("env") ?? "";
  const mode = url.searchParams.get("mode") ?? "baseline";
  const service = url.searchParams.get("service") ?? undefined;
  if (!SAFE_NAME.test(env)) {
    send400(res, "env is required");
    return true;
  }
  if (!MODES.includes(mode)) {
    send400(res, `mode must be one of ${MODES.join(", ")}`);
    return true;
  }
  if (service !== undefined && !SAFE_NAME.test(service)) {
    send400(res, "invalid service");
    return true;
  }
  try {
    const plan = await deps.securityPlan({
      env,
      mode,
      ...(service ? { service } : {}),
    });
    sendJson(res, { ok: plan.exitCode === 0, ...plan });
  } catch (e) {
    sendJson(
      res,
      { ok: false, exitCode: 1, log: [], errors: [(e as Error).message] },
      500,
    );
  }
  return true;
}
