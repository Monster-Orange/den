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
 * error, done; plus `ready` once a detached start is up: its health check
 * passes (`checked: true`), or, with no health check, its launcher is still
 * running after a settle window (`checked: false`). A launcher that keeps
 * running in the foreground (a dev server) never sends `service-exited`, so
 * `ready` is how a caller knows the start worked.
 */
import type { ChildProcess } from "child_process";
import type { ResolvedService } from "../../shared/types/index.js";
import type {
  RunCommandOptions,
  RunCommandResult,
  ServiceSecretEnvResult,
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
  /**
   * R16: resolve the service's secret_env (prepareServiceSecretEnv). Unset,
   * nothing is resolved, and the runner refuses to start a service that
   * declares secret_env.
   */
  secretEnv?: (
    address: string,
    cmd: LifecycleExecCmd,
    workspace?: string,
  ) => Promise<ServiceSecretEnvResult>;
  /** Health poll interval after a detached start (default 1s). */
  pollMs?: number;
  /** Stop polling after this long (default 120s). */
  readyTimeoutMs?: number;
  /** With no health check: ready after this long still running (default 5s). */
  settleMs?: number;
  /**
   * Restart: a green check counts only after the check went red (the old
   * instance stopped) or this long has passed (default 5s).
   */
  restartMinMs?: number;
}

export interface LifecycleExecOptions {
  resolved: ResolvedService;
  cmd: LifecycleExecCmd;
  workspace?: string;
  env: NodeJS.ProcessEnv;
  emit: (e: Record<string, unknown>) => void;
  /** Called once, after the final `done` event. */
  end: () => void;
  /** Registers a callback for someone stopping the run (D55: Stop, never a closed stream). */
  onStop: (fn: () => void) => void;
  /**
   * D55: true while a page watches the run. With onUnwatched, a run whose
   * service has started (ready, or its launcher exited) lets go of its log
   * tail once nobody watches; before that it goes on to its end.
   */
  watched?: () => boolean;
  /** Registers a callback for the last page to stop watching. */
  onUnwatched?: (fn: () => void) => void;
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
  let clientGone = false; // stopped: nothing more is said
  let launched = false; // the service started: only its log tail is left
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
  let onServiceExitHook: (() => void) | undefined;
  o.onStop(() => {
    clientGone = true;
    try {
      proc?.kill();
    } catch {
      /* already exited */
    }
  });
  // Killing the tail never stops the service (the runner's contract); its
  // close ends the run with done.
  const letGo = (): void => {
    if (!launched || finished || clientGone || !o.watched || o.watched())
      return;
    try {
      proc?.kill();
    } catch {
      /* already exited */
    }
  };
  o.onUnwatched?.(letGo);

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

  // R16: all of the service's secret_env, or nothing starts. The message
  // names keys, refs and the provider, never a value.
  const secrets = deps.secretEnv
    ? await deps.secretEnv(resolved.address, cmd, o.workspace)
    : { ok: true as const, secretEnv: undefined };
  if (!secrets.ok) {
    if (!clientGone) emit({ type: "error", text: secrets.message });
    finish(1, true);
    return;
  }

  const result = deps.run({
    address: resolved.address,
    command: cmd,
    workspace: o.workspace,
    runtime: "daemon",
    env: o.env,
    secretEnv: secrets.secretEnv,
    onLine: (text) => {
      if (!clientGone) emit({ type: "line", text });
    },
    onClose: finish,
    onServiceExit: (exitCode) => {
      onServiceExitHook?.();
      if (clientGone) return;
      emit({
        type: "service-exited",
        exitCode,
        repoName: resolved.repoName,
        subsystem: resolved.subsystem,
      });
      launched = true;
      letGo();
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
    // The runner has already said where the log is.
    emit({ type: "started", detached: true });
    watchReady();
  }

  function watchReady(): void {
    const pollMs = deps.pollMs ?? 1000;
    const timeoutMs = deps.readyTimeoutMs ?? 120_000;
    const settleMs = deps.settleMs ?? 5000;
    const restartMinMs = deps.restartMinMs ?? 5000;
    const t0 = Date.now();
    let exited = false;
    let sawDown = false;
    const prevExit = onServiceExitHook;
    onServiceExitHook = () => {
      exited = true;
      prevExit?.();
    };
    const tick = async (): Promise<void> => {
      if (finished || clientGone || exited) return;
      const elapsed = Date.now() - t0;
      if (elapsed > timeoutMs) {
        // Never healthy in time: the health dot says so from here.
        launched = true;
        letGo();
        return;
      }
      const h = await deps.health(resolved).catch(() => null);
      if (finished || clientGone || exited) return;
      if (h?.health === "ok") {
        if (cmd !== "restart" || sawDown || elapsed >= restartMinMs) {
          emit({ type: "ready", checked: true });
          launched = true;
          letGo();
          return;
        }
      } else if (h?.health === "error") {
        sawDown = true;
      } else if (elapsed >= settleMs) {
        // No health check to wait for: still running after the settle window.
        emit({ type: "ready", checked: false });
        launched = true;
        letGo();
        return;
      }
      setTimeout(() => void tick(), pollMs);
    };
    setTimeout(() => void tick(), pollMs);
  }
}

/** What a collected run said: how it ended and the end of its output. */
export interface CollectedExec {
  ok: boolean;
  /** The command's exit code; null while a detached start still runs. */
  exitCode: number | null;
  /** Started and healthy (or, with no health check, still running). */
  ready: boolean;
  lines: string[];
  error?: string;
}

/**
 * Runs a lifecycle command as the route does, collecting its events
 * instead of streaming them (ON-3's service_try): done at `ready`, at the
 * launcher's exit (`service-exited`) or at `done`, whichever comes first,
 * as service_up's stream stops. Then it lets go, as a closed stream does:
 * a detached service keeps running; only the log tail stops.
 */
export function collectLifecycleExec(
  o: Omit<LifecycleExecOptions, "emit" | "end" | "onStop">,
  deps: LifecycleExecDeps,
  keep = 30,
): Promise<CollectedExec> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const errors: string[] = [];
    let closer: (() => void) | null = null;
    let settled = false;
    const settle = (r: Omit<CollectedExec, "lines" | "error">): void => {
      if (settled) return;
      settled = true;
      closer?.();
      resolve({
        ...r,
        lines: lines.slice(-keep),
        ...(errors.length ? { error: errors.join("\n") } : {}),
      });
    };
    void streamLifecycleExec(
      {
        ...o,
        emit: (e) => {
          if (e.type === "line" && typeof e.text === "string")
            lines.push(e.text);
          else if (e.type === "error" && typeof e.text === "string")
            errors.push(e.text);
          else if (e.type === "ready")
            settle({ ok: true, exitCode: null, ready: true });
          else if (e.type === "service-exited") {
            const code = Number(e.exitCode);
            settle({ ok: code === 0, exitCode: code, ready: false });
          } else if (e.type === "done") {
            const code = Number(e.exitCode);
            settle({ ok: code === 0, exitCode: code, ready: false });
          }
          if (lines.length > keep * 4) lines.splice(0, lines.length - keep);
        },
        end: () => undefined,
        onStop: (fn) => {
          closer = fn;
        },
      },
      deps,
    ).catch((e: unknown) => {
      errors.push(String((e as Error)?.message ?? e));
      settle({ ok: false, exitCode: 1, ready: false });
    });
  });
}
