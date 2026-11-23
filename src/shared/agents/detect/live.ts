/**
 * Issue 770: which rule sets Den reads live agents' screens with, and how
 * a session's raw output becomes the screen the engine reads.
 *
 * Each runtime is switched on in its own slice, once its rules are checked
 * against a real session: add its rule-set name (a catalog entry's
 * `screenRules`) here. Claude stays off: its hooks say more, exactly.
 */
import { oscTitles } from "../transcript-follow.js";
import { screenText } from "../trust-prompt.js";
import type { Screen } from "./engine.js";

export type { Screen } from "./engine.js";

/** The rule sets whose readings Den shows today. */
export const LIVE_SCREEN_RULES: ReadonlySet<string> = new Set(["codex"]);

/** How much of a session's output Den reads for its screen. */
export const SCREEN_TAIL_BYTES = 16 * 1024;

/**
 * A session's output tail as the engine reads it: drawn on a grid (moves,
 * erases and clears applied), rows right-trimmed, blank rows at the end
 * dropped, and the latest OSC 0/2 title.
 */
export function screenOf(output: string): Screen {
  const rows = screenText(output)
    .split("\n")
    .map((l) => l.trimEnd());
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  const { titles } = oscTitles(output, "");
  const title = titles.at(-1);
  return {
    text: rows.length ? `${rows.join("\n")}\n` : "",
    ...(title ? { oscTitle: title } : {}),
  };
}
