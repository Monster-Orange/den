/**
 * The editors and terminals Den knows, and the languages an editor may be
 * set per (issue 1391: shared, so the CLI's setting_change checks keys
 * without importing the server's editor manager).
 */
import * as os from "os";
import * as path from "path";

// ── Editor definitions ───────────────────────────────────────────────────────

export interface EditorDef {
  key: string;
  name: string;
  /** Binary name for `which` fallback (may differ from key). */
  binName: string;
  terminal: boolean;
  paths: readonly string[];
}

export const KNOWN_EDITORS: readonly EditorDef[] = [
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

export interface TerminalDef {
  key: string;
  name: string;
  appName: string;
  appPaths: readonly string[];
}

export const KNOWN_TERMINALS: readonly TerminalDef[] = [
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

/** Issue 1391: whether `key` is an editor Den knows (Settings' check). */
export function isKnownEditorKey(key: string): boolean {
  return KNOWN_EDITORS.some((e) => e.key === key);
}

/** Issue 1391: whether `key` is a terminal Den knows (Settings' check). */
export function isKnownTerminalKey(key: string): boolean {
  return KNOWN_TERMINALS.some((t) => t.key === key);
}

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
