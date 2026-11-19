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
import { createHash } from "crypto";
import * as fs from "fs";
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
  /**
   * Issue 503: close the master once the process has exited. Safe to call
   * more than once. Optional: a stand-in without a master has none.
   */
  close?(): void;
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
  /** The module's read stream over the master (unix; internal). */
  _socket?: { destroyed?: boolean; destroy(): void };
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
      // Issue 503: the module destroys its stream over the master at the
      // exit (or 200 ms after); this makes sure, and never signals (the pid
      // may be another process's by now).
      close: () => {
        const sock = p._socket;
        if (sock && !sock.destroyed)
          try {
            sock.destroy();
          } catch {
            /* gone */
          }
      },
    };
  };
}

/** A device number's major, as the platform packs it. */
function major(rdev: number, platform: NodeJS.Platform): number {
  if (platform === "darwin") return Math.floor(rdev / 2 ** 24) & 0xff;
  // Linux: glibc's gnu_dev_major.
  return (
    (Math.floor(rdev / 2 ** 8) & 0xfff) | (Math.floor(rdev / 2 ** 32) & ~0xfff)
  );
}

/**
 * Issue 503: how many PTY masters this process holds: its open fds that
 * are character devices with /dev/ptmx's major (on macOS each master has
 * its own minor; on Linux they share /dev/ptmx's). Read only, never a
 * close. null where it can't be told (no /dev/ptmx or /dev/fd).
 */
export function countPtyMasters(
  platform: NodeJS.Platform = process.platform,
): number | null {
  let want: number;
  let fds: string[];
  try {
    want = major(fs.statSync("/dev/ptmx").rdev, platform);
    fds = fs.readdirSync("/dev/fd");
  } catch {
    return null;
  }
  let n = 0;
  for (const f of fds) {
    const fd = Number(f);
    if (!Number.isInteger(fd)) continue;
    try {
      const st = fs.fstatSync(fd);
      if (st.isCharacterDevice() && major(st.rdev, platform) === want) n++;
    } catch {
      /* the listing's own fd, closed since */
    }
  }
  return n;
}

let memo: PtyLoad | null = null;

/**
 * Issue 563: the native module file a process loaded (or would load): its
 * path, the module's version, and the file's identity: a hash of its
 * contents. npm replaces a package by moving its folder aside and deleting
 * it, so the file at the same path may since be another one.
 */
export interface PtyModuleInfo {
  path: string;
  version: string | null;
  id: string | null;
}

/** The identity of `file`: "sha256:<hex>" of its contents, or null (gone). */
export function fileIdentity(file: string): string | null {
  try {
    return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
  } catch {
    return null;
  }
}

/**
 * Issue 563: the native module file of the PTY module installed under
 * `root` now (its platform package's pty.node, else its own build), or
 * null when it isn't installed. Read only.
 */
export function installedPtyModule(
  root: string = getEngineRoot(),
  platform: string = process.platform,
  arch: string = process.arch,
): PtyModuleInfo | null {
  let pkgFile: string;
  try {
    pkgFile = createRequire(path.join(root, "package.json")).resolve(
      `${PTY_MODULE}/package.json`,
    );
  } catch {
    return null;
  }
  let version: string | null = null;
  try {
    const v = (
      JSON.parse(fs.readFileSync(pkgFile, "utf-8")) as { version?: unknown }
    ).version;
    version = typeof v === "string" ? v : null;
  } catch {
    /* unreadable: no version */
  }
  const dir = path.dirname(pkgFile);
  const candidates: string[] = [];
  try {
    candidates.push(
      path.join(
        path.dirname(
          createRequire(pkgFile).resolve(
            `${PTY_MODULE}-${platform}-${arch}/package.json`,
          ),
        ),
        "pty.node",
      ),
    );
  } catch {
    /* no platform package: a build of its own */
  }
  candidates.push(path.join(dir, "build", "Release", "pty.node"));
  for (const c of candidates) {
    const id = fileIdentity(c);
    if (id) return { path: c, version, id };
  }
  return null;
}

/** What this process loaded, at the moment it loaded it (issue 563). */
let loaded: PtyModuleInfo | null = null;

/** Issue 563: the native module this process loaded, or null (none yet). */
export function loadedPtyModule(): PtyModuleInfo | null {
  return loaded;
}

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
  if (!req) {
    memo = result;
    if (result.available)
      try {
        loaded = installedPtyModule();
      } catch {
        /* not known: the host says none */
      }
  }
  return result;
}
