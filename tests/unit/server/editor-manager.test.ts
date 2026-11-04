/**
 * Unit tests for EditorManager
 *
 * Tests editor/terminal resolution, availability detection, and listing.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("fs");
jest.mock("child_process");
jest.mock("../../../src/ui/cli/init.js", () => ({
  detectStackConfig: jest.fn(),
}));

import * as fs from "fs";
import { spawnSync } from "child_process";
import { detectStackConfig } from "../../../src/ui/cli/init.js";
import {
  EditorManager,
  SUPPORTED_LANGUAGES,
} from "../../../src/ui/server/editor-manager.js";

const mockFs = fs as jest.Mocked<typeof fs>;
const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

describe("EditorManager", () => {
  let mgr: EditorManager;

  beforeEach(() => {
    jest.resetAllMocks();
    mgr = new EditorManager();
  });

  // ── resolveEditorCmd ────────────────────────────────────────────────────

  describe("resolveEditorCmd", () => {
    it("returns the first existing path for a known editor", () => {
      mockFs.existsSync.mockImplementation(
        (p) => String(p) === "/usr/local/bin/code",
      );
      expect(mgr.resolveEditorCmd("vscode")).toBe("/usr/local/bin/code");
    });

    it("returns null for an unknown editor key", () => {
      expect(mgr.resolveEditorCmd("not-an-editor")).toBeNull();
    });

    it("falls back to which when no known path exists", () => {
      mockFs.existsSync.mockImplementation((p) => {
        return String(p) === "/custom/bin/vscode";
      });
      mockSpawnSync.mockReturnValue({
        stdout: "/custom/bin/vscode\n",
      } as ReturnType<typeof spawnSync>);

      expect(mgr.resolveEditorCmd("vscode")).toBe("/custom/bin/vscode");
    });

    it("returns null when which also finds nothing", () => {
      mockFs.existsSync.mockReturnValue(false);
      mockSpawnSync.mockReturnValue({
        stdout: "",
      } as ReturnType<typeof spawnSync>);

      expect(mgr.resolveEditorCmd("vscode")).toBeNull();
    });
  });

  // ── resolveTerminalApp ──────────────────────────────────────────────────

  describe("resolveTerminalApp", () => {
    it("returns app name when terminal app exists", () => {
      mockFs.existsSync.mockImplementation(
        (p) => String(p) === "/System/Applications/Utilities/Terminal.app",
      );
      expect(mgr.resolveTerminalApp("terminal")).toBe("Terminal");
    });

    it("returns null for unknown terminal key", () => {
      expect(mgr.resolveTerminalApp("unknown")).toBeNull();
    });

    it("returns null when no app path exists", () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(mgr.resolveTerminalApp("ghostty")).toBeNull();
    });
  });

  // ── listEditors / listTerminals ─────────────────────────────────────────

  describe("listEditors", () => {
    it("returns all known editors with availability flag", () => {
      mockFs.existsSync.mockReturnValue(false);
      const editors = mgr.listEditors();
      expect(editors.length).toBeGreaterThan(0);
      expect(editors[0]).toHaveProperty("key");
      expect(editors[0]).toHaveProperty("name");
      expect(editors[0]).toHaveProperty("available");
      expect(editors[0]).toHaveProperty("terminal");
    });

    it("marks editors as available when their path exists", () => {
      mockFs.existsSync.mockImplementation(
        (p) => String(p) === "/usr/local/bin/code",
      );
      const editors = mgr.listEditors();
      const vscode = editors.find((e) => e.key === "vscode");
      expect(vscode?.available).toBe(true);
    });
  });

  describe("listTerminals", () => {
    it("returns all known terminals with availability flag", () => {
      mockFs.existsSync.mockReturnValue(false);
      const terms = mgr.listTerminals();
      expect(terms.length).toBeGreaterThan(0);
      expect(terms[0]).toHaveProperty("key");
      expect(terms[0]).toHaveProperty("name");
      expect(terms[0]).toHaveProperty("available");
    });
  });

  // ── isTerminalEditor ────────────────────────────────────────────────────

  describe("isTerminalEditor", () => {
    it("returns true for vim", () => {
      expect(mgr.isTerminalEditor("vim")).toBe(true);
    });

    it("returns true for nvim", () => {
      expect(mgr.isTerminalEditor("nvim")).toBe(true);
    });

    it("returns false for vscode", () => {
      expect(mgr.isTerminalEditor("vscode")).toBe(false);
    });

    it("returns false for unknown editors", () => {
      expect(mgr.isTerminalEditor("unknown")).toBe(false);
    });
  });

  // ── isKnownEditor / isKnownTerminal ─────────────────────────────────────

  describe("isKnownEditor", () => {
    it("returns true for known editor", () => {
      expect(mgr.isKnownEditor("vscode")).toBe(true);
    });

    it("returns false for unknown", () => {
      expect(mgr.isKnownEditor("notepad")).toBe(false);
    });
  });

  describe("isKnownTerminal", () => {
    it("returns true for known terminal", () => {
      expect(mgr.isKnownTerminal("iterm2")).toBe(true);
    });

    it("returns false for unknown", () => {
      expect(mgr.isKnownTerminal("xterm")).toBe(false);
    });
  });

  // ── resolveEditorForRepo ──────────────────────────────────────────────────

  describe("resolveEditorForRepo", () => {
    const mockDetect = detectStackConfig as jest.MockedFunction<
      typeof detectStackConfig
    >;

    beforeEach(() => {
      mockDetect.mockReset();
    });

    it("returns default editor when no overrides configured", () => {
      expect(mgr.resolveEditorForRepo("/repo", "vscode", undefined)).toBe(
        "vscode",
      );
      expect(mgr.resolveEditorForRepo("/repo", "vscode", {})).toBe("vscode");
    });

    it("returns default editor when repo has no stack.yml", () => {
      mockDetect.mockReturnValue(null);
      expect(mgr.resolveEditorForRepo("/repo", "vscode", { go: "idea" })).toBe(
        "vscode",
      );
    });

    it("returns default editor when stack.yml has no language field", () => {
      mockDetect.mockReturnValue({ services: ["api"], language: undefined });
      expect(mgr.resolveEditorForRepo("/repo", "vscode", { go: "idea" })).toBe(
        "vscode",
      );
    });

    it("returns override editor when repo language matches", () => {
      mockDetect.mockReturnValue({ services: ["api"], language: "go" });
      expect(mgr.resolveEditorForRepo("/repo", "vscode", { go: "idea" })).toBe(
        "idea",
      );
    });

    it("returns default when repo language has no matching override", () => {
      mockDetect.mockReturnValue({ services: ["api"], language: "rust" });
      expect(mgr.resolveEditorForRepo("/repo", "vscode", { go: "idea" })).toBe(
        "vscode",
      );
    });

    it("returns undefined when no default editor and no override", () => {
      mockDetect.mockReturnValue(null);
      expect(mgr.resolveEditorForRepo("/repo", undefined, {})).toBeUndefined();
    });

    it("workspace-level: uses workspace editor when set (no stack.yml)", () => {
      mockDetect.mockReturnValue(null);
      expect(
        mgr.resolveEditorForRepo(
          "/workspaces/TOA-Changelog",
          "vscode",
          { go: "idea" },
          "cursor",
        ),
      ).toBe("cursor");
    });

    it("workspace-level: falls back to default when no workspace editor", () => {
      mockDetect.mockReturnValue(null);
      expect(
        mgr.resolveEditorForRepo("/workspaces/TOA-Changelog", "vscode", {
          go: "idea",
        }),
      ).toBe("vscode");
    });

    it("repo-level: language override beats workspace editor", () => {
      mockDetect.mockReturnValue({ services: ["api"], language: "python" });
      expect(
        mgr.resolveEditorForRepo(
          "/repos/files-api",
          "vscode",
          { python: "idea" },
          "cursor",
        ),
      ).toBe("idea");
    });

    it("repo-level: workspace editor beats default when no language match", () => {
      mockDetect.mockReturnValue({ services: ["api"], language: "rust" });
      expect(
        mgr.resolveEditorForRepo(
          "/repos/my-rust-app",
          "vscode",
          { go: "idea" },
          "cursor",
        ),
      ).toBe("cursor");
    });
  });
});

// ── SUPPORTED_LANGUAGES ──────────────────────────────────────────────────────

describe("SUPPORTED_LANGUAGES", () => {
  it("is a non-empty array of { key, name } objects", () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThan(0);
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(typeof lang.key).toBe("string");
      expect(typeof lang.name).toBe("string");
    }
  });

  it("includes go, python, and typescript", () => {
    const keys = SUPPORTED_LANGUAGES.map((l) => l.key);
    expect(keys).toContain("go");
    expect(keys).toContain("python");
    expect(keys).toContain("typescript");
  });
});
