/**
 * `/api/service/exec` for the lifecycle commands (up, down, restart): run
 * through the service runner, as the CLI does, instead of executing the
 * manifest's command string directly. That gives the web UI and MCP the CLI's
 * semantics:
 *
 *   - restart without a declared `restart` is down + up;
 *   - up on a service that is already healthy starts nothing ("already up");
 *   - up attaches to a running shared instance instead of starting a second;
 *   - down honours workspace ownership (refcounted).
 *
 * Events are the route's existing SSE shapes: line, started, service-exited,
 * error, done.
 */
import type { ChildProcess } from "child_process";
import type { ResolvedService } from "../../shared/types/index.js";
import type {
  RunCommandOptions,
  RunCommandResult,
} from "../../shared/environment-manager/service-runner.js";
import type { ServiceHealthResult } from "../../shared/environment-manager/health.js";

export const LIFECYCLE_EXEC_CMDS = ["up", "down", "restart"] as const;
export type LifecycleExecCmd = (typeof LIFECYCLE_EXEC_CMDS)[number];

export function isLifecycleExecCmd(c: string): c is LifecycleExecCmd {
  return (LIFECYCLE_EXEC_CMDS as readonly string[]).includes(c);
}

export interface LifecycleExecDeps {
  run: (o: RunCommandOptions) => RunCommandResult;
  health: (r: ResolvedService) => Promise<ServiceHealthResult>;
}

export interface LifecycleExecOptions {
  resolved: ResolvedService;
  cmd: LifecycleExecCmd;
  workspace?: string;
  env: NodeJS.ProcessEnv;
  emit: (e: Record<string, unknown>) => void;
  /** Called once, after the final `done` event. */
  end: () => void;
  /** Registers a callback for the client going away. */
  onClientClose: (fn: () => void) => void;
  /** Called with the exit code when the command completes. */
  onExit?: (exitCode: number, durationMs: number) => void;
}

export async function streamLifecycleExec(
  o: LifecycleExecOptions,
  deps: LifecycleExecDeps,
): Promise<void> {
  const { resolved, cmd, emit } = o;
  const start = Date.now();
  let finished = false;
  let clientGone = false;
  const finish = (exitCode: number, explained = false): void => {
    if (finished) return;
    finished = true;
    const duration = Date.now() - start;
    o.onExit?.(exitCode, duration);
    if (clientGone) return;
    if (exitCode !== 0 && !explained)
      emit({ type: "error", text: `Command failed (exit ${exitCode})` });
    emit({ type: "done", exitCode, duration });
    o.end();
  };

  let proc: ChildProcess | null = null;
  o.onClientClose(() => {
    clientGone = true;
    try {
      proc?.kill();
    } catch {
      /* already exited */
    }
  });

  // Up on a healthy service is a no-op: starting a second copy only fails on
  // its port (and an agent waits out the detach window to learn that).
  if (cmd === "up") {
    const h = await deps.health(resolved).catch(() => null);
    if (h?.health === "ok") {
      emit({
        type: "line",
        text: `${resolved.address} is already up (healthy) — nothing to start`,
      });
      finish(0);
      return;
    }
  }

  const result = deps.run({
    address: resolved.address,
    command: cmd,
    workspace: o.workspace,
    runtime: "daemon",
    env: o.env,
    onLine: (text) => {
      if (!clientGone) emit({ type: "line", text });
    },
    onClose: finish,
    onServiceExit: (exitCode) => {
      if (clientGone) return;
      emit({
        type: "service-exited",
        exitCode,
        repoName: resolved.repoName,
        subsystem: resolved.subsystem,
      });
    },
  });
  proc = result.proc;

  // Backstop: the route refuses an interactive command before calling this,
  // so the runner should never hand back a TTY-bound process here.
  if (result.interactive) {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
    emit({
      type: "error",
      text: `"${cmd}" requires an interactive terminal (HITL). Run it from your terminal.`,
    });
    finish(1, true);
    return;
  }
  if (result.detachable) {
    if (result.logPath)
      emit({ type: "line", text: `→ log: ${result.logPath}` });
    emit({ type: "started", detached: true });
  }
}
