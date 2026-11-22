/**
 * Issue 814: the server's first look at its state folder, imported first
 * by index.ts so it runs before anything else writes there. With the
 * launcher's test flag, on its own folder that is missing or empty, the
 * server claims it as a new test install (claimAtBirth). index.ts seals
 * the claim (and gives the install its fixture person) once the folder's
 * secret exists and the mark is read; otherwise it drops it.
 */
import { getProfile, getStateDir } from "../../shared/paths.js";
import { readEnv } from "../../shared/profile.js";
import { TEST_INSTALL_ENV_KEY } from "../../shared/fixture-person.js";
import { claimAtBirth } from "../../shared/test-operator.js";

function born(): boolean {
  try {
    const profile = getProfile();
    return claimAtBirth({
      stateDir: getStateDir(),
      defaultStateDir: profile.stateDir,
      launchFlag: readEnv(profile, TEST_INSTALL_ENV_KEY) === "1",
    });
  } catch {
    return false;
  }
}

/** Whether this start claimed a new state folder as a test install. */
export const BORN_AS_TEST_INSTALL: boolean = born();
