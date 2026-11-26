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
 *   - Playwright's browser folder, where its launch writes a lock;
 *   - a folder a suite names (allowWrites), for that test file only.
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
const ROOTS = Symbol.for("den.writeGuard.roots");
const PROTECTED = Symbol.for("den.writeGuard.protected");

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
  fsObj: typeof fs = fsModule,
): void {
  installWriteGuard(fsObj, roots);
  const before = guardedWrites(fsObj).length;
  // A folder the last test file named (allowWrites) was its own: this one
  // starts without it. Not at that file's end: its own afterAll may still
  // clean the folder up after this check's.
  const live = rootsOf(fsObj);
  if (live?.allow) live.allow.length = 0;
  afterAll(() => {
    const refused = guardedWrites(fsObj).splice(before);
    if (refused.length)
      throw new Error(
        [
          "This test file wrote outside its temp folders (issue 1356): set DEN_ROOT or DEN_HOME to a temp folder first, then import Den's modules dynamically.",
          ...[...new Set(refused)].map((p) => `  ${p}`),
        ].join("\n"),
      );
  });
}

const rootsOf = (fsObj: typeof fs): WriteGuardRoots | undefined =>
  (fsObj as unknown as Record<symbol, WriteGuardRoots | undefined>)[ROOTS];

/**
 * A suite names a folder it must write outside the temp folders (Docker
 * Desktop and OrbStack share only the home folder with their VM; a probe's
 * screenshot folder). Until the next test file starts; never /, the home itself or
 * a folder above it.
 */
export function allowWrites(
  dir: string,
  fsObj: typeof fs = fsModule,
  protectedDirs: readonly string[] = realStateDirs(),
): void {
  const roots = rootsOf(fsObj);
  if (!roots) return;
  const real = realish(dir);
  const home = realish(os.homedir());
  if (real === path.parse(real).root || inside(home, real))
    throw new Error(`allowWrites: ${real} is too wide to allow`);
  if (hasConfigLocal(real))
    throw new Error(`allowWrites: ${real} is in a config/local`);
  for (const p of protectedDirs.map(realish))
    if (inside(real, p) || inside(p, real))
      throw new Error(
        `allowWrites: ${real} overlaps a real state folder (${p})`,
      );
  (roots.allow ??= []).push(real);
}

/**
 * The state folders of a real install, as the run found them before any
 * test changed the env (read once per worker, kept on the fs module):
 * ~/.den, DEN_HOME, DEN_STATE_DIR, and the install registry's folder.
 */
function realStateDirs(): string[] {
  const m = fsModule as unknown as Record<symbol, string[] | undefined>;
  if (m[PROTECTED]) return m[PROTECTED];
  const env = process.env;
  const home = os.homedir();
  const registry =
    env.DEN_INSTALLS_DIR?.trim() ||
    (process.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "den", "installs")
      : path.join(
          env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state"),
          "den",
          "installs",
        ));
  return (m[PROTECTED] = [
    path.join(home, ".den"),
    env.DEN_HOME?.trim() ?? "",
    env.DEN_STATE_DIR?.trim() ?? "",
    registry,
  ].filter(Boolean));
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

/**
 * The ops that act on a link itself, never on what it points to: removing,
 * moving or making a link, and lchown/lutimes. Their path is judged as the
 * link's own (its folder resolved, its last name kept); every other op
 * follows the link to where the write lands.
 */
const LINK_OPS = new Set([
  "rmSync",
  "rmdirSync",
  "unlinkSync",
  "renameSync",
  "symlinkSync",
  "linkSync",
  "lchownSync",
  "lutimesSync",
  "rm",
  "rmdir",
  "unlink",
  "rename",
  "symlink",
  "link",
  "lchown",
  "lutimes",
]);

/** A link's own real path: its folder's real form, its last name kept. */
function realLink(p: string): string {
  const abs = path.resolve(p);
  return path.join(realish(path.dirname(abs)), path.basename(abs));
}

/**
 * Whether a write to `p` is refused. `op` is the fs function's name: one
 * of LINK_OPS judges the link's own path, any other (or none) follows it.
 */
export function refusedWrite(
  p: string,
  roots: WriteGuardRoots,
  op?: string,
): boolean {
  const real = op && LINK_OPS.has(op) ? realLink(p) : realish(p);
  if (roots.temp.some((t) => inside(real, t))) return false;
  if (inside(real, "/dev")) return false;
  // Before any named root: no root a suite names covers a config/local.
  if (hasConfigLocal(real)) return true;
  if ((roots.allow ?? []).some((a) => inside(real, realish(a)))) return false;
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
    // Playwright's own browser folder: its launch writes a lock there.
    playwrightBrowsers(env),
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

/** An entry inside `checkout` when its node_modules links elsewhere (a worker's own entry is there); else null. */
export function linkedModulesEntry(checkout: string): string | null {
  let nm: string;
  try {
    nm = fs.realpathSync(path.join(checkout, "node_modules"));
  } catch {
    return null;
  }
  return inside(nm, fs.realpathSync(checkout))
    ? null
    : path.join(checkout, "tests", "setup.ts");
}

/** Where Playwright keeps its browsers (its registry's own rule). */
function playwrightBrowsers(env: NodeJS.ProcessEnv): string {
  const set = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (set && set !== "0") return set;
  const home = os.homedir();
  if (process.platform === "darwin")
    return path.join(home, "Library", "Caches", "ms-playwright");
  if (process.platform === "win32")
    return path.join(
      env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "ms-playwright",
    );
  return path.join(
    env.XDG_CACHE_HOME?.trim() || path.join(home, ".cache"),
    "ms-playwright",
  );
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
  lchownSync: [0],
  lutimesSync: [0],
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
  lchown: [0],
  lutimes: [0],
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
  // The live roots: allowWrites adds to them for one test file.
  mod[ROOTS] = roots;
  const check = (op: string, args: unknown[], idx: number[]) => {
    for (const i of idx) {
      const p = pathOf(args[i]);
      if (p !== null && refusedWrite(p, roots, op)) {
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

// Read the real install's state folders now, at load: setup.ts imports this
// before its body points DEN_HOME and DEN_INSTALLS_DIR at test folders.
realStateDirs();
