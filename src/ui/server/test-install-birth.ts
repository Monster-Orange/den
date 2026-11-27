/**
 * Issue 814: the server's first look at its state folder, imported first
 * by index.ts so it runs before anything else writes there. With the
 * launcher's test flag, on its own folder with no secret yet (issue 1407:
 * this start creates it; `web up`'s log and web.json may be there), the server claims
 * it as a new test install (birthClaim); a pending record otherwise left
 * there is dropped. index.ts seals
 * the claim (and gives the install its fixture person) once the folder's
 * secret exists and the mark is read; otherwise it drops it.
 */
import { getProfile, getStateDir } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { readEnv } from "../../shared/profile.js";
import { TEST_INSTALL_ENV_KEY } from "../../shared/fixture-person.js";
import { birthClaim } from "../../shared/test-operator.js";

function born(): boolean {
  try {
    const profile = getProfile();
    return birthClaim({
      stateDir: getStateDir(),
      defaultStateDir: profile.stateDir,
      launchFlag: readEnv(profile, TEST_INSTALL_ENV_KEY) === "1",
      // `web up` writes logs/<cli>/web.log before it starts the server.
      cli: product().cli,
    });
  } catch {
    return false;
  }
}

/** Whether this start claimed a new state folder as a test install. */
export const BORN_AS_TEST_INSTALL: boolean = born();
