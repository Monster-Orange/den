/**
 * The web server's exit, bounded whatever happens.
 *
 * 1. **Lost output.** When the reader of the server's stdout or stderr goes
 *    away (the terminal, test runner or script that started it was killed),
 *    every write fails with EPIPE. Unhandled, that error reached the
 *    "continue" uncaughtException guard, which logged it with console.error
 *    to the equally dead stderr, which failed again: a tight loop that pinned
 *    a core and stopped the server answering requests, for as long as the
 *    orphan lived. Now the streams' errors are handled here, nothing is
 *    written once the output is gone, and the server shuts down (its launcher
 *    is gone; nobody can see it).
 * 2. **A deadline.** The first SIGTERM or SIGINT starts the shutdown; when
 *    nothing waits on the person (stdin isn't a TTY) a timer forces the exit
 *    after `DEN_SHUTDOWN_DEADLINE_MS` (10 s), whatever the shutdown is stuck
 *    on. A second signal exits at once (it was ignored, which left a stuck
 *    shutdown deaf to every later SIGTERM).
 */

const DEFAULT_DEADLINE_MS = 10_000;

let lost = false;
let started = false;

/** An error that says the stream's reader is gone. */
export function isLostOutputError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

/** True once stdout or stderr has lost its reader: write nothing more. */
export function outputLost(): boolean {
  return lost;
}

/**
 * Handle stdout's and stderr's errors (so none is ever uncaught); on the
 * first lost-output error, call `onLost` once.
 */
export function guardStdio(onLost: () => void): void {
  for (const s of [process.stdout, process.stderr]) {
    s.on("error", (e: unknown) => {
      if (!isLostOutputError(e) || lost) return;
      lost = true;
      onLost();
    });
  }
}

/** The deadline, from DEN_SHUTDOWN_DEADLINE_MS (ms, > 0), else 10 s. */
export function shutdownDeadlineMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const n = Number(env.DEN_SHUTDOWN_DEADLINE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEADLINE_MS;
}

function say(msg: string): void {
  if (lost) return;
  try {
    process.stderr.write(msg + "\n");
  } catch {
    /* nowhere left to say it */
  }
}

/**
 * Start the shutdown for `signal` (`run`), once. A later call exits at once;
 * a shutdown nobody waits on is forced to exit after the deadline.
 */
export function requestShutdown(
  signal: string,
  run: (signal: string) => void,
  opts: { interactive: boolean; deadlineMs?: number },
): void {
  if (started) {
    say(`[server] ${signal} again: exiting now.`);
    process.exit(1);
  }
  started = true;
  if (!opts.interactive) {
    const ms = opts.deadlineMs ?? shutdownDeadlineMs();
    setTimeout(() => {
      say(
        `[server] ${signal}: the shutdown did not finish within ${ms} ms; exiting.`,
      );
      process.exit(1);
    }, ms).unref();
  }
  run(signal);
}
