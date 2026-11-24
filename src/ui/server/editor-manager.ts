/**
 * Editor & Terminal Manager
 *
 * Extracted from server/index.ts. Handles detection of installed editors
 * and terminal apps, path resolution, and availability listing.
 */

import * as fs from "fs";
import { spawnSync } from "child_process";
import { detectStackConfig } from "../../ui/cli/init.js";

import {
  KNOWN_EDITORS,
  KNOWN_TERMINALS,
  SUPPORTED_LANGUAGES,
  isKnownEditorKey,
  isKnownTerminalKey,
} from "../../shared/editor-catalog.js";

export { SUPPORTED_LANGUAGES, isKnownEditorKey, isKnownTerminalKey };

/** JetBrains editors that open via CLI but need special `--line` arg handling. */
export const JETBRAINS_EDITORS = new Set(["webstorm", "idea"]);


// ── EditorManager ────────────────────────────────────────────────────────────

export class EditorManager {
  /** Resolve the executable path for an editor key, or null if not installed. */
  resolveEditorCmd(key: string): string | null {
    const editor = KNOWN_EDITORS.find((e) => e.key === key);
    if (!editor) return null;
    for (const p of editor.paths) {
      if (fs.existsSync(p)) return p;
    }
    try {
      const result = spawnSync("which", [editor.binName], {
        encoding: "utf-8",
      });
      const found = result.stdout?.trim();
      if (found && fs.existsSync(found)) return found;
    } catch {
      // ignore
    }
    return null;
  }

  /** Resolve the macOS app name for a terminal key, or null if not installed. */
  resolveTerminalApp(key: string): string | null {
    const terminal = KNOWN_TERMINALS.find((t) => t.key === key);
    if (!terminal) return null;
    for (const p of terminal.appPaths) {
      if (fs.existsSync(p)) return terminal.appName;
    }
    return null;
  }

  /** List all known editors with their availability status. */
  listEditors(): Array<{
    key: string;
    name: string;
    terminal: boolean;
    available: boolean;
  }> {
    return KNOWN_EDITORS.map((e) => ({
      key: e.key,
      name: e.name,
      terminal: e.terminal,
      available: !!this.resolveEditorCmd(e.key),
    }));
  }

  /** List all known terminals with their availability status. */
  listTerminals(): Array<{ key: string; name: string; available: boolean }> {
    return KNOWN_TERMINALS.map((t) => ({
      key: t.key,
      name: t.name,
      available: !!this.resolveTerminalApp(t.key),
    }));
  }

  /** True if the editor key is a terminal-based editor (vim, nvim, emacs). */
  isTerminalEditor(key: string): boolean {
    return KNOWN_EDITORS.find((e) => e.key === key)?.terminal ?? false;
  }

  /** True if the key matches a known editor. */
  isKnownEditor(key: string): boolean {
    return KNOWN_EDITORS.some((e) => e.key === key);
  }

  /** True if the key matches a known terminal. */
  isKnownTerminal(key: string): boolean {
    return KNOWN_TERMINALS.some((t) => t.key === key);
  }

  /**
   * Resolve which editor to use for a path, considering overrides.
   *
   * Resolution order (first match wins):
   *   1. Per-language override — repo has stack.yml with `language` field
   *      matching a key in `languageOverrides`
   *   2. Workspace editor — the active workspace has an `editor` override
   *   3. Global default — the user's default editor from settings
   */
  resolveEditorForRepo(
    repoPath: string,
    defaultEditor: string | undefined,
    languageOverrides: Record<string, string> | undefined,
    workspaceEditor?: string,
  ): string | undefined {
    // 1. Per-language override (repo-level)
    if (languageOverrides && Object.keys(languageOverrides).length > 0) {
      const stack = detectStackConfig(repoPath);
      const lang = stack?.language;
      if (lang && languageOverrides[lang]) {
        return languageOverrides[lang];
      }
    }
    // 2. Workspace editor override
    if (workspaceEditor) {
      return workspaceEditor;
    }
    // 3. Global default
    return defaultEditor;
  }
}
