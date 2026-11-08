/**
 * SEC-2a: the commands a page prints for a person to run, and the names it
 * gives the machines involved (the signed-out page, SEC-2 spec "exact
 * copy"). One helper builds every printed command, so none is ever a bare
 * `<cli>` that the server's user can't run:
 *
 *  - `<cli>` when the first `<cli>` on PATH is this distribution's own
 *    (its bin/<cli> shim, or Den's bin/den in Den's own checkout), else the
 *    shim's absolute path;
 *  - each argument shell-quoted only when it needs it;
 *  - an ssh one-liner quotes the remote command once more, for the shell
 *    on the far side.
 *
 * Two host values (Vision): the label people read (`web.machine_name`, else
 * the short os.hostname()) and the ssh target (the Host the browser used,
 * minus the port). The browser's Host is never the label: it is often a
 * service name, not a machine.
 *
 * Pure but for the filesystem probes, which are injectable for tests.
 */
import * as fs from "fs";
import * as net from "net";
import * as path from "path";

export interface CliResolveDeps {
  /** The PATH to search (the server's own: its user's). */
  pathEnv?: string;
  isExecutable?: (file: string) => boolean;
  realpath?: (file: string) => string | null;
}

const defaultExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
const defaultRealpath = (file: string): string | null => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};

/**
 * This distribution's command: its bin/<cli> shim, or (Den's own checkout,
 * or a distribution without a shim) the engine's bin/den. Null when
 * neither exists.
 */
export function distributionBin(
  cli: string,
  distRoot: string,
  engineRoot: string,
  isExecutable: (file: string) => boolean = defaultExecutable,
): string | null {
  for (const f of [
    path.join(distRoot, "bin", cli),
    path.join(engineRoot, "bin", "den"),
  ])
    if (isExecutable(f)) return f;
  return null;
}

/** The first `name` on `pathEnv` that is executable, or null. */
export function findOnPath(
  name: string,
  pathEnv: string,
  isExecutable: (file: string) => boolean = defaultExecutable,
): string | null {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const f = path.join(dir, name);
    if (isExecutable(f)) return f;
  }
  return null;
}

/**
 * What a printed command starts with: `cli` when the first `cli` on PATH
 * resolves to this distribution's bin, else that bin's absolute path. With
 * no bin found at all, `cli` (there is nothing better to print).
 */
export function cliPrefix(
  cli: string,
  distRoot: string,
  engineRoot: string,
  deps: CliResolveDeps = {},
): string {
  const isExec = deps.isExecutable ?? defaultExecutable;
  const real = deps.realpath ?? defaultRealpath;
  const bin = distributionBin(cli, distRoot, engineRoot, isExec);
  if (!bin) return cli;
  const hit = findOnPath(cli, deps.pathEnv ?? process.env.PATH ?? "", isExec);
  if (hit) {
    const a = real(hit);
    const b = real(bin);
    if (a !== null && a === b) return cli;
  }
  return bin;
}

/** `s` as one word for a POSIX shell: as it is when safe, else single-quoted. */
export function shellQuote(s: string): string {
  if (s !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A command line: `prefix` (cliPrefix) and its arguments, each quoted as needed. */
export function cliCommand(prefix: string, ...args: string[]): string {
  return [prefix, ...args].map(shellQuote).join(" ");
}

/** `ssh <target> '<remote>'`: the remote command quoted once more, for the far shell. */
export function sshCommand(target: string, remote: string): string {
  return `ssh ${shellQuote(target)} ${shellQuote(remote)}`;
}

/** A Host header's hostname: lowercase, no port, no IPv6 brackets. "" when none. */
export function hostOfHeader(host: string | undefined): string {
  const h = String(host ?? "")
    .trim()
    .toLowerCase();
  if (!h) return "";
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (v6) return v6[1];
  return h.replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Whether `host` is an IP address literal (v4 or v6), not a name. */
export function isIpLiteral(host: string): boolean {
  return net.isIP(host.replace(/^\[|\]$/g, "")) !== 0;
}

/** The ssh target: the Host the browser used, minus the port; else `fallback`. */
export function sshTarget(
  hostHeader: string | undefined,
  fallback: string,
): string {
  const h = hostOfHeader(hostHeader);
  return /^[a-z0-9._:-]+$/.test(h) && !h.startsWith("-") ? h : fallback;
}

/** An account name ssh can take before `@`: letters, digits, `.`, `_`, `-`. */
const SSH_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/**
 * `web.ssh_user` as stored (SEC-2a-UX): the account the signed-out page's
 * ssh link and command log in as. undefined when unset (the account Den
 * runs as); "" leaves the account off. Throws naming the key otherwise.
 */
export function parseSshUser(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || (v.trim() !== "" && !SSH_USER_RE.test(v.trim())))
    throw new Error(
      `web.ssh_user must be an account name (letters, digits, ".", "_", "-"), or "" to leave it off; got ${JSON.stringify(v)}`,
    );
  return v.trim();
}

/**
 * The account for the ssh link: `setting` when set ("" for none), else
 * `osUser` when ssh can take it, else none.
 */
export function sshUser(setting: string | undefined, osUser: string): string {
  if (setting !== undefined) return setting;
  return SSH_USER_RE.test(osUser) ? osUser : "";
}

/** `user@target`, or the bare target when there's no user. */
export function sshLogin(target: string, user: string): string {
  return user ? `${user}@${target}` : target;
}

/** `Mac-Studio.localdomain` → `Mac-Studio`; an IP literal stays whole. */
export function shortHostname(hostname: string): string {
  const h = hostname.trim();
  if (!h || isIpLiteral(h)) return h;
  return h.split(".")[0] || h;
}

/** The longest `web.machine_name` accepted. */
export const MACHINE_NAME_MAX = 64;

/**
 * `web.machine_name` as stored: a trimmed one-line label of printable
 * characters, at most MACHINE_NAME_MAX long; null when unset or blank.
 * Throws naming the key for anything else.
 */
export function parseMachineName(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string")
    throw new Error(
      `web.machine_name must be a name (text), got ${JSON.stringify(v)}`,
    );
  const s = v.trim();
  if (!s) return null;
  if (
    s.length > MACHINE_NAME_MAX ||
    [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  )
    throw new Error(
      `web.machine_name must be one line of at most ${MACHINE_NAME_MAX} characters`,
    );
  return s;
}

/** The label people read: `web.machine_name`, else the short hostname. */
export function machineLabel(
  machineName: string | null | undefined,
  hostname: string,
): string {
  const m = (machineName ?? "").trim();
  return m || shortHostname(hostname) || "this machine";
}
