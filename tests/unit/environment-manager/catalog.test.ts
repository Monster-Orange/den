import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import * as fs from "fs";
import * as yaml from "yaml";
import type {
  ServiceCatalog,
  ServiceCatalogEntry,
} from "../../../src/shared/types/index.js";

// ── Notes on strategy ─────────────────────────────────────────────────────────
//
// catalog.ts captures `const ROOT = process.cwd()` at module load time, so we
// cannot change cwd after the fact to redirect the catalog path. Instead we
// mock the entire `fs` module so that readFileSync / writeFileSync / mkdirSync
// are jest.fn()s that we can control in each test.

jest.mock("fs");

const mockFs = fs as jest.Mocked<typeof fs>;

afterEach(() => {
  jest.resetAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCatalogEntry(
  overrides?: Partial<ServiceCatalogEntry>,
): ServiceCatalogEntry {
  return { gh: "Globex-Corp/test-repo", ...overrides };
}

function stubReadFileSync(
  content: string | { code: string; message?: string },
): void {
  mockFs.readFileSync.mockImplementation((..._args: unknown[]) => {
    if (typeof content === "string") {
      return content as unknown as Buffer;
    }
    const err = Object.assign(new Error(content.message ?? content.code), {
      code: content.code,
    });
    throw err;
  });
}

function captureWriteFileSync(): { content: () => string } {
  let captured = "";
  mockFs.writeFileSync.mockImplementation((...args: unknown[]) => {
    captured = args[1] as string;
  });
  mockFs.mkdirSync.mockReturnValue(undefined);
  return { content: () => captured };
}

// ── readCatalog ───────────────────────────────────────────────────────────────

describe("readCatalog", () => {
  let readCatalog: typeof import("../../../src/shared/environment-manager/catalog.js").readCatalog;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/catalog.js");
    readCatalog = mod.readCatalog;
  });

  it("returns an empty object when the catalog file does not exist (ENOENT)", () => {
    stubReadFileSync({ code: "ENOENT" });

    const catalog = readCatalog();
    expect(catalog).toEqual({});
  });

  it("parses a valid YAML catalog file correctly", () => {
    const catalogData: ServiceCatalog = {
      shop: { gh: "Globex-Corp/shop" },
      "tasks-runner": { gh: "Globex-Corp/tasks-runner" },
    };
    stubReadFileSync(yaml.stringify(catalogData));

    const catalog = readCatalog();
    expect(catalog).toEqual(catalogData);
  });

  it("returns an empty object when the YAML file is empty / null", () => {
    stubReadFileSync(""); // yaml.parse("") returns null; catalog.ts falls back to {}

    const catalog = readCatalog();
    expect(catalog).toEqual({});
  });

  it("re-throws errors that are not ENOENT (e.g. EACCES)", () => {
    stubReadFileSync({ code: "EACCES", message: "Permission denied" });

    expect(() => readCatalog()).toThrow("Permission denied");
  });

  it("re-throws unexpected errors (no code property)", () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error("Disk failure");
    });

    expect(() => readCatalog()).toThrow("Disk failure");
  });

  it("parses a catalog with multiple entries", () => {
    const catalogData: ServiceCatalog = {
      alpha: { gh: "Org/alpha" },
      beta: { gh: "Org/beta" },
      gamma: { gh: "Org/gamma" },
    };
    stubReadFileSync(yaml.stringify(catalogData));

    const catalog = readCatalog();
    expect(Object.keys(catalog)).toHaveLength(3);
    expect(catalog["alpha"]).toEqual({ gh: "Org/alpha" });
    expect(catalog["gamma"]).toEqual({ gh: "Org/gamma" });
  });
});

// ── upsertCatalogEntry ────────────────────────────────────────────────────────

describe("upsertCatalogEntry", () => {
  let upsertCatalogEntry: typeof import("../../../src/shared/environment-manager/catalog.js").upsertCatalogEntry;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/catalog.js");
    upsertCatalogEntry = mod.upsertCatalogEntry;
  });

  it("creates the catalog file with the new entry when none exists", () => {
    // No existing file
    stubReadFileSync({ code: "ENOENT" });
    const capture = captureWriteFileSync();

    upsertCatalogEntry("new-repo", makeCatalogEntry({ gh: "Org/new-repo" }));

    const written = yaml.parse(capture.content()) as ServiceCatalog;
    expect(written["new-repo"]).toEqual({ gh: "Org/new-repo" });
  });

  it("adds a new entry without disturbing existing entries", () => {
    const existing: ServiceCatalog = {
      shop: { gh: "Globex-Corp/shop" },
    };
    stubReadFileSync(yaml.stringify(existing));
    const capture = captureWriteFileSync();

    upsertCatalogEntry("new-svc", { gh: "Globex-Corp/new-svc" });

    const written = yaml.parse(capture.content()) as ServiceCatalog;
    expect(written["shop"]).toEqual({ gh: "Globex-Corp/shop" }); // preserved
    expect(written["new-svc"]).toEqual({ gh: "Globex-Corp/new-svc" }); // added
  });

  it("updates an existing entry in place", () => {
    const existing: ServiceCatalog = {
      shop: { gh: "Globex-Corp/shop-old" },
      other: { gh: "Globex-Corp/other" },
    };
    stubReadFileSync(yaml.stringify(existing));
    const capture = captureWriteFileSync();

    upsertCatalogEntry("shop", { gh: "Globex-Corp/shop-new" });

    const written = yaml.parse(capture.content()) as ServiceCatalog;
    expect(written["shop"]).toEqual({
      gh: "Globex-Corp/shop-new",
    }); // updated
    expect(written["other"]).toEqual({ gh: "Globex-Corp/other" }); // preserved
  });

  it("calls mkdirSync to ensure the config directory exists before writing", () => {
    stubReadFileSync({ code: "ENOENT" });
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);

    upsertCatalogEntry("svc", { gh: "Org/svc" });

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("config"),
      expect.objectContaining({ recursive: true }),
    );
  });

  it("writes valid YAML to the file", () => {
    stubReadFileSync({ code: "ENOENT" });
    const capture = captureWriteFileSync();

    upsertCatalogEntry("my-repo", { gh: "Org/my-repo" });

    // Should be parseable YAML
    expect(() => yaml.parse(capture.content())).not.toThrow();
    const parsed = yaml.parse(capture.content()) as ServiceCatalog;
    expect(parsed["my-repo"].gh).toBe("Org/my-repo");
  });

  it("can upsert multiple times, accumulating entries", () => {
    let storedYaml = "";

    mockFs.readFileSync.mockImplementation(() => {
      return (storedYaml || yaml.stringify({})) as unknown as Buffer;
    });
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockImplementation((...args: unknown[]) => {
      storedYaml = args[1] as string;
    });

    upsertCatalogEntry("repo-a", { gh: "Org/repo-a" });
    upsertCatalogEntry("repo-b", { gh: "Org/repo-b" });

    const final = yaml.parse(storedYaml) as ServiceCatalog;
    expect(final["repo-a"]).toEqual({ gh: "Org/repo-a" });
    expect(final["repo-b"]).toEqual({ gh: "Org/repo-b" });
  });
});

// ── removeCatalogEntry ────────────────────────────────────────────────────────

describe("removeCatalogEntry", () => {
  let removeCatalogEntry: typeof import("../../../src/shared/environment-manager/catalog.js").removeCatalogEntry;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/catalog.js");
    removeCatalogEntry = mod.removeCatalogEntry;
  });

  it("removes the specified entry from the catalog", () => {
    const existing: ServiceCatalog = {
      shop: { gh: "Globex-Corp/shop" },
      "tasks-runner": { gh: "Globex-Corp/tasks-runner" },
    };
    stubReadFileSync(yaml.stringify(existing));
    const capture = captureWriteFileSync();

    removeCatalogEntry("shop");

    const written = yaml.parse(capture.content()) as ServiceCatalog;
    expect(written).not.toHaveProperty("shop");
  });

  it("preserves all other entries when removing one", () => {
    const existing: ServiceCatalog = {
      alpha: { gh: "Org/alpha" },
      beta: { gh: "Org/beta" },
      gamma: { gh: "Org/gamma" },
    };
    stubReadFileSync(yaml.stringify(existing));
    const capture = captureWriteFileSync();

    removeCatalogEntry("beta");

    const written = yaml.parse(capture.content()) as ServiceCatalog;
    expect(written).toHaveProperty("alpha");
    expect(written).toHaveProperty("gamma");
    expect(written).not.toHaveProperty("beta");
  });

  it("is a no-op (does not throw) when the entry does not exist", () => {
    const existing: ServiceCatalog = {
      shop: { gh: "Globex-Corp/shop" },
    };
    stubReadFileSync(yaml.stringify(existing));
    const capture = captureWriteFileSync();

    expect(() => removeCatalogEntry("nonexistent")).not.toThrow();

    const written = yaml.parse(capture.content()) as ServiceCatalog;
    expect(written).toHaveProperty("shop"); // original entry still there
  });

  it("produces an empty catalog when the only entry is removed", () => {
    const existing: ServiceCatalog = {
      "sole-entry": { gh: "Org/sole-entry" },
    };
    stubReadFileSync(yaml.stringify(existing));
    const capture = captureWriteFileSync();

    removeCatalogEntry("sole-entry");

    const written = (yaml.parse(capture.content()) as ServiceCatalog) ?? {};
    expect(Object.keys(written)).toHaveLength(0);
  });

  it("writes valid YAML after removing an entry", () => {
    const existing: ServiceCatalog = {
      a: { gh: "Org/a" },
      b: { gh: "Org/b" },
    };
    stubReadFileSync(yaml.stringify(existing));
    const capture = captureWriteFileSync();

    removeCatalogEntry("a");

    expect(() => yaml.parse(capture.content())).not.toThrow();
  });

  it("handles removing from an empty catalog (ENOENT) without throwing", () => {
    stubReadFileSync({ code: "ENOENT" });
    captureWriteFileSync();

    expect(() => removeCatalogEntry("nonexistent")).not.toThrow();
  });
});

// ── resolveRepoGhSlug ─────────────────────────────────────────────────────────

describe("resolveRepoGhSlug", () => {
  let resolveRepoGhSlug: typeof import("../../../src/shared/environment-manager/catalog.js").resolveRepoGhSlug;

  beforeEach(async () => {
    const mod =
      await import("../../../src/shared/environment-manager/catalog.js");
    resolveRepoGhSlug = mod.resolveRepoGhSlug;
  });

  it("uses the catalog slug when set", () => {
    const catalog: ServiceCatalog = { alpha: { gh: "Org/alpha" } };
    expect(resolveRepoGhSlug("alpha", catalog)).toBe("Org/alpha");
  });

  it("derives the conventional slug when the entry has an empty gh", () => {
    // The dev-managed add flow writes `gh: ""`, which used to make a repo
    // unclonable ("not in the catalog") after switching to managed.
    stubReadFileSync("github_org: Globex-Corp\n"); // config/den.yml
    const catalog: ServiceCatalog = { alpha: { gh: "" } };
    expect(resolveRepoGhSlug("alpha", catalog)).toBe("Globex-Corp/alpha");
  });

  it("derives the conventional slug when the repo is absent entirely", () => {
    stubReadFileSync("github_org: Globex-Corp\n");
    expect(resolveRepoGhSlug("beta", {})).toBe("Globex-Corp/beta");
  });

  it("honours a configured github_org", () => {
    stubReadFileSync("github_org: Other-Org\n");
    expect(resolveRepoGhSlug("alpha", {})).toBe("Other-Org/alpha");
  });

  it("ignores a whitespace-only gh", () => {
    stubReadFileSync("github_org: Globex-Corp\n");
    const catalog: ServiceCatalog = { alpha: { gh: "   " } };
    expect(resolveRepoGhSlug("alpha", catalog)).toBe("Globex-Corp/alpha");
  });
});
