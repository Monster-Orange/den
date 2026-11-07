/**
 * Secrets-backed persistence for the local-dev sudo password.
 *
 * Goes through the configured secrets strategy (see src/shared/secrets),
 * addressing the named ref `sudo`. A distribution may set
 * `secrets.refs.sudo` in its config; that ref always wins. Without one, the
 * vault path is "not configured" until the person saves the password
 * (LK-4): when a backend that keeps secrets (1Password, Doppler) is
 * available, saving creates the item and writes the ref to their own
 * user.yml, because the password is the person's, not the distribution's.
 * Nothing is spawned until then.
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
  type SecretsConfig,
  type SecretsProviderName,
} from "../secrets/index.js";
import {
  readDenConfig,
  readUserConfig,
  writeUserConfig,
} from "../den-config.js";
import { envKey, product } from "../product.js";

/** Name of the sudo ref under `secrets.refs`. */
export const SUDO_REF_NAME = "sudo";

/**
 * The configured sudo ref, or null when `secrets.refs.sudo` is not set. The
 * distribution's own ref wins over one in user.yml (the merged config lets
 * user.yml override refs in general; not this one).
 */
export function sudoRef(): SecretRef | null {
  try {
    const cfg = readSecretsConfig();
    let team: SecretsConfig["refs"];
    try {
      team = readDenConfig().secrets?.refs;
    } catch {
      team = undefined;
    }
    const fromTeam = team?.[SUDO_REF_NAME]
      ? namedSecretRef(SUDO_REF_NAME, {
          ...cfg,
          refs: { [SUDO_REF_NAME]: team[SUDO_REF_NAME] },
        })
      : null;
    return fromTeam ?? namedSecretRef(SUDO_REF_NAME, cfg);
  } catch {
    return null;
  }
}

/**
 * LK-4: where a password saved with no `secrets.refs.sudo` goes, for a
 * backend that keeps it: a new 1Password item in the person's default
 * vault, or a Doppler key. Null for `env` (process memory only: nothing
 * survives a restart) and `none`.
 */
export function newSudoRef(
  backend: SecretsProviderName,
): Partial<SecretRef> | null {
  switch (backend) {
    case "1password":
      return { item: `${product().title} admin password`, field: "password" };
    case "doppler":
      return { key: envKey("LOCAL_ADMIN_PWD") };
    default:
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

/**
 * A backend error, without the command line it ran: a CLI's failure message
 * can quote its arguments, and a password can be one of them.
 */
function withoutSecret(err: unknown, password: string): Error {
  const msg = String((err as Error)?.message ?? err)
    .split("\n")
    .filter((l) => !/^Command failed:/.test(l))
    .join(" ")
    .split(password)
    .join("***")
    .trim();
  return new Error(msg || "the secrets backend refused it");
}

/**
 * Save (or overwrite) the sudo password. With no `secrets.refs.sudo` and a
 * backend that keeps secrets (LK-4), it creates the item and then writes
 * the ref to user.yml (`ref: "created"`); a failed save writes nothing.
 * Throws on backend errors, never with the password in the message.
 */
export async function saveSudoToVault(
  password: string,
): Promise<{ ref: "configured" | "created" }> {
  const ref = sudoRef();
  if (ref) {
    try {
      await getSecretsProvider().set(ref, password);
    } catch (err) {
      throw withoutSecret(err, password);
    }
    return { ref: "configured" };
  }
  const st = secretsStatus(readSecretsConfig(), process.env);
  // Only a backend someone chose (an unset provider is never used here).
  const fresh =
    !st.implicit && st.detect.available ? newSudoRef(st.backend) : null;
  const made = fresh
    ? namedSecretRef(
        SUDO_REF_NAME,
        { refs: { [SUDO_REF_NAME]: fresh } },
        st.backend,
      )
    : null;
  if (!fresh || !made)
    throw new SecretsNotConfiguredError(notConfiguredMessage(SUDO_REF_NAME));
  try {
    await getSecretsProvider().set(made, password);
  } catch (err) {
    throw withoutSecret(err, password);
  }
  const user = readUserConfig();
  const secrets = user.secrets ?? {};
  writeUserConfig({
    ...user,
    secrets: { ...secrets, refs: { ...secrets.refs, [SUDO_REF_NAME]: fresh } },
  });
  return { ref: "created" };
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
   * Saving works without editing YAML: the ref is configured, or (LK-4) it
   * isn't and the backend keeps secrets, so saving creates the item and
   * writes the ref to user.yml.
   */
  canSave: boolean;
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
    canSave: backendAvailable && (!!ref || !!newSudoRef(st.backend)),
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

/**
 * Where a saved password would be kept, for Settings' "saved in <label>"
 * (LK-0): read from the config alone, nothing spawned (a page view never
 * wakes the vault).
 */
export function sudoVaultWhere(): { configured: boolean; label: string } {
  try {
    const st = secretsStatus(readSecretsConfig(), process.env, {
      detect: false,
    });
    return { configured: !!sudoRef(), label: st.label };
  } catch {
    return { configured: false, label: "" };
  }
}

/** Name of the active backend, for UI copy ("Save to Doppler"). */
export function secretsBackendLabel(): string {
  return secretsStatus().label;
}
