/**
 * What a managed clone is made from (ORG-1d): a GitHub slug (`owner/repo`,
 * cloned from github.com with the user's gh as credential helper) or a git
 * URL from the catalog's `remote:` (cloned through plain git and the user's
 * own credential helper, never Den's or gh's: SEC-0).
 *
 * Clone commands run through a shell, so a remote must pass REMOTE_RE: a URL
 * with a known transport, scp-style `user@host:path`, or an absolute path,
 * and nothing a shell or git would read as a command (`ext::`, quotes, `$`,
 * spaces, a leading `-`).
 */

/** A GitHub slug, as the clone guards accept it. */
export const SAFE_SLUG_RE = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

const REMOTE_RE =
  /^(?:(?:https?|ssh|git|file):\/\/[A-Za-z0-9._~@:%+/-]+|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~+/-]+|\/[A-Za-z0-9._~@+/-]+)$/;

/** True when `spec` is a git URL rather than a GitHub slug. */
export function isGitRemote(spec: string): boolean {
  return !SAFE_SLUG_RE.test(spec);
}

/** True when `remote` is a git URL Den will hand to git. */
export function isSafeRemote(remote: string): boolean {
  return REMOTE_RE.test(remote) && !remote.includes("..");
}

/**
 * `remote` for display: any user info (`https://user:token@host/…`) masked.
 * Remotes can carry a token, so one is never printed as written.
 */
export function redactRemote(remote: string): string {
  return remote.replace(/^([a-z+]+:\/\/)[^@/]+@/i, "$1***@");
}

/**
 * The checked remote for `repo`, or a throw naming its catalog key (and not
 * its value, which may hold a token).
 */
export function checkedRemote(repo: string, remote: string): string {
  const r = remote.trim();
  if (!isSafeRemote(r))
    throw new Error(
      `service catalog: ${repo}.remote is not a git URL Den can clone ` +
        `(https://, ssh://, git://, file://, user@host:path or an absolute path)`,
    );
  return r;
}
