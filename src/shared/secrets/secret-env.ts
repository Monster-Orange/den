/**
 * `secret_env` (R16): environment variables whose values Den resolves from
 * the configured secrets provider when it starts or restarts a target.
 *
 *   compose:
 *     secret_env:
 *       OPENAI_API_KEY: proj/dev_personal/OPENAI_API_KEY
 *   services:
 *     api:
 *       secret_env:
 *         SOME_KEY: vault/item/field
 *
 * Each value is a fully qualified `a/b/c` path, parsed into a SCOPED
 * {@link SecretRef} (see its `scoped` field for what each provider does with
 * it). Values only ever travel in the spawned process's env: never into the
 * compose override, logs, activity records, MCP output, dry runs or errors.
 * Everything here that produces text names keys and refs, never values.
 *
 * This module only imports types, so the manifest schema can use the parser.
 */
import type { SecretRef, SecretsProvider } from "./types.js";

/** A `secret_env` block: env var name → `a/b/c` ref. */
export type SecretEnvSpec = Record<string, string>;

/** Env var names Den will set (POSIX-portable). */
export const SECRET_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Why `raw` is not a valid secret_env ref, or null when it is. */
export function secretEnvRefError(raw: unknown): string | null {
  if (typeof raw !== "string")
    return 'must be a string "<vault>/<item>/<field>"';
  const parts = raw.split("/");
  if (
    parts.length !== 3 ||
    parts.some((p) => p.trim() === "" || p !== p.trim())
  )
    return `"${raw}" must be exactly three non-empty parts, "<vault>/<item>/<field>" (Doppler: <project>/<config>/<key>)`;
  return null;
}

/** Parse an `a/b/c` ref into a scoped SecretRef. Throws when malformed. */
export function parseSecretEnvRef(raw: string): SecretRef {
  const err = secretEnvRefError(raw);
  if (err) throw new Error(`secret_env ref ${err}`);
  const [vault, item, field] = raw.split("/");
  return { vault, item, field, scoped: true };
}

/**
 * Problems with a whole `secret_env` block, as `KEY: message` strings ([]
 * when it is valid). `where` prefixes each message.
 */
export function secretEnvSpecErrors(spec: unknown, where: string): string[] {
  if (spec === undefined) return [];
  if (spec === null || typeof spec !== "object" || Array.isArray(spec))
    return [`${where} must be a map of ENV_NAME: "<vault>/<item>/<field>"`];
  const out: string[] = [];
  for (const [k, v] of Object.entries(spec)) {
    if (!SECRET_ENV_KEY_RE.test(k))
      out.push(`${where}.${k}: "${k}" is not a valid env var name`);
    const err = secretEnvRefError(v);
    if (err) out.push(`${where}.${k}: ref ${err}`);
  }
  return out;
}

/** The validated block, or throws listing every problem. */
export function assertSecretEnvSpec(
  spec: unknown,
  where: string,
): SecretEnvSpec | undefined {
  if (spec === undefined) return undefined;
  const errors = secretEnvSpecErrors(spec, where);
  if (errors.length) throw new Error(errors.join("\n"));
  return { ...(spec as SecretEnvSpec) };
}

/** One key that could not be resolved. Never carries a value. */
export interface SecretEnvMissing {
  key: string;
  ref: string;
  /** Why, in plain words, when the provider said (never a value). */
  reason?: string;
}

export type SecretEnvResolution =
  | { ok: true; env: Record<string, string> }
  | { ok: false; missing: SecretEnvMissing[]; message: string };

/**
 * The failure text for unresolved keys: key, ref and provider, and the
 * provider's reason when it gave one (a mapped phrase such as "no access to
 * the vault"), never a value and never its raw error output (which could
 * echo one).
 */
export function describeSecretEnvMissing(
  target: string,
  missing: SecretEnvMissing[],
  provider: string,
): string {
  const lines = missing.map(
    (m) =>
      `  ${m.key} (ref ${m.ref}, provider ${provider}): not resolved${m.reason ? `: ${m.reason}` : ""}`,
  );
  return (
    `${target}: ${missing.length} secret_env key(s) could not be resolved; not starting it:\n` +
    lines.join("\n")
  );
}

/**
 * Resolve every key of `spec` through `provider`. All or nothing: when any
 * key is missing (unset, empty, unreadable) the result is a failure naming
 * each missing key, and no partial env is returned.
 */
export async function resolveSecretEnv(
  spec: SecretEnvSpec | undefined,
  provider: SecretsProvider,
  target: string,
): Promise<SecretEnvResolution> {
  const entries = Object.entries(spec ?? {});
  if (!entries.length) return { ok: true, env: {} };
  const results = await Promise.all(
    entries.map(async ([key, raw]) => {
      if (secretEnvRefError(raw)) return { key, raw, value: null };
      let value: string | null = null;
      let reason: string | undefined;
      try {
        const ref = parseSecretEnvRef(raw);
        if (provider.tryGetWithReason) {
          ({ value, reason } = await provider.tryGetWithReason(ref));
        } else value = await provider.tryGet(ref);
      } catch {
        value = null;
      }
      return { key, raw, value, reason };
    }),
  );
  const missing = results
    .filter((r) => !r.value)
    .map((r) => ({
      key: r.key,
      ref: String(r.raw),
      ...(r.reason ? { reason: r.reason } : {}),
    }));
  if (missing.length)
    return {
      ok: false,
      missing,
      message: describeSecretEnvMissing(target, missing, provider.name),
    };
  return {
    ok: true,
    env: Object.fromEntries(results.map((r) => [r.key, r.value as string])),
  };
}

/** The keys of a block, sorted: what a dry run or status may show. */
export function secretEnvKeys(spec: SecretEnvSpec | undefined): string[] {
  return Object.keys(spec ?? {}).sort();
}
