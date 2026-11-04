/**
 * Editor & Terminal Manager
 *
 * Extracted from server/index.ts. Handles detection of installed editors
 * and terminal apps, path resolution, and availability listing.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { detectStackConfig } from "../../ui/cli/init.js";

// ── Editor definitions ───────────────────────────────────────────────────────

interface EditorDef {
  key: string;
  name: string;
  /** Binary name for `which` fallback (may differ from key). */
  binName: string;
  terminal: boolean;
  paths: readonly string[];
}

const KNOWN_EDITORS: readonly EditorDef[] = [
  {
    key: "vscode",
    name: "VS Code",
    binName: "code",
    terminal: false,
    paths: [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      path.join(
        os.homedir(),
        "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      ),
      "/usr/local/bin/code",
      "/opt/homebrew/bin/code",
    ],
  },
  {
    key: "cursor",
    name: "Cursor",
    binName: "cursor",
    terminal: false,
    paths: [
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      path.join(
        os.homedir(),
        "Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      ),
      "/usr/local/bin/cursor",
    ],
  },
  {
    key: "webstorm",
    name: "WebStorm",
    binName: "webstorm",
    terminal: false,
    paths: [
      path.join(
        os.homedir(),
        "Library/Application Support/JetBrains/Toolbox/scripts/webstorm",
      ),
      "/usr/local/bin/webstorm",
    ],
  },
  {
    key: "idea",
    name: "IntelliJ IDEA",
    binName: "idea",
    terminal: false,
    paths: [
      path.join(
        os.homedir(),
        "Library/Application Support/JetBrains/Toolbox/scripts/idea",
      ),
      "/usr/local/bin/idea",
    ],
  },
  {
    key: "zed",
    name: "Zed",
    binName: "zed",
    terminal: false,
    paths: [
      "/Applications/Zed.app/Contents/MacOS/cli",
      path.join(os.homedir(), "Applications/Zed.app/Contents/MacOS/cli"),
      "/usr/local/bin/zed",
    ],
  },
  {
    key: "vim",
    name: "vim",
    binName: "vim",
    terminal: true,
    paths: ["/usr/bin/vim", "/opt/homebrew/bin/vim", "/usr/local/bin/vim"],
  },
  {
    key: "nvim",
    name: "Neovim",
    binName: "nvim",
    terminal: true,
    paths: ["/opt/homebrew/bin/nvim", "/usr/local/bin/nvim", "/usr/bin/nvim"],
  },
  {
    key: "emacs",
    name: "Emacs",
    binName: "emacs",
    terminal: true,
    paths: [
      "/Applications/Emacs.app/Contents/MacOS/emacs",
      "/opt/homebrew/bin/emacs",
      "/usr/bin/emacs",
    ],
  },
];

// ── Terminal definitions (macOS) ─────────────────────────────────────────────

interface TerminalDef {
  key: string;
  name: string;
  appName: string;
  appPaths: readonly string[];
}

const KNOWN_TERMINALS: readonly TerminalDef[] = [
  {
    key: "terminal",
    name: "Terminal",
    appName: "Terminal",
    appPaths: ["/System/Applications/Utilities/Terminal.app"],
  },
  {
    key: "iterm2",
    name: "iTerm2",
    appName: "iTerm",
    appPaths: ["/Applications/iTerm.app"],
  },
  {
    key: "ghostty",
    name: "Ghostty",
    appName: "Ghostty",
    appPaths: [
      "/Applications/Ghostty.app",
      path.join(os.homedir(), "Applications/Ghostty.app"),
    ],
  },
  {
    key: "warp",
    name: "Warp",
    appName: "Warp",
    appPaths: ["/Applications/Warp.app"],
  },
  {
    key: "kitty",
    name: "kitty",
    appName: "kitty",
    appPaths: [
      "/Applications/kitty.app",
      path.join(os.homedir(), "Applications/kitty.app"),
    ],
  },
  {
    key: "alacritty",
    name: "Alacritty",
    appName: "Alacritty",
    appPaths: [
      "/Applications/Alacritty.app",
      path.join(os.homedir(), "Applications/Alacritty.app"),
    ],
  },
  {
    key: "hyper",
    name: "Hyper",
    appName: "Hyper",
    appPaths: ["/Applications/Hyper.app"],
  },
];

/** JetBrains editors that open via CLI but need special `--line` arg handling. */
export const JETBRAINS_EDITORS = new Set(["webstorm", "idea"]);

// ── Supported languages for per-language IDE overrides ───────────────────────

export const SUPPORTED_LANGUAGES = [
  { key: "go", name: "Go" },
  { key: "python", name: "Python" },
  { key: "typescript", name: "TypeScript" },
  { key: "javascript", name: "JavaScript" },
  { key: "java", name: "Java" },
  { key: "kotlin", name: "Kotlin" },
  { key: "rust", name: "Rust" },
  { key: "ruby", name: "Ruby" },
  { key: "swift", name: "Swift" },
  { key: "csharp", name: "C#" },
] as const;

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
