/**
 * Issue 322: the raw-colour checks (ui-color-tokens.test.ts, the kit's
 * tokens.test.ts) share one reading of a file's text. A `#` and 3, 4, 6
 * or 8 hex digits is a colour, wherever it is (code, CSS, a string, a
 * comment), with one exception: inside a comment, `#` and digits only,
 * right after "issue", "(" or the start of the comment's text, is an
 * issue number ("issue #320", "(#311)", "// #320: …").
 *
 * Decided (the issue asked for it in writing): a colour in a comment that
 * isn't an issue number still counts, e.g. `/* was #fff *\/`. An old
 * value left in a comment is copied back into code; keep it out.
 */

/** #rgb, #rgba, #rrggbb, #rrggbbaa; not an HTML entity (&#9654;) or an id. */
export const HEX =
  /(?<![&\w])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;

/** Comments: CSS/JS block, HTML, and JS line (never a URL's `://`). */
const COMMENT = /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(?<![:\w"'`\\/])\/\/[^\n]*/g;

function commentRanges(text: string): [number, number][] {
  return [...text.matchAll(COMMENT)].map((m) => [
    m.index!,
    m.index! + m[0].length,
  ]);
}

/** Whether the `#digits` at `at`, in the comment starting at `from`, is an issue number. */
function issueNumber(text: string, at: number, from: number, hex: string) {
  if (!/^#\d+$/.test(hex)) return false;
  // What comes before it in the comment, its opener and any leading `*`
  // of a block comment's line taken off.
  const before = text
    .slice(from, at)
    .replace(/^(?:\/\*+|<!--|\/\/+)/, "")
    .split("\n")
    .pop()!
    .replace(/^\s*\*?/, "")
    .trimEnd();
  return before === "" || before.endsWith("(") || /\bissue$/i.test(before);
}

/** Every colour literal in `text`: its 1-based line and the literal. */
export function colourLiterals(text: string): { line: number; hex: string }[] {
  const ranges = commentRanges(text);
  const out: { line: number; hex: string }[] = [];
  for (const m of text.matchAll(HEX)) {
    const at = m.index!;
    const c = ranges.find(([a, b]) => at >= a && at < b);
    if (c && issueNumber(text, at, c[0], m[0])) continue;
    out.push({ line: text.slice(0, at).split("\n").length, hex: m[0] });
  }
  return out;
}
