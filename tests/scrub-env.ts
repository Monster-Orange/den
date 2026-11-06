/**
 * Strip credentials from the environment a test worker inherits.
 *
 * A test that asserts on a spawn env built from process.env prints the
 * whole object when it fails, and a developer's shell carries real tokens
 * (git host, secrets backends, agent tooling). Tests never need real
 * credentials (they set their own sentinels), so the setup file removes
 * them before any suite runs, and the child processes a suite spawns
 * inherit the scrubbed environment.
 */

/** Variable names that hold credentials. */
const SECRET_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_KEY|ACCESS_KEY|AUTH)/i;

/** Whole families of credential variables. */
const SECRET_PREFIX = /^(OP_|DOPPLER_|AWS_|GH_|GITHUB_|NPM_|ANTHROPIC_)/i;

/** Values shaped like well-known tokens, whatever the variable is called. */
const SECRET_VALUE =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ops_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|dp\.(st|ct|sa|scim)\.[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/;

/** Whether a variable looks like a credential, by name or by value. */
export function isSecretEnv(name: string, value: string | undefined): boolean {
  return (
    SECRET_NAME.test(name) ||
    SECRET_PREFIX.test(name) ||
    (value !== undefined && SECRET_VALUE.test(value))
  );
}

/** Remove credential-like variables from `env`; returns the names removed. */
export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (isSecretEnv(name, value)) {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}
