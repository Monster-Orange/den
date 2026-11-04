/**
 * The manifest override layer: `manifests/<repo>.override.yml` deep-merged
 * onto whichever base manifest won (the repo's own, or the held one).
 *
 * Merge rules:
 *   - maps merge by key, recursively;
 *   - lists and scalars replace the base value whole;
 *   - an explicit `null` deletes the key from the result.
 *
 * An override only changes what the base already has: a key (or service)
 * the base lacks is an error (see overrideKeyErrors), so a typo can never
 * add a silent dead key.
 */

import type { ValidationError } from "../types/index.js";

export type ManifestMap = Record<string, unknown>;

/** A plain YAML/JSON map (not a list, not null). */
export function isPlainMap(v: unknown): v is ManifestMap {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** `override` deep-merged onto `base`. Neither input is changed. */
export function mergeOverride(
  base: ManifestMap,
  override: ManifestMap,
): ManifestMap {
  const out: ManifestMap = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === null) delete out[key];
    else if (isPlainMap(value) && isPlainMap(out[key]))
      out[key] = mergeOverride(out[key] as ManifestMap, value);
    else out[key] = value;
  }
  return out;
}

/**
 * Every key in `override` the base lacks, by its dotted path. A whole
 * service the base lacks is reported as one error at `services.<name>`.
 */
export function overrideKeyErrors(
  base: ManifestMap,
  override: ManifestMap,
  at: string[] = [],
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const [key, value] of Object.entries(override)) {
    const here = [...at, key];
    if (!(key in base)) {
      const isService = at.length === 1 && at[0] === "services";
      errors.push({
        path: here.join("."),
        message: isService
          ? `unknown service "${key}": the base manifest has no such service`
          : `unknown key "${key}": not in the base manifest`,
        suggestion:
          "An override can only change or delete what the base manifest has.",
      });
    } else if (isPlainMap(value) && isPlainMap(base[key])) {
      errors.push(...overrideKeyErrors(base[key] as ManifestMap, value, here));
    }
  }
  return errors;
}
