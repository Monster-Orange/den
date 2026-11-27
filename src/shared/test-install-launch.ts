import { TEST_INSTALL_ENV_KEY } from "./fixture-person.js";
import { envName, readEnv, type ProductProfile } from "./profile.js";
import { TEST_RESOLVE_ENV_KEY } from "./test-resolve.js";

let held: { name: string } | null = null;
let heldMap: { name: string; raw: string } | null = null;

export function takeTestInstallLaunchFlag(
  profile: ProductProfile,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const name = envName(profile, TEST_INSTALL_ENV_KEY);
  const on = readEnv(profile, TEST_INSTALL_ENV_KEY, env) === "1";
  delete env[name];
  held = on ? { name } : null;
  heldMap = null;
  return on;
}

export function takeTestResolveLaunch(
  profile: ProductProfile,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const name = envName(profile, TEST_RESOLVE_ENV_KEY);
  const raw = readEnv(profile, TEST_RESOLVE_ENV_KEY, env);
  delete env[name];
  heldMap = held && raw !== undefined && raw.trim() !== "" ? { name, raw } : null;
  return raw;
}

export function testInstallRestartEnv(): Record<string, string> {
  if (!held) return {};
  return {
    [held.name]: "1",
    ...(heldMap ? { [heldMap.name]: heldMap.raw } : {}),
  };
}
