/**
 * The PTY seam for den-pty (AG-3a, Q-AG-1).
 *
 * A real terminal needs a native module: @lydell/node-pty, an
 * optionalDependency at an exact version. Its binaries are prebuilt and
 * ship in per-platform packages npm installs alongside it (no install
 * script, nothing downloaded after install). When it is missing (an
 * `--omit=optional` install, an unsupported platform, a node_modules copied
 * across operating systems), loadPty says why instead of throwing, and
 * den-pty reports itself unavailable with that reason (`<cli> doctor`).
 *
 * The host only ever sees PtyFactory, so tests run a scripted or piped
 * stand-in and never need the module.
 */
import { createRequire } from "module";
import * as path from "path";
import { getEngineRoot } from "../paths.js";

export const PTY_MODULE = "@lydell/node-pty";

export interface PtySpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

/** What the host needs of a terminal. Data is bytes both ways. */
export interface PtyProcess {
  readonly pid: number;
  onData(fn: (data: Buffer) => void): void;
  onExit(fn: (e: PtyExit) => void): void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /** `signal` is a Node signal name ("SIGTERM"). */
  kill(signal: string): void;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: PtySpawnOptions,
) => PtyProcess;

export type PtyLoad =
  | { available: true; factory: PtyFactory }
  | { available: false; reason: string };

/** The subset of the module's API that is used. */
interface NativePty {
  pid: number;
  onData(fn: (d: string | Buffer) => void): unknown;
  onExit(fn: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(d: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface NativeModule {
  spawn(file: string, args: string[], opts: Record<string, unknown>): NativePty;
}

/** Resolve modules as Den's own package does (hoisted in a distribution). */
function engineRequire(id: string): unknown {
  return createRequire(path.join(getEngineRoot(), "package.json"))(id);
}

function wrap(mod: NativeModule): PtyFactory {
  return (file, args, opts) => {
    const p = mod.spawn(file, args, {
      name: opts.env.TERM || "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
      // Bytes, not strings: output is relayed as it came.
      encoding: null,
    });
    return {
      pid: p.pid,
      onData: (fn) =>
        void p.onData((d) => fn(Buffer.isBuffer(d) ? d : Buffer.from(d))),
      onExit: (fn) =>
        void p.onExit((e) => fn({ exitCode: e.exitCode, signal: e.signal })),
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      // The session leads its own process group: signal all of it, so a
      // shell's foreground job gets the INT too.
      kill: (signal) => {
        try {
          process.kill(-p.pid, signal as NodeJS.Signals);
        } catch {
          try {
            p.kill(signal);
          } catch {
            /* already gone */
          }
        }
      },
    };
  };
}

let memo: PtyLoad | null = null;

/**
 * The PTY module, or why it can't be used. `req` is for tests; the default
 * resolves from Den's package and is remembered.
 */
export function loadPty(req?: (id: string) => unknown): PtyLoad {
  if (!req && memo) return memo;
  let result: PtyLoad;
  try {
    const mod = (req ?? engineRequire)(PTY_MODULE) as Partial<NativeModule>;
    result =
      typeof mod?.spawn === "function"
        ? { available: true, factory: wrap(mod as NativeModule) }
        : {
            available: false,
            reason: `${PTY_MODULE} loaded but has no spawn(): not a PTY module Den knows`,
          };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const own =
      err.code === "MODULE_NOT_FOUND" &&
      String(err.message).includes(`'${PTY_MODULE}'`);
    result = {
      available: false,
      reason: own
        ? `${PTY_MODULE} is not installed (an optional dependency of Den; ` +
          `reinstall without --omit=optional, on a platform it ships binaries for)`
        : String(err.message).split("\n")[0].trim(),
    };
  }
  if (!req) memo = result;
  return result;
}
