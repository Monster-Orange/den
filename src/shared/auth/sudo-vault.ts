/**
 * Secrets-backed persistence for the local-dev sudo password.
 *
 * Goes through the configured secrets strategy (see src/shared/secrets),
 * addressing the named ref `sudo`. There is no built-in location: a
 * distribution that wants the saved password sets `secrets.refs.sudo` in its
 * config. Without it, the vault path is "not configured" and only the
 * interactive unlock is offered; nothing is spawned.
 *
 * All read helpers fail *soft*: if the backend isn't installed, the user isn't
 * signed in, the ref is not configured or the value is missing, they return
 * null/false so the server can fall back to the manual unlock without
 * surfacing CLI noise.
 */

import {
  getSecretsProvider,
  namedSecretRef,
  notConfiguredMessage,
  readSecretsConfig,
  secretsStatus,
  SecretsNotConfiguredError,
  type SecretRef,
  type SecretsProviderName,
} from "../secrets/index.js";
import { product } from "../product.js";

/** Name of the sudo ref under `secrets.refs`. */
export const SUDO_REF_NAME = "sudo";

/** The configured sudo ref, or null when `secrets.refs.sudo` is not set. */
export function sudoRef(): SecretRef | null {
  try {
    return namedSecretRef(SUDO_REF_NAME, readSecretsConfig());
  } catch {
    return null;
  }
}

/** True when the sudo ref is configured AND its backend is ready. */
export async function isSecretsBackendReady(): Promise<boolean> {
  if (!sudoRef()) return false;
  return getSecretsProvider().isReady();
}

/** @deprecated use isSecretsBackendReady */
export const isOpSignedIn = isSecretsBackendReady;

/** Read the stored sudo password. Null when unavailable, unconfigured or empty. */
export async function readSudoFromVault(): Promise<string | null> {
  const ref = sudoRef();
  if (!ref) return null;
  return getSecretsProvider().tryGet(ref);
}

/** Whether a non-empty sudo password is stored (without returning it). */
export async function hasSudoInVault(): Promise<boolean> {
  return (await readSudoFromVault()) !== null;
}

/** Save (or overwrite) the sudo password. Throws on backend errors. */
export async function saveSudoToVault(password: string): Promise<void> {
  const ref = sudoRef();
  if (!ref)
    throw new SecretsNotConfiguredError(notConfiguredMessage(SUDO_REF_NAME));
  await getSecretsProvider().set(ref, password);
}

/** What the UI's unlock form may offer: `/api/sudo-password/vault-status`. */
export interface SudoVaultStatus {
  /** The selected strategy id. */
  backend: SecretsProviderName;
  /** Name people see ("1Password"), for "Save to <label>". */
  label: string;
  /** `secrets.refs.sudo` is set for this backend. */
  configured: boolean;
  /**
   * The backend can work here, whether or not a sudo ref is configured
   * (`configured` says that). With no ref: detect() only (a PATH check,
   * nothing spawned), and only for an explicitly chosen provider; an unset
   * provider is never probed (it is not needed). With a ref: detect() and
   * signed in.
   */
  backendAvailable: boolean;
  /** Why it is not available (not configured, CLI not on PATH, signed out). */
  reason?: string;
  /** The distribution's org config file (e.g. config/acme.yml), for UI copy. */
  configFile: string;
  hasStored: boolean;
  /** @deprecated alias of backendAvailable; removed in a later minor. */
  opAvailable: boolean;
}

export async function sudoVaultStatus(): Promise<SudoVaultStatus> {
  const cfg = readSecretsConfig();
  const ref = sudoRef();
  const pre = secretsStatus(cfg, process.env, { detect: false });
  // Probe only what is needed or was chosen: a ref, or an explicit backend.
  const probe = !!ref || (!pre.implicit && pre.backend !== "none");
  const st = probe ? secretsStatus(cfg, process.env) : pre;
  const out = (
    backendAvailable: boolean,
    hasStored: boolean,
    reason?: string,
  ): SudoVaultStatus => ({
    backend: st.backend,
    label: st.label,
    configured: !!ref,
    backendAvailable,
    ...(reason ? { reason } : {}),
    configFile: product().configFile,
    hasStored,
    opAvailable: backendAvailable,
  });
  if (!ref)
    return out(
      probe && st.detect.available,
      false,
      notConfiguredMessage(SUDO_REF_NAME),
    );
  if (!st.detect.available)
    return out(false, false, `not available: ${st.detect.reason ?? ""}`.trim());
  if (!(await getSecretsProvider().isReady()))
    return out(false, false, `${st.label} is not signed in`);
  return out(true, await hasSudoInVault());
}

/** Name of the active backend, for UI copy ("Save to Doppler"). */
export function secretsBackendLabel(): string {
  return secretsStatus().label;
}
