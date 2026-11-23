/**
 * Issue 810's launcher flag (`<PREFIX>_TEST_INSTALL=1`), as the server
 * holds it. The server reads it once at boot and takes it out of its own
 * env, so agents, terminals and other children never inherit it.
 *
 * Issue 832: Den's own restart of a test install (den_restart_server, the
 * page's Restart, a self-update and its rollback) hands the flag back to
 * the server it starts itself, and only to it (testInstallRestartEnv). A
 * server started any other way still needs the launcher's flag.
 */
import { TEST_INSTALL_ENV_KEY } from "./fixture-person.js";
import { envName, readEnv, type ProductProfile } from "./profile.js";

let held: { name: string } | null = null;

/** Reads the launcher's flag from `env`, takes it out, and remembers it. */
export function takeTestInstallLaunchFlag(
  profile: ProductProfile,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const name = envName(profile, TEST_INSTALL_ENV_KEY);
  const on = readEnv(profile, TEST_INSTALL_ENV_KEY, env) === "1";
  delete env[name];
  held = on ? { name } : null;
  return on;
}

/**
 * The env a restart Den starts itself adds: the flag when this server was
 * launched with it, else nothing.
 */
export function testInstallRestartEnv(): Record<string, string> {
  return held ? { [held.name]: "1" } : {};
}
