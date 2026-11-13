/**
 * PTY stand-ins for the session host's factory seam, so no test needs the
 * native module:
 *
 *  - ScriptedPty: in memory. A test emits output and exits it by hand, and
 *    reads back what the host wrote, resized and signalled.
 *  - pipePtyFactory: runs the argv as a child with pipes (no terminal), for
 *    a host in its own process that must run a real command.
 */
import { spawn } from "child_process";
import type {
  PtyFactory,
  PtyProcess,
  PtySpawnOptions,
} from "../../../../src/shared/sessions/pty.js";

export class ScriptedPty implements PtyProcess {
  /**
   * #70: this test process. An agent's token counts only from its
   * session's processes, and a test that calls as the agent calls from
   * here: the scripted session's root. Nothing signals a session by its
   * pid (kill() below only records), so this process is never signalled.
   */
  readonly pid = process.pid;
  readonly writes: Buffer[] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly signals: string[] = [];
  private dataFns: Array<(d: Buffer) => void> = [];
  private exitFns: Array<(e: { exitCode: number; signal?: number }) => void> =
    [];

  constructor(
    readonly file: string,
    readonly args: string[],
    readonly opts: PtySpawnOptions,
  ) {}

  onData(fn: (d: Buffer) => void): void {
    this.dataFns.push(fn);
  }
  onExit(fn: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitFns.push(fn);
  }
  write(data: Buffer): void {
    this.writes.push(Buffer.from(data));
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(signal: string): void {
    this.signals.push(signal);
  }

  /** The program printed `text`. */
  emit(text: string | Buffer): void {
    const buf = Buffer.isBuffer(text) ? text : Buffer.from(text);
    for (const fn of this.dataFns) fn(buf);
  }
  /** The program exited. */
  exit(exitCode = 0, signal?: number): void {
    for (const fn of this.exitFns) fn({ exitCode, signal });
  }
}

/** A factory that records every ScriptedPty it makes. */
export function scriptedFactory(): {
  factory: PtyFactory;
  made: ScriptedPty[];
} {
  const made: ScriptedPty[] = [];
  return {
    made,
    factory: (file, args, opts) => {
      const p = new ScriptedPty(file, args, opts);
      made.push(p);
      return p;
    },
  };
}

/** Runs the argv with pipes: output is real, there is no terminal. */
export const pipePtyFactory: PtyFactory = (file, args, opts) => {
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const dataFns: Array<(d: Buffer) => void> = [];
  const exitFns: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  const relay = (d: Buffer) => {
    for (const fn of dataFns) fn(d);
  };
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);
  child.stdin.on("error", () => undefined);
  child.on("exit", (code, signal) => {
    const signo = signal ? 15 : undefined;
    for (const fn of exitFns) fn({ exitCode: code ?? 0, signal: signo });
  });
  return {
    pid: child.pid ?? -1,
    onData: (fn) => void dataFns.push(fn),
    onExit: (fn) => void exitFns.push(fn),
    write: (d) => void child.stdin.write(d),
    resize: () => undefined,
    kill: (signal) => {
      try {
        process.kill(-(child.pid ?? 0), signal as NodeJS.Signals);
      } catch {
        /* already gone */
      }
    },
  };
};
