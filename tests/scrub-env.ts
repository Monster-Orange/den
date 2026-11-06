/**
 * Strip credentials from the environment a test worker inherits.
 *
 * A test that asserts on a spawn env built from process.env prints the
 * whole object when it fails, and a developer's shell carries real tokens
 * (git host, secrets backends, agent tooling). Tests never need real
 * credentials (they set their own sentinels), so the setup file removes
 * them before any suite runs, and the child processes a suite spawns
 * inherit the scrubbed environment.
 *
 * The patterns are Den's own (src/shared/secret-env.ts): the ones a
 * session started from the caller's shell is scrubbed with.
 */
import { isCredentialEnv } from "../src/shared/secret-env";

/** Whether a variable looks like a credential, by name or by value. */
export const isSecretEnv = isCredentialEnv;

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
