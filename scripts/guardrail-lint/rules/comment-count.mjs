// mo/comment-count: which lines of a file hold a comment that counts. The runner sums them over the files a change
// touched, at its base and at its head, and fails when the sum rises.
// A line counts when its comment has a word in it. These never count: a shebang, a license header (a first comment
// block naming a copyright or a license), and directives to tools (eslint, @ts-, prettier, coverage, mo-lint-ok…).
// JS/TS comments come from the shared scanner, so strings and regexes never count; in Python and shell files, a
// line's own "#" comment.
import { codeOnly } from "./brittle-scan.mjs";

const DIRECTIVE =
  /^\s*(?:eslint(?:-|\s|$)|@ts-|prettier-ignore|istanbul\s|c8\s|v8\s|@jest-environment|<reference\s|global\s|jshint|mo-lint-ok:|@license|@preserve|shellcheck\s|noqa\b|type:\s|pylint:|pyright:|mypy:|-\*-)/i;
const LICENSE = /\b(?:copyright|licen[cs]ed?|spdx-license-identifier)\b/i;

/** The comment's own words: its markers and leading stars taken off. */
const words = (text) => text.replace(/^\s*(?:\/\/+|\/\*+|\*+\/?|#+)?/, "").replace(/\*+\/\s*$/, "");
const counts = (text) => /\w/.test(text) && !DIRECTIVE.test(words(text));

function jsComments(src) {
  const lines = src.split("\n");
  const marks = codeOnly(src).split("\n");
  const rows = lines.map((line, i) => {
    const m = marks[i] ?? "";
    let comment = "";
    let code = "";
    for (let j = 0; j < line.length; j++) {
      if (m[j] === "\u0001") comment += line[j];
      else if (!/\s/.test(line[j])) code += line[j];
    }
    return { comment, code };
  });
  const shebang = lines[0]?.startsWith("#!") ? 1 : 0;
  if (shebang) rows[0] = { comment: "", code: "" };
  // The license header: the first comment lines before any code, skipped whole when they name a license.
  let start = shebang;
  while (start < rows.length && !rows[start].comment && !rows[start].code) start++;
  let end = start;
  while (end < rows.length && rows[end].comment && !rows[end].code) end++;
  const header = rows.slice(start, end).map((r) => r.comment).join("\n");
  const skip = end > start && LICENSE.test(header) ? [start, end] : [0, 0];
  const out = [];
  rows.forEach((r, i) => {
    if (i >= skip[0] && i < skip[1]) return;
    if (r.comment && counts(r.comment)) out.push(i + 1);
  });
  return out;
}

function hashComments(src) {
  const lines = src.split("\n");
  let i = lines[0]?.startsWith("#!") ? 1 : 0;
  const first = i;
  while (i < lines.length && /^\s*#/.test(lines[i])) i++;
  const skip = LICENSE.test(lines.slice(first, i).join("\n")) ? [first, i] : [0, 0];
  const out = [];
  lines.forEach((line, n) => {
    if (n >= skip[0] && n < skip[1]) return;
    const m = /^\s*#(?!!)(.*)$/.exec(line);
    if (m && counts(m[1])) out.push(n + 1);
  });
  return out;
}

/** The line numbers (1-based) of the comment lines that count. */
export const count = (src, path = "") => (/\.(?:py|sh|bash|zsh)$/.test(path) ? hashComments(src) : jsComments(src));
