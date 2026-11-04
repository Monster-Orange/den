import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import * as path from "path";

jest.mock("fs");

import * as fs from "fs";
import {
  readDenConfig,
  readUserConfig,
  writeUserConfig,
  mergeUserConfig,
  isLocalEnabled,
  readReleaseConfig,
  writeUserReleaseConfig,
} from "../../src/shared/den-config.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEN_YML_ALL = [
  "environments:",
  "  - local",
  "  - dev",
  "  - sandbox",
  "  - staging",
  "  - production",
].join("\n");

const DEN_YML_NO_LOCAL = [
  "environments:",
  "  - dev",
  "  - sandbox",
  "  - staging",
  "  - production",
].join("\n");

const mockReadFileSync = fs.readFileSync as jest.MockedFunction<
  typeof fs.readFileSync
>;
const mockWriteFileSync = fs.writeFileSync as jest.MockedFunction<
  typeof fs.writeFileSync
>;
const mockMkdirSync = fs.mkdirSync as jest.MockedFunction<typeof fs.mkdirSync>;

/** Make readFileSync return per-path content; anything else throws ENOENT. */
function mockFiles(files: Record<string, string>) {
  mockReadFileSync.mockImplementation(
    (filePath: unknown, _options?: unknown): unknown => {
      const p = String(filePath);
      const match = Object.keys(files).find((k) => p.endsWith(k));
      if (match !== undefined) return files[match];
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
  );
}

afterEach(() => {
  jest.resetAllMocks();
});

// ── readDenConfig ──────────────────────────────────────────────────────────

describe("readDenConfig", () => {
  it("includes local by default when no user.yml exists", () => {
    mockFiles({ "config/den.yml": DEN_YML_ALL });
    expect(readDenConfig().environments).toContain("local");
  });

  it("includes local when user.yml has local_dev: true", () => {
    mockFiles({
      "config/den.yml": DEN_YML_ALL,
      "config/local/user.yml": "local_dev: true",
    });
    expect(readDenConfig().environments).toContain("local");
  });

  it("excludes local when user.yml has local_dev: false", () => {
    mockFiles({
      "config/den.yml": DEN_YML_ALL,
      "config/local/user.yml": "local_dev: false",
    });
    expect(readDenConfig().environments).not.toContain("local");
  });

  it("keeps all non-local environments when user.yml disables local_dev", () => {
    mockFiles({
      "config/den.yml": DEN_YML_ALL,
      "config/local/user.yml": "local_dev: false",
    });
    const { environments } = readDenConfig();
    expect(environments).toEqual(
      expect.arrayContaining(["dev", "sandbox", "staging", "production"]),
    );
    expect(environments).toHaveLength(4);
  });

  it("does not add local if den.yml never had it, even when user.yml enables local_dev", () => {
    mockFiles({
      "config/den.yml": DEN_YML_NO_LOCAL,
      "config/local/user.yml": "local_dev: true",
    });
    expect(readDenConfig().environments).not.toContain("local");
  });

  it("user.yml does not affect repos_root or github_org from den.yml", () => {
    mockFiles({
      "config/den.yml":
        DEN_YML_ALL + "\nrepos_root: /custom\ngithub_org: MyOrg",
      "config/local/user.yml": "local_dev: false",
    });
    const config = readDenConfig();
    expect(config.repos_root).toBe("/custom");
    expect(config.github_org).toBe("MyOrg");
  });

  it("falls back to all environments when neither config file exists", () => {
    mockFiles({});
    const config = readDenConfig();
    expect(config.environments).toContain("local");
    expect(config.environments.length).toBeGreaterThan(0);
  });
});

// ── readUserConfig ────────────────────────────────────────────────────────────

describe("readUserConfig", () => {
  it("returns empty object when user.yml does not exist", () => {
    mockFiles({});
    expect(readUserConfig()).toEqual({});
  });

  it("parses local_dev: true", () => {
    mockFiles({ "config/local/user.yml": "local_dev: true" });
    expect(readUserConfig().local_dev).toBe(true);
  });

  it("parses local_dev: false", () => {
    mockFiles({ "config/local/user.yml": "local_dev: false" });
    expect(readUserConfig().local_dev).toBe(false);
  });
});

// ── writeUserConfig ───────────────────────────────────────────────────────────

describe("writeUserConfig", () => {
  beforeEach(() => {
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);
  });

  it("writes local_dev: true as valid YAML", () => {
    writeUserConfig({ local_dev: true });
    const [, data] = mockWriteFileSync.mock.calls[0];
    expect(String(data)).toContain("local_dev: true");
  });

  it("writes local_dev: false as valid YAML", () => {
    writeUserConfig({ local_dev: false });
    const [, data] = mockWriteFileSync.mock.calls[0];
    expect(String(data)).toContain("local_dev: false");
  });

  it("writes to config/local/user.yml", () => {
    writeUserConfig({ local_dev: true });
    const [writtenPath] = mockWriteFileSync.mock.calls[0];
    expect(String(writtenPath)).toContain(
      path.join("config", "local", "user.yml"),
    );
  });

  it("creates config/local/ directory with recursive flag", () => {
    writeUserConfig({ local_dev: true });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join("config", "local")),
      expect.objectContaining({ recursive: true }),
    );
  });

  it("round-trips: write then read gives back the same value", () => {
    let stored = "";
    mockWriteFileSync.mockImplementation((_p: unknown, data: unknown) => {
      stored = String(data);
    });
    mockReadFileSync.mockImplementation(
      (filePath: unknown, _opts?: unknown): unknown => {
        const p = String(filePath);
        if (p.endsWith("user.yml")) return stored;
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
    );

    writeUserConfig({ local_dev: false });
    expect(readUserConfig().local_dev).toBe(false);
  });
});

// ── mergeUserConfig ──────────────────────────────────────────────────────────

describe("mergeUserConfig", () => {
  beforeEach(() => {
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);
  });

  it("preserves existing fields while setting a new field", () => {
    mockFiles({
      "config/local/user.yml": "editor: vscode\nterminal: iterm2\n",
    });

    const result = mergeUserConfig({ cli_tabs: true });

    expect(result).toEqual({
      editor: "vscode",
      terminal: "iterm2",
      cli_tabs: true,
    });
    const [, data] = mockWriteFileSync.mock.calls[0];
    expect(String(data)).toContain("editor: vscode");
    expect(String(data)).toContain("terminal: iterm2");
    expect(String(data)).toContain("cli_tabs: true");
  });

  it("deletes fields whose patch value is undefined", () => {
    mockFiles({
      "config/local/user.yml": "editor: vscode\ncli_tabs: true\n",
    });

    const result = mergeUserConfig({ cli_tabs: undefined });

    expect(result).toEqual({ editor: "vscode" });
    const [, data] = mockWriteFileSync.mock.calls[0];
    expect(String(data)).toContain("editor: vscode");
    expect(String(data)).not.toContain("cli_tabs");
  });
});

// ── isLocalEnabled ────────────────────────────────────────────────────────────

describe("isLocalEnabled", () => {
  it("returns true when local_dev is not configured (default on)", () => {
    mockFiles({ "config/den.yml": DEN_YML_ALL });
    expect(isLocalEnabled()).toBe(true);
  });

  it("returns false when user.yml sets local_dev: false", () => {
    mockFiles({
      "config/den.yml": DEN_YML_ALL,
      "config/local/user.yml": "local_dev: false",
    });
    expect(isLocalEnabled()).toBe(false);
  });
});

// ── release.deploy (read-only Releases) ───────────────────────────────────────

describe("release.deploy", () => {
  it("is off when no layer sets it", () => {
    mockFiles({ "config/den.yml": "release:\n  environments: [dev]\n" });
    expect(readReleaseConfig().deploy).toBe(false);
  });

  it("is on only when the team config sets deploy: true", () => {
    mockFiles({ "config/den.yml": "release:\n  deploy: true\n" });
    expect(readReleaseConfig().deploy).toBe(true);
  });

  it("can't be turned on from user.yml", () => {
    mockFiles({
      "config/den.yml": "release:\n  deploy: false\n",
      "config/local/user.yml": "release:\n  deploy: true\n",
    });
    expect(readReleaseConfig().deploy).toBe(false);
  });

  it("is stripped when the web page saves a release override", () => {
    mockMkdirSync.mockImplementation(() => undefined);
    mockWriteFileSync.mockImplementation(() => undefined);
    mockFiles({ "config/local/user.yml": "" });
    writeUserReleaseConfig({ deploy: true, staggerSeconds: 5 });
    const [, data] = mockWriteFileSync.mock.calls[0];
    expect(String(data)).toContain("staggerSeconds: 5");
    expect(String(data)).not.toContain("deploy");
  });
});
