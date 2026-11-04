#!/usr/bin/env node
/**
 * Journeys shell-denial hook (beforeShellExecution).
 *
 * Referenced from the generated `.cursor/hooks.json` in every journey's
 * staged sandbox cwd (see src/pillars/journeys/sandbox.ts, which copies
 * this file into the staged dir so the path resolves from there). Cursor
 * hooks are fail-open by default; the generating side sets
 * `failClosed: true` so a crash of this script still denies. This script
 * itself denies unconditionally: journey agents interact with the
 * app exclusively through the mounted custom tools — shell is never
 * a legitimate capability.
 *
 * Contract (cursor.com/docs/agent/hooks, verified 2026-07-15):
 *   stdin:  {"command": "<full terminal command>", "cwd": "...", ...}
 *   stdout: {"permission": "allow" | "deny" | "ask",
 *            "user_message": "...", "agent_message": "..."}
 */

"use strict";

function emitDenyAndExit() {
  process.stdout.write(
    JSON.stringify({
      permission: "deny",
      user_message: "Shell execution is disabled for journey agents.",
      agent_message:
        "Shell commands are denied in this sandbox. Use the provided " +
        "journey tools (browser_* / http_request) to accomplish your goal.",
    }),
  );
  process.exit(0);
}

// Drain stdin (the hook input is irrelevant — every command is denied),
// then emit the decision. Any error still ends in a deny.
try {
  process.stdin.resume();
  process.stdin.on("data", () => {});
  process.stdin.on("end", emitDenyAndExit);
  process.stdin.on("error", emitDenyAndExit);
} catch {
  emitDenyAndExit();
}
