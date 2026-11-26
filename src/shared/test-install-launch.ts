import { TEST_INSTALL_ENV_KEY } from "./fixture-person.js";
import { envName, readEnv, type ProductProfile } from "./profile.js";

let held: { name: string } | null = null;

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

export function testInstallRestartEnv(): Record<string, string> {
  return held ? { [held.name]: "1" } : {};
}
