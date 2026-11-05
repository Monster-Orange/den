import type { SecretRef } from "./types.js";

/** Upper-snake a free-form label: "Test User (Auth0)" → "TEST_USER_AUTH0". */
export function toEnvName(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/** Canonical `vault/item/field` string used as the key of `secrets.keys`. */
export function refPath(ref: SecretRef): string {
  return `${ref.vault}/${ref.item}/${ref.field}`;
}

/**
 * Resolve the flat key a key/value backend should use for `ref`:
 *   0. a scoped ref's field, as is (it is fully qualified: no overrides);
 *   1. `ref.key` when the caller pinned one;
 *   2. the `secrets.keys` override map (`"vault/item/field": KEY`);
 *   3. the field itself when it already looks like an env var (API keys);
 *   4. otherwise `ITEM_FIELD` upper-snaked.
 */
export function flatKeyFor(
  ref: SecretRef,
  overrides: Record<string, string> = {},
): string {
  if (ref.scoped) return ref.field;
  if (ref.key) return ref.key;
  const mapped = overrides[refPath(ref)];
  if (mapped) return mapped;
  if (/^[A-Z][A-Z0-9_]*$/.test(ref.field)) return ref.field;
  return toEnvName(`${ref.item} ${ref.field}`);
}
