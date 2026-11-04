import * as fs from "fs";
import { execFileSync } from "child_process";

import { product } from "../product.js";
export type TerminalApp = "iterm2" | "terminal";

export interface OpenTabOptions {
  cmd: string;
  cwd: string;
  label?: string;
  terminalApp?: TerminalApp;
  /**
   * Variables to export in the tab before running `cmd`. A tab is a fresh
   * login shell, so den-resolved values (the org config's service_env) are only
   * present if we put them there — without them a consumer repo silently falls
   * back to its `../<repo>` sibling default and fails in a nested checkout.
   *
   * Keep this to non-secret values: it lands in the tab's shell history.
   */
  env?: Record<string, string>;
}

export interface OpenedTab {
  terminalApp: TerminalApp;
  tabId: string;
}

const APPLE_TERMINAL_APP = fs.existsSync(
  "/System/Applications/Utilities/Terminal.app",
)
  ? "/System/Applications/Utilities/Terminal.app"
  : "Terminal";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function automationHelp(appName: string): string {
  return (
    `Could not automate ${appName}. ` +
    `Allow ${product().title}/your terminal to control Terminal, iTerm, and System Events in ` +
    "System Settings > Privacy & Security > Automation."
  );
}

function runAppleScript(script: string, appName: string): string {
  try {
    return execFileSync("osascript", ["-e", script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr =
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? ((error as { stderr: string }).stderr ?? "")
        : "";
    const message = stderr.trim() || (error as Error).message;
    throw new Error(`${automationHelp(appName)} ${message}`.trim());
  }
}

function buildTabCommand(opts: OpenTabOptions): string {
  const exports = Object.entries(opts.env ?? {})
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  const prefix = exports.length > 0 ? `${exports.join(" ")} && ` : "";
  return `${prefix}cd ${shellQuote(opts.cwd)} && ${opts.cmd}`;
}

function openITermTab(command: string): OpenedTab {
  const script = `
tell application "iTerm"
  activate
  if (count of windows) = 0 then
    set newWindow to (create window with default profile)
    set newTab to current tab of newWindow
  else
    tell current window
      set newTab to (create tab with default profile)
    end tell
  end if
  tell current session of newTab
    write text ${appleScriptString(command)}
  end tell
  return (id of current session of newTab as text)
end tell
`;
  return { terminalApp: "iterm2", tabId: runAppleScript(script, "iTerm2") };
}

function openAppleTerminalTab(command: string): OpenedTab {
  const script = `
tell application ${appleScriptString(APPLE_TERMINAL_APP)}
  activate
  if not (exists front window) then
    do script ""
  end if
end tell
delay 0.1
tell application "System Events"
  tell process "Terminal"
    keystroke "t" using command down
  end tell
end tell
delay 0.1
tell application ${appleScriptString(APPLE_TERMINAL_APP)}
  do script ${appleScriptString(command)} in selected tab of front window
  return tty of selected tab of front window
end tell
`;
  return {
    terminalApp: "terminal",
    tabId: runAppleScript(script, "Apple Terminal"),
  };
}

export function openTab(opts: OpenTabOptions): OpenedTab {
  const terminalApp = opts.terminalApp ?? detectDefaultTerminalApp();
  const command = buildTabCommand(opts);
  if (terminalApp === "iterm2") return openITermTab(command);
  return openAppleTerminalTab(command);
}

export function closeTab(tabId: string, terminalApp: TerminalApp): void {
  if (terminalApp === "iterm2") {
    const script = `
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      if (id of current session of t as text) is ${appleScriptString(tabId)} then
        close t
        return "closed"
      end if
    end repeat
  end repeat
end tell
return "missing"
`;
    runAppleScript(script, "iTerm2");
    return;
  }

  const script = `
tell application ${appleScriptString(APPLE_TERMINAL_APP)}
  repeat with w in windows
    repeat with t in tabs of w
      try
        if (tty of t) is ${appleScriptString(tabId)} then
          close t
          return "closed"
        end if
      end try
    end repeat
  end repeat
end tell
return "missing"
`;
  runAppleScript(script, "Apple Terminal");
}

export function tabExists(tabId: string, terminalApp: TerminalApp): boolean {
  if (terminalApp === "iterm2") {
    const script = `
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      if (id of current session of t as text) is ${appleScriptString(tabId)} then return "yes"
    end repeat
  end repeat
end tell
return "no"
`;
    return runAppleScript(script, "iTerm2") === "yes";
  }

  const script = `
tell application ${appleScriptString(APPLE_TERMINAL_APP)}
  repeat with w in windows
    repeat with t in tabs of w
      try
        if (tty of t) is ${appleScriptString(tabId)} then return "yes"
      end try
    end repeat
  end repeat
end tell
return "no"
`;
  return runAppleScript(script, "Apple Terminal") === "yes";
}

export function resolveTerminalApp(key: string | undefined): TerminalApp {
  if (!key) return detectDefaultTerminalApp();
  if (key === "iterm2") return "iterm2";
  if (key === "terminal") return "terminal";
  if (key === "ghostty") {
    throw new Error(
      `Tab mode does not support Ghostty yet. Set \`${product().cli} config terminal=iterm2\`, \`${product().cli} config terminal=terminal\`, or run with \`--no-tabs\`.`,
    );
  }
  throw new Error(
    `Tab mode only supports iTerm2 and Apple Terminal. Configured terminal "${key}" is not supported; run with --no-tabs to use daemon mode.`,
  );
}

function detectDefaultTerminalApp(): TerminalApp {
  if (fs.existsSync("/Applications/iTerm.app")) return "iterm2";
  return "terminal";
}
