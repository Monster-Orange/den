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
 *   2. login-shell  the login shell's PATH (`$SHELL -lc`), resolved once
 *                   at server start, async, under a 3-second timeout; on
 *                   any failure it is left out (the current PATH remains).
 *   3. PATH         the caller's own PATH.
 *   4. well-known   the runtime's install directories (its `find.dirs`:
 *                   for den-claude ~/.local/bin, ~/.claude/local,
 *                   /opt/homebrew/bin, /usr/local/bin and npm's global
 *                   bin, derived from npm_config_prefix and node's own
 *                   directory, never by running npm).
 *   5. interactive-shell  only when a runtime is still missing: the
 *                   interactive login shell's PATH (`$SHELL -ilc`, where
 *                   some people set PATH in .zshrc/.bashrc), asked once per
 *                   process with stdin closed under the same 3-second
 *                   timeout, and kept (ensureInteractivePath).
 *
 * Sessions and agents Den starts get the same directories on their PATH
 * (sessionPath), so the runtime's own tools are found too.
 *
 * Two engine overrides, for tests and diagnosis (names only, never
 * secrets), read from the env given, else this process's: DEN_LOGIN_SHELL,
 * the shell to ask instead of $SHELL ("off": none), and DEN_RUNTIME_DIRS,
 * a PATH-style list that replaces every runtime's well-known directories
 * (empty: none).
 */
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

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
export const LOGIN_PATH_TIMEOUT_MS = 3000;

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

export interface Located {
  available: boolean;
  path?: string;
  source?: BinSource;
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

// ── the interactive shell's PATH (the fallback) ─────────────────────────────

let interactiveDirs: string[] | null = null;
let interactiveAsked: Promise<void> | null = null;

/**
 * Ask the interactive login shell (`$SHELL -ilc`) for its PATH, once per
 * process (stdin closed, the same timeout), and keep its directories as
 * the last place a runtime is looked for. Only for a runtime still missing
 * after the login PATH and the install directories; a second call waits
 * on (or returns) the first. Never throws.
 */
export function ensureInteractivePath(
  o: Omit<LoginPathOptions, "flags"> = {},
): Promise<void> {
  interactiveAsked ??= resolveLoginPath({ ...o, flags: "-ilc" }).then((p) => {
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
 * Where a runtime is looked for, in order: login shell, PATH, well-known,
 * then (once asked) the interactive shell's PATH.
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
  add(loginDirs ?? [], "login-shell");
  add(absoluteDirs(env.PATH ?? ""), "PATH");
  add(wellKnownDirs(find, env), "well-known");
  add(interactiveDirs ?? [], "interactive-shell");
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
 * Find runtime `id`'s CLI: the setting when there is one (refused with its
 * reason when bad), else the first of `find.bins` in searchDirs. Runs
 * nothing. `setting` is a value (global, as before) or a BinSetting.
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
      ? { available: true, path: c.path, source: set.source, searched: [] }
      : { available: false, why: c.why, source: set.source, searched: [] };
  }
  const dirs = searchDirs(find, env);
  for (const { dir, source } of dirs)
    for (const bin of find.bins) {
      const file = path.join(dir, bin);
      if (isExecutableFile(file))
        return {
          available: true,
          path: file,
          source,
          searched: dirs.map((d) => d.dir),
        };
    }
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

// ── the version ─────────────────────────────────────────────────────────────

const VERSION_TIMEOUT_MS = 3000;
const versions = new Map<string, Promise<string | undefined>>();

/** The first version-shaped token of a CLI's `--version` output. */
export function parseVersion(out: string): string | undefined {
  const m = /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(out);
  return m?.[1];
}

/**
 * Run `<bin> <versionArgs>` once (under a timeout; stdin closed, the env
 * as given) and keep the answer, per path and file identity, so a page
 * asking again runs nothing. Undefined when it fails or prints none.
 */
export function runtimeVersion(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = VERSION_TIMEOUT_MS,
): Promise<string | undefined> {
  let key: string;
  try {
    const st = fs.statSync(bin);
    key = `${bin}\0${st.ino}\0${st.size}\0${st.mtimeMs}\0${args.join(" ")}`;
  } catch {
    return Promise.resolve(undefined);
  }
  const known = versions.get(key);
  if (known) return known;
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
  versions.set(key, p);
  return p;
}

/**
 * Run `<bin> <args>` (stdin closed, under a timeout, never cached) and
 * return what it printed and whether it exited 0: to check a path someone
 * sets is the runtime it claims to be. Never throws.
 */
export function versionOutput(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = VERSION_TIMEOUT_MS,
): Promise<{ ok: boolean; out: string }> {
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
