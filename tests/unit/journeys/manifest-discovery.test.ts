/**
 * Manifest-driven journey spec discovery tests (packet jrn-journeys-manifest).
 *
 * discoverJourneySpecs() iterates discovered repos, resolves each repo's
 * manifest.journeys.testDir against the registered local checkout, globs
 * testMatch, and validates every matching file through the journey spec
 * loader. Invalid spec files fail discovery loudly with the file path —
 * never silently skipped (synthetics parity, but stricter on bad files).
 *
 * Tests use real temp-dir repos (no module mocking): discoverJourneySpecs
 * accepts an explicit repo list, defaulting to discoverRepos() in
 * production use.
 */

import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { discoverJourneySpecs } from "../../../src/pillars/journeys/discover.js";
import { JourneySpecError } from "../../../src/pillars/journeys/spec/loader.js";
import type { DiscoveredRepo } from "../../../src/shared/types/index.js";
import { JourneysAppConfigError } from "../../../src/pillars/journeys/app-config.js";
import { TEST_APP } from "./fixtures/test-app.js";

// ── Fixture helpers ───────────────────────────────────────────────────────────

const VALID_SPEC_YAML = `
name: user-first-item
persona:
  role: user
  brief: Create an item, ask a question, read the answer.
surface: browser
environments: [local, staging]
budgets:
  max_turns: 40
  timeout_s: 480
  max_total_tokens: 2000000
success:
  assertions:
    - kind: http_status
      request: { method: GET, path: "/api/v1/items/{item_id}" }
      equals: 200
`;

const SECOND_VALID_SPEC_YAML = `
name: folder-create-and-browse
persona:
  role: admin
  brief: Create an S3 folder, test it, browse its tree.
surface: browser
environments: [local]
budgets:
  max_turns: 30
  timeout_s: 300
  max_total_tokens: 1000000
success:
  assertions:
    - kind: array_min_length
      request:
        method: POST
        path: "/api/v1/folders/{folder_id}/browse"
        body: { container: "example-bucket" }
      path: "$.nodes"
      min: 1
`;

// budgets.timeout_s missing → schema violation
const INVALID_SPEC_YAML = `
name: broken-journey
persona:
  role: user
  brief: This spec is missing a required budget.
surface: api
environments: [local]
budgets:
  max_turns: 10
  max_total_tokens: 50000
success:
  assertions:
    - kind: http_status
      request: { method: GET, path: "/api/v1/items/{item_id}" }
      equals: 200
`;

let tmpRoot: string;

function makeRepo(
  name: string,
  opts: {
    journeys?: { testDir: string; testMatch: string; app?: unknown };
    files?: Record<string, string>;
    createTestDir?: boolean;
  } = {},
): DiscoveredRepo {
  const repoPath = fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
  const { journeys, files = {}, createTestDir = true } = opts;

  if (journeys && createTestDir) {
    fs.mkdirSync(path.join(repoPath, journeys.testDir), { recursive: true });
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoPath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  return {
    repoName: name,
    repoPath,
    manifest: { name, ...(journeys ? { journeys } : {}) },
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-discovery-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Discovery over repos with journeys blocks ─────────────────────────────────

describe("discoverJourneySpecs — the app under test (journeys.app)", () => {
  it("attaches the repo's parsed journeys.app to every spec it hosts", () => {
    const repo = makeRepo("web-app", {
      journeys: {
        testDir: "tests/journeys",
        testMatch: "**/*.journey.yml",
        app: TEST_APP,
      },
      files: {
        "tests/journeys/user-first-item.journey.yml": VALID_SPEC_YAML,
      },
    });

    const specs = discoverJourneySpecs([repo]);

    expect(specs[0].app).toEqual(TEST_APP);
  });

  it("gives an empty app when the block declares none", () => {
    const repo = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: {
        "tests/journeys/user-first-item.journey.yml": VALID_SPEC_YAML,
      },
    });

    expect(discoverJourneySpecs([repo])[0].app).toEqual({});
  });

  it("fails loudly on an invalid journeys.app, naming the repo", () => {
    const repo = makeRepo("web-app", {
      journeys: {
        testDir: "tests/journeys",
        testMatch: "**/*.journey.yml",
        app: { resources: [{ type: "item" }] },
      },
      files: {
        "tests/journeys/user-first-item.journey.yml": VALID_SPEC_YAML,
      },
    });

    expect(() => discoverJourneySpecs([repo])).toThrow(JourneysAppConfigError);
    expect(() => discoverJourneySpecs([repo])).toThrow(/web-app/);
  });
});

describe("discoverJourneySpecs — happy path", () => {
  it("discovers validated specs from a repo's manifest-declared testDir", () => {
    const repo = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: {
        "tests/journeys/user-first-item.journey.yml": VALID_SPEC_YAML,
      },
    });

    const specs = discoverJourneySpecs([repo]);

    expect(specs).toHaveLength(1);
    expect(specs[0].spec.name).toBe("user-first-item");
    expect(specs[0].repoName).toBe("web-app");
    expect(specs[0].repoPath).toBe(repo.repoPath);
    expect(specs[0].specPath).toBe(
      path.join(repo.repoPath, "tests/journeys/user-first-item.journey.yml"),
    );
  });

  it("discovers multiple specs across multiple repos", () => {
    const repoA = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: {
        "tests/journeys/user-first-item.journey.yml": VALID_SPEC_YAML,
        "tests/journeys/folder-create-and-browse.journey.yml":
          SECOND_VALID_SPEC_YAML,
      },
    });
    const repoB = makeRepo("other-app", {
      journeys: { testDir: "journeys", testMatch: "**/*.journey.yml" },
      files: { "journeys/user-first-item.journey.yml": VALID_SPEC_YAML },
    });

    const specs = discoverJourneySpecs([repoA, repoB]);

    expect(specs).toHaveLength(3);
    expect(specs.map((s) => s.repoName).sort()).toEqual([
      "other-app",
      "web-app",
      "web-app",
    ]);
  });

  it("matches specs in nested directories via **", () => {
    const repo = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: {
        "tests/journeys/phase2/marketplace.journey.yml": VALID_SPEC_YAML,
      },
    });

    const specs = discoverJourneySpecs([repo]);

    expect(specs).toHaveLength(1);
    expect(specs[0].specPath).toContain(path.join("phase2"));
  });

  it("ignores files that do not match testMatch", () => {
    const repo = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: {
        "tests/journeys/user-first-item.journey.yml": VALID_SPEC_YAML,
        "tests/journeys/README.md": "# not a spec",
        "tests/journeys/helpers.yml": "not: a-journey",
      },
    });

    const specs = discoverJourneySpecs([repo]);

    expect(specs).toHaveLength(1);
    expect(specs[0].spec.name).toBe("user-first-item");
  });

  it("returns deterministic ordering (sorted by repo, then path)", () => {
    const repo = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: {
        "tests/journeys/b-second.journey.yml": SECOND_VALID_SPEC_YAML,
        "tests/journeys/a-first.journey.yml": VALID_SPEC_YAML,
      },
    });

    const specs = discoverJourneySpecs([repo]);

    expect(specs.map((s) => path.basename(s.specPath))).toEqual([
      "a-first.journey.yml",
      "b-second.journey.yml",
    ]);
  });
});

// ── Repos without journeys blocks ─────────────────────────────────────────────

describe("discoverJourneySpecs — repos without journeys", () => {
  it("skips repos whose manifest has no journeys block", () => {
    const withBlock = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: { "tests/journeys/item.journey.yml": VALID_SPEC_YAML },
    });
    const withoutBlock = makeRepo("files-api");

    const specs = discoverJourneySpecs([withBlock, withoutBlock]);

    expect(specs).toHaveLength(1);
    expect(specs[0].repoName).toBe("web-app");
  });

  it("returns an empty array when no repo declares journeys", () => {
    const specs = discoverJourneySpecs([makeRepo("a"), makeRepo("b")]);
    expect(specs).toEqual([]);
  });

  it("returns an empty array when testMatch matches no files", () => {
    const repo = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: { "tests/journeys/notes.txt": "nothing here" },
    });

    expect(discoverJourneySpecs([repo])).toEqual([]);
  });
});

// ── Loud failures ─────────────────────────────────────────────────────────────

describe("discoverJourneySpecs — loud failures", () => {
  it("throws JourneySpecError with the file path for an invalid spec file", () => {
    const repo = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: { "tests/journeys/broken.journey.yml": INVALID_SPEC_YAML },
    });

    expect(() => discoverJourneySpecs([repo])).toThrow(JourneySpecError);
    expect(() => discoverJourneySpecs([repo])).toThrow(/broken\.journey\.yml/);
  });

  it("does not swallow an invalid spec even when valid specs exist alongside", () => {
    const repo = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      files: {
        "tests/journeys/good.journey.yml": VALID_SPEC_YAML,
        "tests/journeys/broken.journey.yml": INVALID_SPEC_YAML,
      },
    });

    expect(() => discoverJourneySpecs([repo])).toThrow(JourneySpecError);
  });

  it("throws when a declared journeys.testDir does not exist", () => {
    const repo = makeRepo("web-app", {
      journeys: { testDir: "tests/journeys", testMatch: "**/*.journey.yml" },
      createTestDir: false,
    });

    expect(() => discoverJourneySpecs([repo])).toThrow(/tests\/journeys/);
    expect(() => discoverJourneySpecs([repo])).toThrow(/web-app/);
  });
});
