/**
 * Issues 1036 and 1026: the markers a Den launcher sets for the install it
 * runs (bin/den, a gate run, an agent's session). A test run that
 * inherits them reads the running install, not this checkout: a test's
 * in-process session host hashed the install's code (so each test server
 * restarted its terminal host and the bell gained a row), and commands
 * named the running install. CI sets none of them. Global setup removes
 * them before any worker starts; a test that needs one sets its own.
 */
export const INSTALL_ENV = Object.freeze([
  "DEN_ROOT",
  "DEN_ENGINE_ROOT",
  "DEN_INVOKE_CWD",
]);

/**
 * Removes the install markers from `env`; returns the names it removed.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function stripInstallEnv(env) {
  const removed = [];
  for (const n of INSTALL_ENV)
    if (n in env) {
      delete env[n];
      removed.push(n);
    }
  return removed;
}
