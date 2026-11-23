/**
 * Issue 1356: no test writes a real install's config or state. tests/setup.ts
 * installs this on the real fs for every test file. It is an allow-list: a
 * write (it throws at the call, and the test file fails at its end too,
 * should the writer swallow the error) may reach only
 *
 *   - the temp folders (os.tmpdir(), /tmp, $TMPDIR, CI's $RUNNER_TEMP, and
 *     DEN_FAST_JEST_CACHE, the jest cache folder fast-checks names);
 *   - the checkout under test, except any config/local in it (coverage,
 *     fixtures);
 *   - /dev (/dev/null);
 *   - a root a suite names in WriteGuardRoots.allow.
 *
 * Everything else is refused: any other config/local (another checkout's,
 * reached through a linked node_modules), ~/.den and every install's state
 * folder wherever it lives (another volume, another OS user's home,
 * /Users/Shared), the install registry, /Library. Child processes aren't
 * covered: their own sandbox and env (DEN_HOME, …) are.
 */
import * as fs from "fs";
import fsModule from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

export interface WriteGuardRoots {
  /** The checkout under test (its config/local stays refused). */
  checkout: string;
  /** Folders every write may reach. */
  temp: string[];
  /** Other folders a suite needs, named one by one. */
  allow?: string[];
}

const GUARDED = Symbol.for("den.writeGuard");
const REFUSALS = Symbol.for("den.writeGuard.refusals");

/**
 * The refusals so far through `fsObj`'s wrappers (setup.ts fails each test
 * file on its own). The list lives on the fs module object itself, beside
 * the wrappers: the core module, and so they, outlive a test file, while
 * each test file gets its own globalThis and its own load of this module.
 */
export function guardedWrites(fsObj: typeof fs = fsModule): string[] {
  const m = fsObj as unknown as Record<symbol, string[] | undefined>;
  return (m[REFUSALS] ??= []);
}

/**
 * Installs the guard on the real fs and fails the test file, at its end,
 * on any refusal made during it (a writer that swallowed the error too).
 * tests/setup.ts calls it for every test file.
 */
export function armWriteGuard(
  afterAll: (fn: () => void) => void,
  roots: WriteGuardRoots = writeGuardRoots(),
): void {
  installWriteGuard(fsModule, roots);
  const before = guardedWrites().length;
  afterAll(() => {
    const refused = guardedWrites().splice(before);
    if (refused.length)
      throw new Error(
        [
          "This test file wrote outside its temp folders (issue 1356): set DEN_ROOT or DEN_HOME to a temp folder first, then import Den's modules dynamically.",
          ...[...new Set(refused)].map((p) => `  ${p}`),
        ].join("\n"),
      );
  });
}

/** A path's real form, for one that may not exist yet (its nearest folder). */
function realish(p: string): string {
  let dir = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return path.resolve(p);
      rest.push(path.basename(dir));
      dir = up;
    }
  }
}

const inside = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

function hasConfigLocal(p: string): boolean {
  const parts = p.split(path.sep);
  for (let i = 0; i + 1 < parts.length; i++)
    if (parts[i] === "config" && parts[i + 1] === "local") return true;
  return false;
}

/** Whether a write to `p` is refused. */
export function refusedWrite(p: string, roots: WriteGuardRoots): boolean {
  const real = realish(p);
  if (roots.temp.some((t) => inside(real, t))) return false;
  if (inside(real, "/dev")) return false;
  if ((roots.allow ?? []).some((a) => inside(real, realish(a)))) return false;
  if (hasConfigLocal(real)) return true;
  return !inside(real, roots.checkout);
}

/** This run's roots: the checkout and the temp folders. */
export function writeGuardRoots(
  env: NodeJS.ProcessEnv = process.env,
): WriteGuardRoots {
  const r = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const home = r(os.homedir());
  const temp = [
    os.tmpdir(),
    "/tmp",
    env.TMPDIR ?? "",
    // Named roots only: CI's own temp folder (a GitHub runner's
    // $RUNNER_TEMP is not os.tmpdir()), and the jest cache folder
    // scripts/fast-checks.mjs passes as --cacheDirectory. Jest's own cache
    // and report writes share the guarded fs.
    env.RUNNER_TEMP ?? "",
    env.DEN_FAST_JEST_CACHE ?? "",
  ]
    .map((p) => p.trim())
    .filter(Boolean)
    .map(r)
    // A root set too wide (/, the home, a folder above it) would turn the
    // guard off: dropped.
    .filter((t) => t !== path.parse(t).root && !inside(home, t));
  return {
    // tests/ sits in the checkout (never in node_modules, which may be a
    // link into another checkout).
    checkout: r(
      typeof __dirname === "string"
        ? path.resolve(__dirname, "..")
        : process.cwd(),
    ),
    temp: [...new Set(temp)],
  };
}

function message(p: string, op: string): string {
  return [
    `This test wrote outside its temp folders: ${p} (fs.${op}).`,
    "A test never writes a real install's config/local or state folder (issue 1356).",
    "Usually Den's config or state module resolved its root before the test set it: a static import, direct or through another module, loaded it first.",
    "Set DEN_ROOT (or DEN_HOME) first, then import the module dynamically (see tests/unit/user-config-atomic.test.ts), or write under os.tmpdir().",
  ].join(" ");
}

type Fn = (...a: unknown[]) => unknown;

/** Which arguments of each writer are paths it writes. */
const SYNC: Record<string, number[]> = {
  writeFileSync: [0],
  appendFileSync: [0],
  mkdirSync: [0],
  mkdtempSync: [0],
  rmSync: [0],
  rmdirSync: [0],
  unlinkSync: [0],
  renameSync: [0, 1],
  copyFileSync: [1],
  cpSync: [1],
  symlinkSync: [1],
  linkSync: [1],
  truncateSync: [0],
  chmodSync: [0],
  utimesSync: [0],
  createWriteStream: [0],
};
const CALLBACK: Record<string, number[]> = {
  writeFile: [0],
  appendFile: [0],
  mkdir: [0],
  mkdtemp: [0],
  rm: [0],
  rmdir: [0],
  unlink: [0],
  rename: [0, 1],
  copyFile: [1],
  cp: [1],
  symlink: [1],
  link: [1],
  truncate: [0],
  chmod: [0],
  utimes: [0],
};
const PROMISES: Record<string, number[]> = { ...CALLBACK };

const WRITE_FLAGS =
  fs.constants.O_WRONLY |
  fs.constants.O_RDWR |
  fs.constants.O_CREAT |
  fs.constants.O_APPEND |
  fs.constants.O_TRUNC;
const writesFlags = (f: unknown) =>
  typeof f === "number"
    ? (f & WRITE_FLAGS) !== 0
    : /[wa+]/.test(String(f ?? "r"));

function pathOf(a: unknown): string | null {
  if (typeof a === "string") return a;
  if (Buffer.isBuffer(a)) return a.toString();
  if (a instanceof URL && a.protocol === "file:") return fileURLToPath(a);
  return null;
}

/**
 * Wraps `fsObj`'s writers so a refused path throws (or rejects, or calls
 * back with the error). Once per object.
 */
export function installWriteGuard(
  fsObj: typeof fs,
  roots: WriteGuardRoots,
  onRefused: (p: string) => void = (p) => void guardedWrites(fsObj).push(p),
): void {
  const mod = fsObj as unknown as Record<string | symbol, unknown>;
  if (mod[GUARDED]) return;
  mod[GUARDED] = true;
  const check = (op: string, args: unknown[], idx: number[]) => {
    for (const i of idx) {
      const p = pathOf(args[i]);
      if (p !== null && refusedWrite(p, roots)) {
        const abs = path.resolve(p);
        onRefused(abs);
        return new Error(message(abs, op));
      }
    }
    return null;
  };
  const wrap = (
    target: Record<string, unknown>,
    name: string,
    idx: number[],
    kind: "sync" | "callback" | "promise",
  ) => {
    const orig = target[name] as Fn | undefined;
    if (typeof orig !== "function") return;
    const guarded = function (this: unknown, ...args: unknown[]) {
      const err = check(name, args, idx);
      if (err) {
        if (kind === "promise") return Promise.reject(err);
        const cb = args[args.length - 1];
        if (kind === "callback" && typeof cb === "function") {
          process.nextTick(() => (cb as Fn)(err));
          return undefined;
        }
        throw err;
      }
      return orig.apply(this, args);
    };
    // fs.promisify's custom forms (fs.exists has one) stay with the original.
    for (const k of Object.getOwnPropertySymbols(orig))
      (guarded as unknown as Record<symbol, unknown>)[k] = (
        orig as unknown as Record<symbol, unknown>
      )[k];
    target[name] = guarded;
  };
  const f = fsObj as unknown as Record<string, unknown>;
  for (const [n, idx] of Object.entries(SYNC)) wrap(f, n, idx, "sync");
  for (const [n, idx] of Object.entries(CALLBACK)) wrap(f, n, idx, "callback");
  // open / openSync: only when the flags write.
  for (const [n, kind] of [
    ["openSync", "sync"],
    ["open", "callback"],
  ] as const) {
    const orig = f[n] as Fn | undefined;
    if (typeof orig !== "function") continue;
    f[n] = function (this: unknown, ...args: unknown[]) {
      const err = writesFlags(args[1]) ? check(n, args, [0]) : null;
      if (err) {
        const cb = args[args.length - 1];
        if (kind === "callback" && typeof cb === "function") {
          process.nextTick(() => (cb as Fn)(err));
          return undefined;
        }
        throw err;
      }
      return orig.apply(this, args);
    };
  }
  const p = fsObj.promises as unknown as Record<string, unknown> | undefined;
  if (p) {
    for (const [n, idx] of Object.entries(PROMISES)) wrap(p, n, idx, "promise");
    const open = p.open as Fn | undefined;
    if (typeof open === "function")
      p.open = function (this: unknown, ...args: unknown[]) {
        const err = writesFlags(args[1])
          ? check("promises.open", args, [0])
          : null;
        return err ? Promise.reject(err) : open.apply(this, args);
      };
  }
}
