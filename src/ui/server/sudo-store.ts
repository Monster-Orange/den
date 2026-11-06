/**
 * Sudo password store.
 *
 * Keeps the user's sudo password in memory so spawned service commands
 * (make up / down / etc.) can authenticate without a terminal.
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

export function setSudoPassword(password: string): void {
  _sudoPassword = password;
  const dir = path.join(os.tmpdir(), `${product().cli}-sudo-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pwFile = path.join(dir, "pw");
  fs.writeFileSync(pwFile, password + "\n", { mode: 0o600 });
  const wrapper = path.join(dir, "sudo");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec /usr/bin/sudo -S "$@" < '${pwFile}'\n`,
    { mode: 0o700 },
  );
  _sudoDir = dir;
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

/**
 * Returns env additions that prepend our sudo wrapper to PATH so that any
 * 'sudo' call in the spawned process tree uses the stored password.
 */
export function getSudoEnv(): NodeJS.ProcessEnv {
  if (!_sudoDir || lockClosedHere()) return {};
  const currentPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  return { PATH: `${_sudoDir}:${currentPath}` };
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
