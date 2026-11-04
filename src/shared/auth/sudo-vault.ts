/**
 * Secrets-backed persistence for the local-dev sudo password.
 *
 * Goes through the configured secrets strategy (Doppler, 1Password or env —
 * see src/shared/secrets), addressing the named ref `sudo` (default
 * OP_API_KEYS_VAULT / OP_DEV_KEYS_ITEM / OP_DEN_SUDO_FIELD; an org
 * moves it with `secrets.refs.sudo` in its config) — flat key
 * DEN_LOCAL_ADMIN_PWD for key/value backends.
 *
 * All read helpers fail *soft*: if the backend isn't installed, the user isn't
 * signed in, or the value is missing, they return null/false so the server can
 * fall back to the manual unlock banner without surfacing CLI noise.
 */

import {
  OP_API_KEYS_VAULT,
  OP_DEV_KEYS_ITEM,
  OP_DEN_SUDO_FIELD,
} from "../constants.js";
import {
  getSecretsProvider,
  namedSecretRef,
  type SecretRef,
} from "../secrets/index.js";

/** The built-in default for the `sudo` named ref. */
export const SUDO_SECRET_REF: SecretRef = {
  vault: OP_API_KEYS_VAULT,
  item: OP_DEV_KEYS_ITEM,
  field: OP_DEN_SUDO_FIELD,
};

/** The effective sudo ref (`secrets.refs.sudo` over the default). */
function sudoRef(): SecretRef {
  return namedSecretRef("sudo", SUDO_SECRET_REF);
}

/** True when the secrets backend is installed AND authenticated. */
export async function isSecretsBackendReady(): Promise<boolean> {
  return getSecretsProvider().isReady();
}

/** @deprecated use isSecretsBackendReady */
export const isOpSignedIn = isSecretsBackendReady;

/** Read the stored sudo password. Null when unavailable or empty. */
export async function readSudoFromVault(): Promise<string | null> {
  return getSecretsProvider().tryGet(sudoRef());
}

/** Whether a non-empty sudo password is stored (without returning it). */
export async function hasSudoInVault(): Promise<boolean> {
  return (await readSudoFromVault()) !== null;
}

/** Save (or overwrite) the sudo password. Throws on backend errors. */
export async function saveSudoToVault(password: string): Promise<void> {
  await getSecretsProvider().set(sudoRef(), password);
}

/** Name of the active backend, for UI copy ("Save to Doppler"). */
export function secretsBackendLabel(): string {
  const n = getSecretsProvider().name;
  return n === "1password"
    ? "1Password"
    : n === "doppler"
      ? "Doppler"
      : "environment";
}
