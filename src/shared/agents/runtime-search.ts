/**
 * Where a runtime's CLI is found (AG-0.1): the way the person's terminal
 * would find it, not only on the server's own PATH. A web server run as a
 * launchd service gets a short PATH that leaves out `~/.local/bin`, where
 * Claude Code's native installer puts `claude`.
 *
 * The search, first match wins:
 *   0. workspace    `<ws>.agents.runtimes.<id>.bin` in
 *                   config/local/workspaces.yml (AG-0.5), for an agent of
 *                   that workspace;
 *   1. setting      `agents.runtimes.<id>.bin` in config/local/user.yml
 *                   (per machine, so never in the distribution's config):
 *                   an absolute path to an executable file; a bad one (at
 *                   either scope) is refused with its reason, never skipped.
 *   2. interactive-shell  issue 456, the first choice: the interactive
 *                   login shell's PATH (`$SHELL -ilc`, where many people
 *                   set PATH in .zshrc/.bashrc), the PATH their terminal
 *                   has. Asked once per process, stdin closed, under
 *                   agents.shell_path_timeout_seconds (10 s), and kept
 *                   (ensureInteractivePath); until it answers, or when it
 *                   fails, the fallbacks below decide.
 *   3. login-shell  the login shell's PATH (`$SHELL -lc`), resolved once
 *                   at server start, async, under the same timeout; on
 *                   any failure it is left out (the current PATH remains).
 *   4. PATH         the caller's own PATH.
 *   5. well-known   the runtime's install directories (its `find.dirs`:
 *                   for den-claude ~/.local/bin, ~/.claude/local,
 *                   /opt/homebrew/bin, /usr/local/bin and npm's global
 *                   bin, derived from npm_config_prefix and node's own
 *                   directory, never by running npm).
 *
 * Every other copy found is listed (`others`), with the version its
 * install's files say, never by running it. A copy macOS has quarantined
 * (com.apple.quarantine, read by isQuarantined without running the file)
 * is never run: no version command, no "Set path…" check. It is reported
 * "quarantined, not run", so a scan never makes macOS warn.
 *
 * Sessions and agents Den starts get the same directories on their PATH
 * (sessionPath), so the runtime's own tools are found too.
 *
 * Two engine overrides, for tests and diagnosis (names only, never
 * secrets), read from the env given, else this process's: DEN_LOGIN_SHELL,
 * the shell to ask instead of $SHELL ("off": none), and DEN_RUNTIME_DIRS,
 * a PATH-style list that replaces every runtime's well-known directories
 * (empty: none). And DEN_QUARANTINE_CHECK: "off", no file is read as
 * quarantined (tests set it).
 */
import { mark, timed } from "../probe-1833.js";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { statSettled } from "../stat-settled.js";

export type BinSource =
  | "workspace"
  | "setting"
  | "login-shell"
  | "well-known"
  | "PATH"
  | "interactive-shell";

/** The shell asked for the login PATH instead of $SHELL; "off" for none. */
export const LOGIN_SHELL_ENV = "DEN_LOGIN_SHELL";
/** A PATH-style list replacing every runtime's well-known directories. */
export const RUNTIME_DIRS_ENV = "DEN_RUNTIME_DIRS";
/** "off": the quarantine attribute is never read (tests). */
export const QUARANTINE_CHECK_ENV = "DEN_QUARANTINE_CHECK";
/**
 * How long a shell is given to say its PATH when the caller passes no
 * timeout: agents.shell_path_timeout_seconds's default (den-config.ts
 * SHELL_PATH_TIMEOUT), which callers read and pass (issue 456).
 */
export const LOGIN_PATH_TIMEOUT_MS = 10_000;

/** How a runtime's CLI is found and its version asked (catalog-shaped). */
export interface RuntimeFind {
  /** Executable names, in order ("claude"). */
  bins: readonly string[];
  /** Its well-known install directories, from HOME and the env. */
  dirs?: (home: string | undefined, env: NodeJS.ProcessEnv) => string[];
  /** The arguments that print its version ("--version"). */
  versionArgs?: readonly string[];
}

export interface SearchDir {
  dir: string;
  source: Exclude<BinSource, "setting" | "workspace">;
}

/** Another copy of a runtime the search found (issue 456): never run. */
export interface RuntimeCopy {
  path: string;
  source: SearchDir["source"];
  /** What its install's files say (a Homebrew keg's, npm's package.json). */
  version?: string;
  /** It carries com.apple.quarantine. */
  quarantined?: true;
}

export interface Located {
  available: boolean;
  path?: string;
  source?: BinSource;
  /** The chosen copy carries com.apple.quarantine: it is never run. */
  quarantined?: true;
  /** The other copies found, in search order (absent when none). */
  others?: RuntimeCopy[];
  /** Why it is unavailable. */
  why?: string;
  /** The directories searched, in order (none when a setting decided). */
  searched: string[];
}

/**
 * An engine override: the env given, else this process's (a test run sets
 * them once for every env it builds).
 */
function engineOverride(
  name: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return env[name] ?? process.env[name];
}

// ── the login shell's PATH ──────────────────────────────────────────────────

let loginDirs: string[] | null = null;

/** The login shell's PATH as resolved at start, or undefined. */
export function loginPath(): string | undefined {
  return loginDirs ? loginDirs.join(path.delimiter) : undefined;
}

/** Set (or, with undefined, forget) the resolved login PATH. */
export function setLoginPath(p: string | undefined): void {
  loginDirs = p ? absoluteDirs(p) : null;
}

const BEGIN = "__DEN_PATH_BEGIN__";
const END = "__DEN_PATH_END__";

export interface LoginPathOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** The shell's flags: "-lc" (a login shell), "-ilc" (interactive too). */
  flags?: "-lc" | "-ilc";
}

/**
 * Ask the login shell for its PATH: `<shell> -lc 'printf …"$PATH"…'`,
 * between markers so anything a startup file prints is ignored. Resolves
 * undefined on no shell, a timeout (the shell is killed), a non-absolute
 * shell, or nothing between the markers. Never throws, never blocks.
 */
export function resolveLoginPath(
  o: LoginPathOptions = {},
): Promise<string | undefined> {
  const env = o.env ?? process.env;
  const shell = (
    engineOverride(LOGIN_SHELL_ENV, env) ??
    env.SHELL ??
    ""
  ).trim();
  if (!shell || shell === "off" || !path.isAbsolute(shell))
    return Promise.resolve(undefined);
  const timeoutMs = o.timeoutMs ?? LOGIN_PATH_TIMEOUT_MS;
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        shell,
        [o.flags ?? "-lc", `printf '${BEGIN}%s${END}' "$PATH"`],
        {
          env,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      finish(undefined);
    }, timeoutMs);
    timer.unref?.();
    child.on("error", () => finish(undefined));
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf-8");
      if (out.length > 256 * 1024) out = out.slice(-128 * 1024);
      const m = new RegExp(`${BEGIN}([^]*?)${END}`).exec(out);
      if (m) {
        const dirs = absoluteDirs(m[1]);
        finish(dirs.length ? dirs.join(path.delimiter) : undefined);
      }
    });
    child.on("close", () => finish(undefined));
  });
}

/**
 * Resolve the login PATH once and keep it (the server's start, `agents
 * doctor`). Never throws; on failure the current PATH stays the search.
 */
export async function initLoginPath(o: LoginPathOptions = {}): Promise<void> {
  const p = await resolveLoginPath(o);
  if (p) setLoginPath(p);
}

// ── the interactive shell's PATH (the first choice) ─────────────────────────

let interactiveDirs: string[] | null = null;
let interactiveAsked: Promise<void> | null = null;

/**
 * Ask the interactive login shell (`$SHELL -ilc`) for its PATH, once per
 * process (stdin closed, the same timeout), and keep its directories as
 * the first place a runtime is looked for (issue 456): the PATH the
 * person's terminal has. A second call waits on (or returns) the first.
 * Never throws.
 */
export function ensureInteractivePath(
  o: Omit<LoginPathOptions, "flags"> = {},
): Promise<void> {
  interactiveAsked ??= timed(
    "login-shell PATH search",
    resolveLoginPath({ ...o, flags: "-ilc" }),
  ).then((p) => {
    if (p) interactiveDirs = absoluteDirs(p);
  });
  return interactiveAsked;
}

/** Whether the interactive shell was asked already (the answer is kept). */
export function interactivePathAsked(): boolean {
  return interactiveAsked !== null;
}

/** Forget the interactive shell's PATH and that it was asked (tests). */
export function resetInteractivePath(): void {
  interactiveDirs = null;
  interactiveAsked = null;
}

// ── the directories ─────────────────────────────────────────────────────────

/** A PATH-style list's absolute entries, in order, once each. */
function absoluteDirs(list: string): string[] {
  const out: string[] = [];
  for (const d of list.split(path.delimiter)) {
    const dir = d.trim();
    if (dir && path.isAbsolute(dir) && !out.includes(dir)) out.push(dir);
  }
  return out;
}

/**
 * npm's global bin, without running npm: `$npm_config_prefix/bin`, then
 * the directory of the node binary (npm's default global prefix puts its
 * bin there).
 */
export function npmGlobalBins(
  env: NodeJS.ProcessEnv,
  execPath: string = process.execPath,
): string[] {
  const out: string[] = [];
  const prefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX;
  if (prefix && path.isAbsolute(prefix)) out.push(path.join(prefix, "bin"));
  if (execPath && path.isAbsolute(execPath)) out.push(path.dirname(execPath));
  return out;
}

/** The common install directories: Homebrew's, /usr/local's, npm's. */
export function systemBinDirs(env: NodeJS.ProcessEnv): string[] {
  return ["/opt/homebrew/bin", "/usr/local/bin", ...npmGlobalBins(env)];
}

/** A runtime's well-known directories, or DEN_RUNTIME_DIRS when set. */
export function wellKnownDirs(
  find: RuntimeFind | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const override = engineOverride(RUNTIME_DIRS_ENV, env);
  if (override !== undefined) return absoluteDirs(override);
  const home = env.HOME && path.isAbsolute(env.HOME) ? env.HOME : undefined;
  return find?.dirs
    ? absoluteDirs(find.dirs(home, env).join(path.delimiter))
    : [];
}

/**
 * Where a runtime is looked for, in order: the interactive shell's PATH
 * (once asked), then the login shell's, PATH, well-known.
 */
export function searchDirs(
  find: RuntimeFind | undefined,
  env: NodeJS.ProcessEnv,
): SearchDir[] {
  const out: SearchDir[] = [];
  const add = (dirs: string[], source: SearchDir["source"]) => {
    for (const dir of dirs)
      if (!out.some((x) => x.dir === dir)) out.push({ dir, source });
  };
  add(interactiveDirs ?? [], "interactive-shell");
  add(loginDirs ?? [], "login-shell");
  add(absoluteDirs(env.PATH ?? ""), "PATH");
  add(wellKnownDirs(find, env), "well-known");
  return out;
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The setting's key for runtime `id`. */
export const binSettingKey = (id: string) => `agents.runtimes.${id}.bin`;

/**
 * A configured bin, checked: an absolute path to an executable file.
 * Returns its path, or why it is refused (naming the key, never guessing).
 */
export function checkBinSetting(
  id: string,
  value: unknown,
  key: string = binSettingKey(id),
): { path: string } | { why: string } {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { why?: unknown }).why === "string"
  )
    return { why: (value as { why: string }).why };
  if (typeof value !== "string" || !value.trim())
    return { why: `${key} must be an absolute path (got ${typeof value})` };
  const p = value.trim();
  const shown = p.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
  if (!path.isAbsolute(p))
    return { why: `${key}: "${shown}" is not an absolute path` };
  if (!fs.existsSync(p)) return { why: `${key}: ${shown} does not exist` };
  if (!isExecutableFile(p))
    return { why: `${key}: ${shown} is not an executable file` };
  return { path: p };
}

/** A path someone set: where (global or the workspace's) and its key. */
export interface BinSetting {
  value: unknown;
  source: "setting" | "workspace";
  /** The key it is under, for a refusal ("agents.runtimes.codex.bin"). */
  key?: string;
}

/**
 * Every copy of `find.bins` in `dirs`, in order, one per real file (a
 * Homebrew link and its keg are one copy). Runs nothing.
 */
export function findCopies(
  find: RuntimeFind,
  dirs: readonly SearchDir[],
): { path: string; source: SearchDir["source"] }[] {
  const out: { path: string; source: SearchDir["source"]; real: string }[] = [];
  for (const { dir, source } of dirs)
    for (const bin of find.bins) {
      const file = path.join(dir, bin);
      if (!isExecutableFile(file)) continue;
      const real = realOf(file);
      if (!out.some((c) => c.real === real))
        out.push({ path: file, source, real });
    }
  return out.map(({ path: p, source }) => ({ path: p, source }));
}

function realOf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/** The copies other than `chosen`, each with its install's version. */
function otherCopies(
  copies: readonly { path: string; source: SearchDir["source"] }[],
  chosen: string,
): RuntimeCopy[] {
  const real = realOf(chosen);
  return copies
    .filter((c) => c.path !== chosen && realOf(c.path) !== real)
    .map((c) => {
      const version = installVersion(c.path);
      return {
        path: c.path,
        source: c.source,
        ...(version ? { version } : {}),
        ...(isQuarantined(c.path) ? { quarantined: true as const } : {}),
      };
    });
}

/** The chosen copy's Located: its quarantine, and the others found. */
function chosenCopy(
  file: string,
  source: BinSource,
  copies: readonly { path: string; source: SearchDir["source"] }[],
  searched: string[],
): Located {
  const others = otherCopies(copies, file);
  return {
    available: true,
    path: file,
    source,
    ...(isQuarantined(file) ? { quarantined: true as const } : {}),
    ...(others.length ? { others } : {}),
    searched,
  };
}

/**
 * Find runtime `id`'s CLI: the setting when there is one (refused with its
 * reason when bad), else the first of `find.bins` in searchDirs; the other
 * copies the search finds are listed (issue 456). Runs none of them (the
 * quarantine attribute is read without running the file). `setting` is a
 * value (global, as before) or a BinSetting.
 */
export function locateRuntime(
  id: string,
  find: RuntimeFind,
  env: NodeJS.ProcessEnv,
  setting?: unknown,
): Located {
  const set: BinSetting | null =
    setting === undefined || setting === null
      ? null
      : isBinSetting(setting)
        ? setting
        : { value: setting, source: "setting" };
  if (set && set.value !== undefined && set.value !== null) {
    const c = checkBinSetting(id, set.value, set.key);
    return "path" in c
      ? chosenCopy(
          c.path,
          set.source,
          findCopies(find, searchDirs(find, env)),
          [],
        )
      : { available: false, why: c.why, source: set.source, searched: [] };
  }
  const dirs = searchDirs(find, env);
  const copies = findCopies(find, dirs);
  if (copies.length)
    return chosenCopy(
      copies[0].path,
      copies[0].source,
      copies,
      dirs.map((d) => d.dir),
    );
  return {
    available: false,
    why: `${find.bins.join(" or ")} not found (searched ${dirs.length} ${dirs.length === 1 ? "directory" : "directories"})`,
    searched: dirs.map((d) => d.dir),
  };
}

function isBinSetting(v: unknown): v is BinSetting {
  return (
    !!v &&
    typeof v === "object" &&
    "source" in v &&
    "value" in v &&
    ((v as BinSetting).source === "setting" ||
      (v as BinSetting).source === "workspace")
  );
}

/**
 * The PATH a session Den starts gets: the login shell's, the caller's,
 * then each runtime's well-known directories that exist, and `extra` (a
 * configured bin's directory). The caller's PATH is kept as it is when
 * nothing is added.
 */
export function sessionPath(
  env: NodeJS.ProcessEnv,
  finds: readonly (RuntimeFind | undefined)[],
  extra: readonly string[] = [],
): string | undefined {
  const own = env.PATH;
  const ownDirs = absoluteDirs(own ?? "");
  const before = (loginDirs ?? []).filter((d) => !ownDirs.includes(d));
  const after: string[] = [];
  const seen = new Set([...before, ...ownDirs]);
  const candidates = [
    ...finds.flatMap((f) => wellKnownDirs(f, env)),
    ...extra.filter((d) => path.isAbsolute(d)),
  ];
  for (const d of candidates) {
    if (seen.has(d)) continue;
    seen.add(d);
    try {
      if (fs.statSync(d).isDirectory()) after.push(d);
    } catch {
      /* not on this machine */
    }
  }
  if (!before.length && !after.length) return own;
  return [...before, ...(own ? [own] : []), ...after].join(path.delimiter);
}

// ── macOS quarantine (issue 456) ────────────────────────────────────────────

/** Whether a file carries com.apple.quarantine, read without running it. */
export type QuarantineReader = (file: string) => boolean;

export const QUARANTINE_ATTR = "com.apple.quarantine";

/**
 * The default reader: on macOS, `/usr/bin/xattr -p com.apple.quarantine
 * <file>` (xattr reads the attribute; the file itself is never run), under
 * a 2-second timeout. False elsewhere, under DEN_QUARANTINE_CHECK=off, or
 * when xattr can't answer.
 */
export const xattrQuarantineReader: QuarantineReader = (file) => {
  if (process.platform !== "darwin") return false;
  if (process.env[QUARANTINE_CHECK_ENV] === "off") return false;
  try {
    const r = spawnSync("/usr/bin/xattr", ["-p", QUARANTINE_ATTR, file], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 2000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
};

let quarantineReader: QuarantineReader | undefined;
const quarantineSeen = new Map<string, { q: boolean; readAt: number }>();

/** Replace (or, with undefined, restore) the quarantine reader (tests). */
export function setQuarantineReader(r: QuarantineReader | undefined): void {
  quarantineReader = r;
  quarantineSeen.clear();
}

/**
 * Whether `file` (its real file) carries com.apple.quarantine, asked once
 * per file identity: a change to its attributes changes its ctime, so it
 * is asked again. Kept only once the file's mtime is more than a clock
 * tick older than the ask (statSettled on its mtime; a
 * ctime can't be set back, and only macOS, on nanosecond APFS stamps,
 * sets the attribute).
 * Never runs the file; never throws.
 */
export function isQuarantined(file: string): boolean {
  let real: string;
  let key: string;
  let st: fs.Stats;
  try {
    real = fs.realpathSync(file);
    st = fs.statSync(real);
    key = `${real}\0${st.ino}\0${st.mtimeMs}\0${st.ctimeMs}`;
  } catch {
    return false;
  }
  const seen = quarantineSeen.get(key);
  if (seen !== undefined && statSettled({ mtimeMs: st.mtimeMs }, seen.readAt))
    return seen.q;
  const readAt = Date.now();
  let q = false;
  try {
    q = (quarantineReader ?? xattrQuarantineReader)(real) === true;
  } catch {
    q = false;
  }
  quarantineSeen.set(key, { q, readAt });
  return q;
}

const VERSION_DIR = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

/**
 * A copy's version from its install's files, never by running it: a
 * version-named file or directory among the last three parts of its real
 * path (Homebrew's Cellar/<name>/<version>/bin/<name>, a native install's
 * versions/<version>), else the nearest package.json's version (an npm
 * install). Only the last three, so a version further up (nvm's
 * versions/node/v24.x/…) is never taken for the CLI's. Undefined when
 * neither says.
 */
export function installVersion(file: string): string | undefined {
  const real = realOf(file);
  const parts = real.split(path.sep);
  for (let i = parts.length - 1; i >= Math.max(0, parts.length - 3); i--) {
    const m = VERSION_DIR.exec(parts[i]);
    if (m) return m[1];
  }
  for (let dir = path.dirname(real), i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf-8"),
      ) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not here */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

// ── the version ─────────────────────────────────────────────────────────────

const VERSION_TIMEOUT_MS = 3000;
const versions = new Map<
  string,
  { p: Promise<string | undefined>; readAt: number }
>();

/** The first version-shaped token of a CLI's `--version` output. */
export function parseVersion(out: string): string | undefined {
  const m = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(out);
  return m?.[1];
}

/**
 * Run `<bin> <versionArgs>` once (under a timeout; stdin closed, the env
 * as given) and keep the answer, per path and file identity, so a page
 * asking again runs nothing. Undefined when it fails or prints none, and
 * for a quarantined file, which is never run (issue 456).
 */
export function runtimeVersion(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = VERSION_TIMEOUT_MS,
): Promise<string | undefined> {
  if (isQuarantined(bin)) return Promise.resolve(undefined);
  let key: string;
  let st: fs.Stats;
  try {
    st = fs.statSync(bin);
    key = `${bin}\0${st.ino}\0${st.size}\0${st.mtimeMs}\0${args.join(" ")}`;
  } catch {
    return Promise.resolve(undefined);
  }
  // Kept only once the CLI was written more than a clock tick
  // before it was asked: one rewritten in place in that tick is asked again.
  const known = versions.get(key);
  if (known && statSettled({ mtimeMs: st.mtimeMs }, known.readAt)) {
    mark(`--version cached ${path.basename(bin)}`);
    return known.p;
  }
  const readAt = Date.now();
  const p = new Promise<string | undefined>((resolve) => {
    let out = "";
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...args], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      finish(undefined);
    }, timeoutMs);
    timer.unref?.();
    const take = (d: Buffer) => {
      if (out.length < 4096) out += d.toString("utf-8");
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => finish(undefined));
    child.on("close", (code) =>
      finish(code === 0 ? parseVersion(out) : undefined),
    );
  });
  versions.set(key, { p, readAt });
  void timed(`--version spawned ${path.basename(bin)}`, p);
  return p;
}

/**
 * Run `<bin> <args>` (stdin closed, under a timeout, never cached) and
 * return what it printed and whether it exited 0: to check a path someone
 * sets is the runtime it claims to be. A quarantined file is never run
 * (`quarantined: true`, issue 456). Never throws.
 */
export function versionOutput(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = VERSION_TIMEOUT_MS,
): Promise<{ ok: boolean; out: string; quarantined?: true }> {
  if (isQuarantined(bin))
    return Promise.resolve({ ok: false, out: "", quarantined: true });
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, out });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, out: "" });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    const take = (d: Buffer) => {
      if (out.length < 4096) out += d.toString("utf-8");
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/** Forget every version asked (tests). */
export function clearVersionCache(): void {
  versions.clear();
}
