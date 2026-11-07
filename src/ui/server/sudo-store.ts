/**
 * Sudo password store.
 *
 * Keeps the user's sudo password in memory so spawned service commands
 * (make up / down / etc.) can authenticate without a terminal.
 *
 * LK-0 (Ward, 2026-11-06): the password is for sudo, and nothing else. It
 * is never an access check. Den asks for it only at the moment a command
 * it runs is about to run sudo: every service command gets a `sudo` shim
 * first on its PATH (getSudoEnv). With a password held, the shim feeds it
 * to the real sudo. Without one, sudo that needs no password (NOPASSWD, a
 * warm cache) still runs; anything else never prompts, it prints one
 * needs-sudo line naming the command and fails. The route turns that line
 * (or sudo's own "a password is required") into a `needs-sudo` event
 * (watchSudo), and the page asks for the password, then runs it again.
 *
 * Strategy: pre-warm the sudo credential cache immediately before every
 * service spawn. This is more reliable than SUDO_ASKPASS env-var injection
 * because intermediate launchers (opctl, make, etc.) may reset the environment
 * before sudo is invoked. The cache is valid for ~5 min by default, which is
 * more than enough for a service to finish its startup sudo calls.
 *
 * SEC-1c (R8, SEC-1 §5): an agent's request never passes the lock. The
 * server runs every request in its own lock scope (inRequestLockScope) and
 * closes it for an agent's actor token (closeLockForThisRequest): inside a
 * closed scope, and in everything the request starts (its spawned
 * commands' callbacks included), the store reads as locked and hands out
 * no sudo wrapper and warms no sudo cache.
 */
import { AsyncLocalStorage } from "async_hooks";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { CLI_SPAWN_TIMEOUT_MS } from "../../shared/constants.js";

import { product } from "../../shared/product.js";
let _sudoPassword: string | null = null;
const lockScope = new AsyncLocalStorage<{ closed: boolean }>();

/** Run one request in its own lock scope (open unless closed below). */
export function inRequestLockScope<T>(fn: () => T): T {
  return lockScope.run({ closed: false }, fn);
}

/** This request is an agent's: the lock stays shut for all it starts. */
export function closeLockForThisRequest(): void {
  const s = lockScope.getStore();
  if (s) s.closed = true;
}

/** Whether the current request's lock scope is closed (an agent's). */
export function lockClosedHere(): boolean {
  return lockScope.getStore()?.closed === true;
}
let _sudoDir: string | null = null;
let _askDir: string | null = null;

/** Den's own sudo shim dirs (never the real sudo). */
function shimDirPrefix(): string {
  return path.join(os.tmpdir(), `${product().cli}-sudo-`);
}

/**
 * The real sudo: the first `sudo` on PATH that isn't one of Den's shims,
 * else /usr/bin/sudo. Read when a shim is written.
 */
export function realSudoPath(envPath: string = process.env.PATH ?? ""): string {
  const prefix = shimDirPrefix();
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir || dir.startsWith(prefix)) continue;
    const file = path.join(dir, "sudo");
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* not here */
    }
  }
  return "/usr/bin/sudo";
}

/** A path inside single quotes, for a shim. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function setSudoPassword(password: string): void {
  _sudoPassword = password;
  const dir = `${shimDirPrefix()}${process.pid}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pwFile = path.join(dir, "pw");
  fs.writeFileSync(pwFile, password + "\n", { mode: 0o600 });
  const wrapper = path.join(dir, "sudo");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${shq(realSudoPath())} -S "$@" < ${shq(pwFile)}\n`,
    { mode: 0o700 },
  );
  _sudoDir = dir;
}

/** What the no-password shim prints before it fails (LK-0). */
export const NEEDS_SUDO_MARK = "needs-sudo:";

/**
 * The shim for when no password is held (LK-0): sudo that needs none runs
 * as it would; anything else prints `<cli>: needs-sudo: sudo <args>` and
 * fails, never prompting. It holds no secret.
 */
function askShim(): string {
  const real = shq(realSudoPath());
  const mark = `${product().cli}: ${NEEDS_SUDO_MARK}`;
  return [
    "#!/bin/sh",
    `# ${product().title}: no admin password is held (LK-0).`,
    `REAL=${real}`,
    // A caller feeding its own password, or a passwordless sudo: as is.
    'case " $* " in *" -S "*) exec "$REAL" "$@";; esac',
    'if "$REAL" -n true >/dev/null 2>&1; then exec "$REAL" -n "$@"; fi',
    'err=$(mktemp "${TMPDIR:-/tmp}/sudo-err.XXXXXX") || exit 1',
    '"$REAL" -n "$@" 2>"$err"; rc=$?',
    'if [ "$rc" -ne 0 ] && grep -qi -e "password is required" -e "terminal is required" "$err"; then',
    '  rm -f "$err"',
    `  printf '%s sudo %s\\n' ${shq(mark)} "$*" >&2`,
    "  exit 1",
    "fi",
    'cat "$err" >&2; rm -f "$err"; exit "$rc"',
    "",
  ].join("\n");
}

function ensureAskDir(): string | null {
  if (_askDir) return _askDir;
  try {
    const dir = `${shimDirPrefix()}${process.pid}-ask`;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "sudo"), askShim(), { mode: 0o700 });
    _askDir = dir;
  } catch {
    return null;
  }
  return _askDir;
}

export function clearSudoPassword(): void {
  _sudoPassword = null;
  if (_sudoDir) {
    try {
      fs.rmSync(_sudoDir, { recursive: true });
    } catch {
      /* ignore */
    }
    _sudoDir = null;
  }
}

/** On exit: the password and the shims go. */
export function clearSudoShims(): void {
  clearSudoPassword();
  if (_askDir) {
    try {
      fs.rmSync(_askDir, { recursive: true });
    } catch {
      /* ignore */
    }
    _askDir = null;
  }
}

/**
 * Returns env additions that prepend our sudo shim to PATH so that any
 * 'sudo' call in the spawned process tree uses the stored password, or,
 * with none, says it needs one instead of prompting (LK-0).
 */
export function getSudoEnv(): NodeJS.ProcessEnv {
  if (lockClosedHere()) return {};
  const dir = _sudoDir ?? ensureAskDir();
  if (!dir) return {};
  const currentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  return { PATH: `${dir}:${currentPath}` };
}

/** A run's needs-sudo event (LK-0): what needed sudo, and in which step. */
export interface NeedsSudo {
  type: "needs-sudo";
  /** The sudo command, when the shim saw it (`sudo <args>`). */
  command?: string;
  /** The service address (or step) that ran it. */
  step?: string;
}

const MAX_COMMAND = 200;
const NATIVE_ASK =
  /^\s*sudo: (?:a password is required|a terminal is required to read the password)/;

/**
 * Whether one output line says sudo needed the password: the shim's own
 * line (with the command), or sudo's own refusal when a launcher reset the
 * PATH (no command). Null otherwise.
 */
export function needsSudoOf(line: string): { command?: string } | null {
  const i = line.indexOf(NEEDS_SUDO_MARK);
  if (i >= 0) {
    const command = line
      .slice(i + NEEDS_SUDO_MARK.length)
      .trim()
      .slice(0, MAX_COMMAND);
    return command ? { command } : {};
  }
  return NATIVE_ASK.test(line) ? {} : null;
}

/**
 * Wrap a run's SSE `emit`: a `line` that says sudo needed the password is
 * followed by one `needs-sudo` event (once per step and command). The step
 * is the last `label` event's text (a workspace run's service), else
 * `step`.
 */
export function watchSudo(
  emit: (obj: unknown) => void,
  step?: string,
): (obj: unknown) => void {
  let current = step;
  const said = new Set<string>();
  return (obj) => {
    emit(obj);
    const o = obj as { type?: unknown; text?: unknown } | null;
    if (!o || typeof o.text !== "string") return;
    if (o.type === "label") {
      current = o.text;
      return;
    }
    if (o.type !== "line" && o.type !== "error") return;
    const hit = needsSudoOf(o.text);
    if (!hit) return;
    const key = `${current ?? ""}\u0000${hit.command ?? ""}`;
    if (said.has(key)) return;
    said.add(key);
    const ev: NeedsSudo = {
      type: "needs-sudo",
      ...(hit.command ? { command: hit.command } : {}),
      ...(current ? { step: current } : {}),
    };
    emit(ev);
  };
}

/**
 * Refreshes the sudo credential cache in den's own process as a
 * belt-and-suspenders fallback alongside the PATH wrapper.
 */
export function prewarmSudo(): void {
  if (!_sudoPassword || lockClosedHere()) return;
  try {
    execSync("sudo -S -v", {
      input: _sudoPassword + "\n",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
  } catch {
    /* best-effort */
  }
}

/** True when a sudo password has been set. */
export function hasSudoPassword(): boolean {
  return _sudoDir !== null && !lockClosedHere();
}

let _passwordlessCache: { value: boolean; at: number } | null = null;
const PASSWORDLESS_TTL_MS = 60_000;

/**
 * True when sudo runs without a password prompt right now — a NOPASSWD sudoer,
 * or a warm sudo credential cache. Detected with `sudo -n true` (`-n` =
 * non-interactive: exits 0 only if no password is needed, never prompts). When
 * true, service commands' own `sudo` calls succeed with no stored password, so
 * the web UI can skip the admin-login gate entirely. Cached briefly so the
 * status endpoint doesn't spawn sudo on every check.
 */
export function hasPasswordlessSudo(): boolean {
  if (lockClosedHere()) return false;
  const now = Date.now();
  if (_passwordlessCache && now - _passwordlessCache.at < PASSWORDLESS_TTL_MS) {
    return _passwordlessCache.value;
  }
  let value = false;
  try {
    execSync("sudo -n true", {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: CLI_SPAWN_TIMEOUT_MS,
    });
    value = true;
  } catch {
    value = false;
  }
  _passwordlessCache = { value, at: now };
  return value;
}
