/**
 * Shared streaming process spawner
 *
 * Extracted from src/ui/cli/test-runner.ts so both the CLI test runner
 * and the environment manager can spawn processes without importing from
 * the UI layer.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { rotateIfOversized } from "./log-rotation.js";
import { getStateDir } from "../paths.js";

import { product } from "../product.js";
// ── Log path ──────────────────────────────────────────────────────────────────

/**
 * Canonical path for a service's daemon log file.
 * ~/.den/logs/<repoName>/<subsystem>.log
 */
export function getServiceLogPath(repoName: string, subsystem: string): string {
  const dir = path.join(getServiceLogRoot(), repoName);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${subsystem}.log`);
}

/** Root of the per-service log tree: `~/.den/logs/<repo>/<service>.log`. */
export function getServiceLogRoot(): string {
  return path.join(getStateDir(), "logs");
}

// ── ANSI strip ────────────────────────────────────────────────────────────────

function stripAnsi(data: Buffer, onLine: (line: string) => void): void {
  // eslint-disable-next-line no-control-regex
  const text = data.toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  for (const line of text.split("\n")) {
    const visible = line.split("\r").filter(Boolean).pop() ?? "";
    if (visible.trim()) onLine(visible);
  }
}

// ── Daemon spawner ────────────────────────────────────────────────────────────

/**
 * Spawn a long-running service as a true daemon, fully decoupled from den's
 * process space.
 *
 * Why this matters
 * ────────────────
 * `spawnStreaming` with `stdio: pipe` keeps a file-descriptor link between
 * den and the service. When den exits (or the SSE response closes and
 * Node GC's the stream), the pipe read-end closes → the child gets SIGPIPE on
 * its next write → it dies. `proc.unref()` only removes the process from
 * Node's event-loop ref-count; it does NOT sever the FD connection.
 *
 * This function fixes that by:
 *   1. Writing a start-marker to `logPath` then opening it with `O_APPEND`.
 *   2. Spawning the service with `stdio: ['ignore', logFd, logFd]` — no pipe,
 *      no connection to den's FD table.
 *   3. Immediately closing the parent's copy of the log fd.
 *   4. Starting a `tail -F` subprocess to stream output back to the caller.
 *
 * The returned process is the `tail` subprocess — kill it when you want to
 * stop streaming without stopping the service.  `onClose` fires when tail
 * exits (i.e. when the caller kills it or the SSE detach window expires).
 */
export function spawnDaemon(
  command: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
  onLine: (line: string) => void,
  onClose: (exitCode: number) => void,
  cwd?: string,
  onServiceExit?: (exitCode: number) => void,
  onSpawn?: (pid: number) => void,
): ReturnType<typeof spawn> {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  // Cap the log before the next run appends to it. Cheap (one statSync) and it
  // covers restart-heavy services; the periodic sweep in the server catches
  // long-lived ones that never respawn.
  rotateIfOversized(logPath);

  // Stamp the log so the tail starts reading from a clean boundary.
  const ts = new Date().toISOString();
  fs.appendFileSync(logPath, `\n\n─── ${product().cli} start ${ts} ───\n`);
  // Where this run's output starts. The tail reads from here, not from "the
  // end when tail opened": a fast command (a refused sudo, a typo) can write
  // and exit before tail starts, and `-n 0` would drop those lines.
  const startOffset = fs.statSync(logPath).size;

  // Open the log fd in the parent so we can hand it to the child.
  // MUST stay "a" (O_APPEND): rotation truncates this file in place, and only
  // O_APPEND recomputes the offset to EOF on every write. With plain O_WRONLY
  // the child would keep its old offset and write a multi-GB sparse hole of
  // NULs. See log-rotation.ts.
  const logFd = fs.openSync(logPath, "a");

  const svcProc = spawn(command, [], {
    env,
    cwd,
    shell: true,
    detached: true, // own process group → immune to Ctrl+C on den
    stdio: ["ignore", logFd, logFd], // NO pipe to the CLI — survives its shutdown
  });
  // Notify caller when the service process itself exits (e.g. `make up` finishes
  // after starting Docker containers).  The service may still be "running" even
  // after this fires — the process just handed off to the container runtime.
  if (onServiceExit) {
    svcProc.on("exit", (code) => onServiceExit(code ?? 0));
  }
  // Without an 'error' listener a spawn failure (e.g. cwd missing, ENOENT)
  // emits an unhandled 'error' that crashes den. Surface it instead.
  svcProc.on("error", (err) => {
    onLine(`Error: ${err.message}`);
    onServiceExit?.(1);
  });
  // The service leads its own process group (detached), so its pid is the
  // group id `down` signals later.
  if (onSpawn && svcProc.pid) onSpawn(svcProc.pid);
  svcProc.unref(); // den's event loop can exit independently
  fs.closeSync(logFd); // parent closes its copy; child keeps its own fd

  // Tail the log for streaming back to the caller.
  // -F follows by name (handles log rotation). -c +N starts at this run's
  // first byte (just after the stamp), so nothing the service wrote before
  // tail opened the file is lost.
  const tailProc = spawn("tail", ["-F", "-c", `+${startOffset + 1}`, logPath], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  tailProc.stdout?.on("data", (data: Buffer) => stripAnsi(data, onLine));
  tailProc.on("close", () => onClose(0));
  tailProc.on("error", () => onClose(0));

  return tailProc;
}

// ── Streaming spawner ─────────────────────────────────────────────────────────

/**
 * Spawn a process and stream stdout/stderr line-by-line via callbacks.
 * ANSI colour codes are stripped so browser/terminal output renders cleanly.
 *
 * When `detached` is true AND `logPath` is provided the process is spawned as
 * a true daemon (see `spawnDaemon`).  The returned proc is then the `tail`
 * subprocess used for streaming — kill it to stop streaming without stopping
 * the service.
 *
 * @param command  Executable name or shell string (when args is empty, shell mode is used)
 * @param args     Argument array — pass [] to invoke command as a raw shell string
 * @param env      Process environment
 * @param onLine   Called for each non-empty output line
 * @param onClose  Called with exit code when the process terminates
 * @param cwd      Working directory (defaults to process.cwd())
 * @param detached Put the child in its own process group (default false)
 * @param logPath  If provided together with detached=true, run as a daemon writing to this path
 * @param onSpawn  Daemon mode: called with the service's pid (its process group id) once spawned
 */
export function spawnStreaming(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string) => void,
  onClose: (exitCode: number) => void,
  cwd?: string,
  detached?: boolean,
  logPath?: string,
  onServiceExit?: (exitCode: number) => void,
  onSpawn?: (pid: number) => void,
): ReturnType<typeof spawn> {
  // Daemon mode: service runs independently from den — survives restarts.
  if (detached && logPath) {
    return spawnDaemon(
      command,
      env,
      logPath,
      onLine,
      onClose,
      cwd,
      onServiceExit,
      onSpawn,
    );
  }

  // Standard mode: pipe stdout/stderr for streaming, optionally detached.
  const proc = spawn(command, args, {
    env,
    cwd,
    shell: args.length === 0, // shell mode when command is a raw string (service commands)
    detached: detached ?? false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (data: Buffer) => stripAnsi(data, onLine));
  proc.stderr?.on("data", (data: Buffer) => stripAnsi(data, onLine));

  proc.on("close", (code) => onClose(code ?? 1));
  proc.on("error", (err) => {
    onLine(`Error: ${err.message}`);
    onClose(1);
  });

  if (detached) proc.unref();

  return proc;
}

// ── Interactive spawner ───────────────────────────────────────────────────────

/**
 * Spawn a process with full TTY access — stdin, stdout, and stderr are all
 * inherited from the parent process. Use this for interactive commands that
 * require human input (HITL), such as auth logins, license prompts, etc.
 *
 * No output streaming is performed — the user sees and interacts with the
 * process directly in their terminal.
 */
export function spawnInteractive(
  command: string,
  env: NodeJS.ProcessEnv,
  onClose: (exitCode: number) => void,
  cwd?: string,
): ReturnType<typeof spawn> {
  const proc = spawn(command, [], {
    env,
    cwd,
    shell: true,
    stdio: "inherit",
  });

  proc.on("close", (code) => onClose(code ?? 1));
  proc.on("error", (err) => {
    void err;
    onClose(1);
  });

  return proc;
}
