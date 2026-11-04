/**
 * The MCP server's guards. Each one throws a Refusal (the tool then returns
 * an error naming the rule) before anything reaches the web API. They sit on
 * top of the web server's own checks, which still apply.
 */
import type { Environment } from "../../shared/types/index.js";
import type { ResolvedMcpConfig } from "../../shared/den-config.js";

/** A guard said no. The message says which rule and how to change it. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/** The only manifest commands an agent may run. */
export const LIFECYCLE_CMDS = ["up", "down", "restart"] as const;
export type LifecycleCmd = (typeof LIFECYCLE_CMDS)[number];

export function assertLifecycleCmd(cmd: string): asserts cmd is LifecycleCmd {
  if (!(LIFECYCLE_CMDS as readonly string[]).includes(cmd))
    throw new Refusal(
      `"${cmd}" is not a lifecycle command: agents may run only ${LIFECYCLE_CMDS.join(", ")}.`,
    );
}

/** Service lifecycle actions run on this machine only. */
export function assertLocalEnv(env: string): void {
  if (env !== "local")
    throw new Refusal(
      `service actions are local only (env "${env}" refused); nothing remote is ever started or stopped.`,
    );
}

/** The fields of an /api/services entry the guards read. */
export interface ServiceEntryLike {
  repo?: string;
  service?: string;
  commands: string[];
  mode?: string;
  /** R13: the manifest's `runs:` (not served yet). */
  runs?: { local?: boolean };
}

/**
 * Whether Den runs this service on this machine. Today: its manifest has a
 * local `up` command. R13 adds `runs.local` to the manifest; once /api/services
 * serves it, an explicit `runs.local: false` refuses here even with an `up`,
 * and `runs.local: true` is the signal to read instead of `up`.
 */
export function runsLocally(entry: ServiceEntryLike): boolean {
  if (entry.runs?.local === false) return false;
  return entry.commands.includes("up");
}

export function assertRunsLocally(entry: ServiceEntryLike): void {
  if (!runsLocally(entry))
    throw new Refusal(
      `${entry.repo ?? "?"}/${entry.service ?? "?"} is not run locally (its manifest has no local "up" command), so agents may not start, stop or restart it.`,
    );
}

const PRODUCTION: readonly string[] = ["production", "prod"];

/**
 * run_tests: production never; otherwise only the envs the org listed in
 * `mcp.run_tests.envs` (default [local]). Security `full` (active attacks) is
 * local only.
 */
export function assertRunTestsAllowed(
  args: { pillar: string; env: string; mode?: string },
  cfg: ResolvedMcpConfig,
): void {
  if (PRODUCTION.includes(args.env))
    throw new Refusal("run_tests never targets production.");
  if (!cfg.runTestsEnvs.includes(args.env as Environment))
    throw new Refusal(
      `env "${args.env}" is not in mcp.run_tests.envs (allowed: ${cfg.runTestsEnvs.join(", ")}).`,
    );
  if (
    args.pillar === "security" &&
    args.mode === "full" &&
    args.env !== "local"
  )
    throw new Refusal(
      `security mode "full" (active attacks) is local only (env "${args.env}" refused).`,
    );
}

/** The security CLI's dry-run verdict, from /api/security/plan. */
export interface SecurityPlanLike {
  ok: boolean;
  errors?: string[];
}

/** A security run must pass the CLI's own plan: owned hosts, mode ceiling. */
export function assertSecurityPlanOk(plan: SecurityPlanLike): void {
  if (!plan.ok)
    throw new Refusal(
      `the security plan refused this run: ${(plan.errors ?? []).join(" ") || "no reason given"}`,
    );
}

/** workspace_sync <repo>: the repo must be a managed clone in the workspace. */
export function assertSyncableRepo(
  repo: string,
  services: readonly ServiceEntryLike[],
): void {
  const entries = services.filter((s) => s.repo === repo);
  if (entries.length === 0)
    throw new Refusal(`no repo named "${repo}" in the workspace.`);
  if (!entries.some((s) => s.mode === "managed"))
    throw new Refusal(
      `${repo} is dev-managed (your own checkout): sync only updates managed clones, never a dev-managed one.`,
    );
}

/** Log tools read local sources unless the org set `mcp.logs.remote: true`. */
export function assertLogsEnv(env: string, cfg: ResolvedMcpConfig): void {
  if (env !== "local" && !cfg.logsRemote)
    throw new Refusal(
      `remote log sources (env "${env}") are off: set mcp.logs.remote: true to allow them.`,
    );
}
