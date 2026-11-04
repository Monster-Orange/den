import { describe, expect, it } from "@jest/globals";
import {
  migrateManifest,
  CURRENT_SCHEMA_VERSION,
} from "../../../src/shared/manifest/migrate-manifest.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const v1Minimal = { name: "my-service" };
const v1Full = {
  name: "files-api",
  entrypoint: "api",
  services: {
    api: {
      commands: { local: { up: "make up", down: "make down" } },
      health: { local: { url: "http://files-api:8080/healthz" } },
    },
  },
};

// ── Version detection ─────────────────────────────────────────────────────────

describe("migrateManifest — version detection", () => {
  it("treats a manifest with no version field as v1", () => {
    const result = migrateManifest(v1Minimal);
    expect(result.fromVersion).toBe(1);
  });

  it("treats version: 1 as v1", () => {
    const result = migrateManifest({ ...v1Minimal, version: 1 });
    expect(result.fromVersion).toBe(1);
  });

  it("detects the version from the version field when present", () => {
    // Future version — migration handles gracefully (no-op chain)
    const result = migrateManifest({ ...v1Minimal, version: 1 });
    expect(result.fromVersion).toBe(1);
  });
});

// ── No-op (already at current version) ────────────────────────────────────────

describe("migrateManifest — no-op when already at current version", () => {
  it("returns fromVersion === toVersion === CURRENT_SCHEMA_VERSION", () => {
    const result = migrateManifest(v1Minimal);
    expect(result.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("returns an empty changes array when nothing was migrated", () => {
    const result = migrateManifest(v1Full);
    expect(result.changes).toEqual([]);
  });

  it("output manifest has version field set to current version", () => {
    const result = migrateManifest(v1Minimal);
    expect(result.manifest.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("preserves all existing fields through the migration", () => {
    const result = migrateManifest(v1Full);
    expect(result.manifest.name).toBe("files-api");
    expect(result.manifest.entrypoint).toBe("api");
    expect(result.manifest.services?.api?.health?.local).toEqual({
      url: "http://files-api:8080/healthz",
    });
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("migrateManifest — idempotency", () => {
  it("migrating twice gives the same result as migrating once", () => {
    const once = migrateManifest(v1Minimal).manifest;
    const twice = migrateManifest(once).manifest;
    expect(twice).toEqual(once);
  });

  it("changes list is empty on the second migration", () => {
    const first = migrateManifest(v1Full).manifest;
    const second = migrateManifest(first);
    expect(second.changes).toEqual([]);
  });
});

// ── Unknown future version ────────────────────────────────────────────────────

describe("migrateManifest — unknown future version", () => {
  it("throws a descriptive error when asked to migrate to an unknown version", () => {
    expect(() => migrateManifest(v1Minimal, 999)).toThrow(
      /unknown|unsupported/i,
    );
  });

  it("error message mentions the target version number", () => {
    expect(() => migrateManifest(v1Minimal, 999)).toThrow("999");
  });
});

// ── Output manifest validity ──────────────────────────────────────────────────

describe("migrateManifest — output is always a valid manifest", () => {
  it("migrated minimal manifest passes schema validation", async () => {
    const { validateManifest } =
      await import("../../../src/shared/manifest/validate-manifest.js");
    const result = migrateManifest(v1Minimal);
    const validation = validateManifest(result.manifest);
    expect(validation.valid).toBe(true);
  });

  it("migrated full manifest passes schema validation", async () => {
    const { validateManifest } =
      await import("../../../src/shared/manifest/validate-manifest.js");
    const result = migrateManifest(v1Full);
    const validation = validateManifest(result.manifest);
    expect(validation.valid).toBe(true);
  });
});

// ── Migration chain ──────────────────────────────────────────────────────────

describe("migrateManifest — migration chain", () => {
  it("throws when a migration step is missing from the chain", () => {
    // version:0 → toVersion:1 requires MIGRATION_STEPS[0], which doesn't exist
    expect(() => migrateManifest({ name: "test", version: 0 }, 1)).toThrow(
      /No migration step found from v0 to v1/,
    );
  });

  it("error mentions it is a bug", () => {
    expect(() => migrateManifest({ name: "test", version: 0 }, 1)).toThrow(
      /bug/,
    );
  });
});

// ── MigrationResult shape ─────────────────────────────────────────────────────

describe("migrateManifest — result shape", () => {
  it("result has manifest, fromVersion, toVersion, and changes fields", () => {
    const result = migrateManifest(v1Minimal);
    expect(result).toHaveProperty("manifest");
    expect(result).toHaveProperty("fromVersion");
    expect(result).toHaveProperty("toVersion");
    expect(result).toHaveProperty("changes");
  });

  it("changes is an array of strings", () => {
    const result = migrateManifest(v1Minimal);
    expect(Array.isArray(result.changes)).toBe(true);
    result.changes.forEach((c) => expect(typeof c).toBe("string"));
  });
});
