/**
 * The real-CLI sentinel (issue 163). Jest's global setup (global-setup.mjs)
 * makes a temp folder of stubs, one per name below, and puts it first on
 * the real PATH before any worker starts, so every worker, every spawn and
 * every server a test starts runs a stub instead of this machine's program.
 * A stub writes its name and argv (never stdin) to a log beside the folder
 * and exits 99. A test file whose worker logged a call fails (setup.ts),
 * and the run fails in global teardown if any call was logged at all.
 *
 * A test that needs a fake CLI runs it by full path, or puts its own fake
 * folder ahead of the sentinel (withSentinel keeps a temp folder first).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const SENTINEL_BINS = [
  "claude",
  "op",
  "doppler",
  "security",
  "launchctl",
  "sudo",
  "mkcert",
  "gh",
] as const;

/** The sentinel folder of this run, or null outside jest. */
export function sentinelDir(): string | null {
  return process.env.DEN_TEST_SENTINEL || null;
}

/** Every log a stub writes: one per JEST_WORKER_ID (0 when unset). */
function logs(): string[] {
  const dir = sentinelDir();
  if (!dir) return [];
  const base = path.dirname(dir);
  try {
    return fs
      .readdirSync(base)
      .filter((f) => /^sentinel-calls-[\w-]+\.log$/.test(f))
      .map((f) => path.join(base, f));
  } catch {
    return [];
  }
}

/** This worker's log. */
function ownLog(): string | null {
  const dir = sentinelDir();
  if (!dir) return null;
  return path.join(
    path.dirname(dir),
    `sentinel-calls-${process.env.JEST_WORKER_ID ?? "0"}.log`,
  );
}

const lines = (f: string): string[] => {
  try {
    return fs
      .readFileSync(f, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

/** Where each log of this worker's ends now: sentinelCalls(mark) reads past it. */
export type SentinelMark = Record<string, number>;

/**
 * Only this worker's own log: a call with no JEST_WORKER_ID (log 0) could be
 * any running file's, so global teardown alone reports it.
 */
const mine = (f: string) => f === ownLog();

export function sentinelMark(): SentinelMark {
  return Object.fromEntries(
    logs()
      .filter(mine)
      .map((f) => [f, lines(f).length]),
  );
}

/** The calls this worker made after `mark` (default: all of them). */
export function sentinelCalls(mark: SentinelMark = {}): string[] {
  return logs()
    .filter(mine)
    .flatMap((f) => lines(f).slice(mark[f] ?? 0));
}

/** Empties this worker's own log (a test that trips it on purpose). */
export function clearSentinel(): void {
  const own = ownLog();
  if (own && fs.existsSync(own)) fs.writeFileSync(own, "");
}

const TMP_ROOTS = [
  os.tmpdir(),
  fs.realpathSync(os.tmpdir()),
  "/tmp",
  "/private/tmp",
];
/** A folder a test made (fakes, stand-ins, the sentinel): under the temp dir. */
export const isTmpDir = (p: string): boolean =>
  TMP_ROOTS.some((t) => p === t || p.startsWith(`${t.replace(/\/$/, "")}/`));

/** The executable file `name` resolves to on these folders, running nothing. */
function resolveOn(name: string, dirs: string[]): string | null {
  for (const d of dirs) {
    const f = path.join(d, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** The sentinel's folder, or a sibling holding only `names`' stubs. */
function sentinelFor(dir: string, names: string[]): string {
  if (names.length === SENTINEL_BINS.length) return dir;
  const sub = `${dir}-${names.join("-")}`;
  if (!fs.existsSync(sub)) {
    fs.mkdirSync(sub, { recursive: true });
    for (const n of names)
      fs.copyFileSync(path.join(dir, n), path.join(sub, n));
  }
  return sub;
}

/**
 * `PATH` guarded by the sentinel: each guarded name it would resolve to
 * this machine's program (a file outside the temp dir) resolves to a stub
 * instead, placed after the test's own temp folders at its front (its fakes
 * win), before everything else. A name the PATH lacks stays missing, so a
 * test of "not installed" still sees that. Unchanged outside jest, when it
 * has a sentinel folder already, or when nothing on it needs one. No PATH
 * at all searches /usr/bin:/bin, so that is guarded too.
 */
export function withSentinel(PATH: string | undefined): string | undefined {
  const dir = sentinelDir();
  if (!dir) return PATH;
  const parts = (PATH ?? "/usr/bin:/bin").split(path.delimiter).filter(Boolean);
  if (parts.some((p) => p === dir || p.startsWith(`${dir}-`))) return PATH;
  const real = SENTINEL_BINS.filter((n) => {
    const f = resolveOn(n, parts);
    return f !== null && !isTmpDir(path.dirname(f));
  });
  if (!real.length) return PATH;
  let i = 0;
  while (i < parts.length && isTmpDir(parts[i]!)) i++;
  parts.splice(i, 0, sentinelFor(dir, [...real]));
  return parts.join(path.delimiter);
}

const GUARDED = Symbol.for("den.test.sentinelSpawnGuard");
type CP = typeof import("child_process");
const SPAWNERS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

/** `opts` with its env's PATH keeping the sentinel; others as they are. */
function guardOpts(a: unknown): unknown {
  if (!a || typeof a !== "object" || Array.isArray(a)) return a;
  const o = a as { env?: NodeJS.ProcessEnv };
  if (!o.env) return a; // inherits the real PATH, which has the sentinel
  const env: NodeJS.ProcessEnv = { ...o.env, PATH: withSentinel(o.env.PATH) };
  if (env.PATH === undefined) delete env.PATH;
  // A stub's call lands in this worker's log, so the file is named, even
  // when the env leaves JEST_WORKER_ID out.
  const worker = process.env.JEST_WORKER_ID;
  if (worker && !env.JEST_WORKER_ID) env.DEN_SENTINEL_WORKER ??= worker;
  // Den runs the system's sudo by absolute path (DEN_SYSTEM_SUDO, else
  // /usr/bin/sudo): an env that leaves it out keeps the sentinel's.
  if (process.env.DEN_SYSTEM_SUDO && !env.DEN_SYSTEM_SUDO)
    env.DEN_SYSTEM_SUDO = process.env.DEN_SYSTEM_SUDO;
  return { ...o, env };
}

/**
 * Every spawn this worker makes keeps the sentinel on its PATH, even one
 * whose `env` sets its own (`PATH: "/usr/bin:/bin"` would run this
 * machine's launchctl, security or sudo): the sentinel goes after the
 * spawn's own temp fake folders, ahead of everything else. Once per worker:
 * Node's child_process is one module for every test file in it.
 */
export function guardSpawns(cp: CP): void {
  if (!sentinelDir()) return;
  const mod = cp as unknown as Record<string | symbol, unknown>;
  if (mod[GUARDED]) return;
  mod[GUARDED] = true;
  for (const name of SPAWNERS) {
    const orig = mod[name] as (...a: unknown[]) => unknown;
    if (typeof orig !== "function") continue;
    const wrap = (f: (...a: unknown[]) => unknown) =>
      function (this: unknown, ...args: unknown[]) {
        return f.apply(
          this,
          args.map((a, i) => (i === 0 ? a : guardOpts(a))),
        );
      };
    const guarded = wrap(orig) as unknown as Record<symbol, unknown>;
    // exec's and execFile's promisified forms (util.promisify.custom) call
    // the original inside Node: guarded too.
    for (const k of Object.getOwnPropertySymbols(orig)) {
      const v = (orig as unknown as Record<symbol, unknown>)[k];
      guarded[k] =
        typeof v === "function" ? wrap(v as (...a: unknown[]) => unknown) : v;
    }
    mod[name] = guarded;
  }
}
