/**
 * normalizeWorkspaceServices — the "lazy self-heal" that collapses per-subsystem
 * sibling entries (shop/db + shop/api) into a single first-class repo entry
 * (shop). Pure function; no fs. Catalog-aware so nested-repo keys aren't
 * mistaken for subsystems.
 */

import { describe, it, expect } from "@jest/globals";
import {
  normalizeWorkspaceServices,
  noAutostartRepos,
} from "../../../src/shared/environment-manager/workspaces.js";
import type {
  WorkspaceConfig,
  ServiceCatalog,
} from "../../../src/shared/types/index.js";

const cat: ServiceCatalog = {
  shop: { gh: "Org/shop" },
  "files-api": { gh: "Org/files-api" },
};

function cfg(services: WorkspaceConfig["services"]): WorkspaceConfig {
  return { services };
}

describe("normalizeWorkspaceServices", () => {
  it("collapses ≥2 sibling subsystem entries into one bare repo entry", () => {
    const out = normalizeWorkspaceServices(
      cfg({
        "shop/db": { mode: "dev-managed", path: "/p/shop" },
        "shop/api": { mode: "dev-managed", path: "/p/shop" },
      }),
      cat,
    );
    expect(Object.keys(out.services)).toEqual(["shop"]);
    expect(out.services.shop).toEqual({
      mode: "dev-managed",
      path: "/p/shop",
    });
  });

  it("preserves autostart:false if any sibling had it", () => {
    const out = normalizeWorkspaceServices(
      cfg({
        "shop/db": { mode: "dev-managed", path: "/p/shop" },
        "shop/api": {
          mode: "dev-managed",
          path: "/p/shop",
          autostart: false,
        },
      }),
      cat,
    );
    expect(out.services.shop.autostart).toBe(false);
  });

  it("drops redundant subsystem rows when a bare entry already exists", () => {
    const out = normalizeWorkspaceServices(
      cfg({
        shop: { mode: "dev-managed", path: "/p/shop" },
        "shop/api": { mode: "dev-managed", path: "/p/shop" },
      }),
      cat,
    );
    expect(Object.keys(out.services)).toEqual(["shop"]);
  });

  it("does NOT collapse heterogeneous siblings (different mode/path/branch)", () => {
    const services = {
      "shop/db": { mode: "dev-managed" as const, path: "/p/shop" },
      "shop/api": { mode: "managed" as const, branch: "main" },
    };
    const out = normalizeWorkspaceServices(cfg(services), cat);
    expect(Object.keys(out.services).sort()).toEqual(["shop/api", "shop/db"]);
  });

  it("leaves a single subsystem entry alone (no ≥2 siblings, no bare)", () => {
    const out = normalizeWorkspaceServices(
      cfg({ "shop/api": { mode: "dev-managed", path: "/p/shop" } }),
      cat,
    );
    expect(Object.keys(out.services)).toEqual(["shop/api"]);
  });

  it("leaves bare single-service / unrelated repos untouched", () => {
    const services = {
      "files-api": { mode: "managed" as const, branch: "main" },
      shop: { mode: "dev-managed" as const, path: "/p/shop" },
    };
    const out = normalizeWorkspaceServices(cfg(services), cat);
    expect(out).toBe(normalizeWorkspaceServices(out, cat)); // idempotent (returns same ref when unchanged)
    expect(Object.keys(out.services).sort()).toEqual(["files-api", "shop"]);
  });

  it("is idempotent (collapsing an already-collapsed config is a no-op)", () => {
    const once = normalizeWorkspaceServices(
      cfg({
        "shop/db": { mode: "dev-managed", path: "/p/shop" },
        "shop/api": { mode: "dev-managed", path: "/p/shop" },
      }),
      cat,
    );
    const twice = normalizeWorkspaceServices(once, cat);
    expect(twice).toBe(once); // unchanged → same reference
  });

  it("does not mis-collapse nested-repo catalog keys (a/b, a/c are distinct repos)", () => {
    const nestedCat: ServiceCatalog = {
      "proj/svc-a": { gh: "Org/svc-a" },
      "proj/svc-b": { gh: "Org/svc-b" },
    };
    const services = {
      "proj/svc-a": { mode: "dev-managed" as const, path: "/p/a" },
      "proj/svc-b": { mode: "dev-managed" as const, path: "/p/b" },
    };
    const out = normalizeWorkspaceServices(cfg(services), nestedCat);
    expect(Object.keys(out.services).sort()).toEqual([
      "proj/svc-a",
      "proj/svc-b",
    ]);
  });
});

describe("noAutostartRepos", () => {
  it("collects repos with autostart:false, resolving subsystem keys to repo level", () => {
    const off = noAutostartRepos(
      cfg({
        "shop/api": {
          mode: "dev-managed",
          path: "/p/shop",
          autostart: false,
        },
        "files-api": {
          mode: "managed",
          branch: "main",
          autostart: false,
        },
        tokens: { mode: "managed", branch: "main" }, // on (absent)
      }),
      cat,
    );
    expect([...off].sort()).toEqual(["files-api", "shop"]);
  });

  it("treats absent and explicit true as auto-start ON", () => {
    const off = noAutostartRepos(
      cfg({
        shop: { mode: "dev-managed", path: "/p/shop", autostart: true },
        tokens: { mode: "managed", branch: "main" },
      }),
      cat,
    );
    expect(off.size).toBe(0);
  });
});
