/**
 * .den.yml schema migration engine.
 *
 * Walks the migration chain from the manifest's current version up to
 * the requested target version (default: CURRENT_SCHEMA_VERSION).
 *
 * Each step is a pure function:  migrate_N_to_M(manifest) → manifest
 * Adding a new version means:
 *   1. Bump CURRENT_SCHEMA_VERSION
 *   2. Add migrate_<old>_to_<new> to the MIGRATION_STEPS map
 *   3. Add the new version to schema.ts KNOWN_VERSIONS + schemaByVersion
 */

import type { RawManifest, MigrationResult } from "../types/index.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";

// ── Migration step registry ───────────────────────────────────────────────────

type MigrationFn = (manifest: RawManifest) => {
  manifest: RawManifest;
  change: string;
};

/**
 * Migration steps keyed by "fromVersion".
 * migrate_1_to_2 lives at key 1, migrate_2_to_3 at key 2, etc.
 *
 * Currently empty — v1 is the only version.
 * When v2 is introduced, add:
 *   [1]: migrate_1_to_2,
 */
const MIGRATION_STEPS: Record<number, MigrationFn> = {
  // Future migrations go here, e.g.:
  // [1]: migrate_1_to_2,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Migrate a manifest to the target schema version.
 *
 * @param input        - A parsed manifest object (or any plain object).
 * @param toVersion    - Target version. Defaults to CURRENT_SCHEMA_VERSION.
 * @returns MigrationResult with the migrated manifest and a log of changes.
 * @throws  When toVersion is unknown / unsupported.
 */
export function migrateManifest(
  input: Record<string, unknown> | RawManifest,
  toVersion: number = CURRENT_SCHEMA_VERSION,
): MigrationResult {
  // Validate target version
  if (toVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Cannot migrate to unsupported schema version ${toVersion}. ` +
        `Latest known version is ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  const fromVersion =
    typeof (input as Record<string, unknown>).version === "number"
      ? ((input as Record<string, unknown>).version as number)
      : 1;

  // Never silently downgrade: re-stamping a lower version onto newer-schema
  // content corrupts the manifest. Fail fast, mirroring the forward guard above.
  if (fromVersion > toVersion) {
    throw new Error(
      `Cannot downgrade manifest from v${fromVersion} to v${toVersion}.`,
    );
  }

  const changes: string[] = [];
  let current: RawManifest = { ...(input as RawManifest) };

  // Walk the chain: fromVersion → fromVersion+1 → … → toVersion
  for (let v = fromVersion; v < toVersion; v++) {
    const step = MIGRATION_STEPS[v];
    if (!step) {
      throw new Error(
        `No migration step found from v${v} to v${v + 1}. ` +
          `This is a bug — please file an issue.`,
      );
    }
    const { manifest: next, change } = step(current);
    current = next;
    changes.push(change);
  }

  // Stamp the output with the target version. RawManifest has no `version`
  // field (absence means v1), so the stamp is applied as an extra property.
  current = { ...current, version: toVersion } as RawManifest;

  return {
    manifest: current,
    fromVersion,
    toVersion,
    changes,
  };
}

export { CURRENT_SCHEMA_VERSION };
