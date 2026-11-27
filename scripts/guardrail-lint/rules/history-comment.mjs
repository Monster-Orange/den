// mo/no-history-comment: a code comment that records history: an issue or PR number, a named person with a date,
// or what the code was before. mo-lint-ok: this line names the phrases the rule looks for ("was X before", "no longer").
// History goes in the commit and the PR; a comment may only state a constraint the code can't show.
// JS/TS comments come from the shared scanner (strings and regexes never count); in Python and shell files,
// a line's "#" comment.
import { codeOnly } from "./brittle-scan.mjs";

const HISTORY = [
  /\b(?:[Ii]ssues?|PRs?|[Pp]ull requests?)\s+#?\d{2,}\b/,
  /(?:^|[\s(])#\d{2,}\b/,
  /\b[\w-]+#\d+\b/,
  // A capitalised name (or role and letter or number) right before a month-day date, so no person is named here.
  /\b[A-Z][a-z]+(?: (?:[A-Z]|\d{1,3}))?[ ,:]+(?:on\s+)?(?:20\d\d-)?1[0-2]-\d{1,2}\b/,
  /\b(?:was|were)\s+[^.]{1,40}?\s+before\b/i,
  /\b(?:used to|previously|no longer|formerly)\b/i,
];

const isHistory = (text) => HISTORY.some((re) => re.test(text));

function jsComments(src) {
  const code = codeOnly(src);
  const lines = src.split("\n");
  const marks = code.split("\n");
  const hits = [];
  lines.forEach((line, i) => {
    const m = marks[i] ?? "";
    let text = "";
    for (let j = 0; j < line.length; j++) if (m[j] === "\u0001") text += line[j];
    if (text && isHistory(text)) hits.push({ line: i + 1, end: i + 1 });
  });
  return hits;
}

function hashComments(src) {
  const hits = [];
  src.split("\n").forEach((line, i) => {
    const m = /^\s*#(?!!)(.*)$/.exec(line);
    if (m && isHistory(m[1])) hits.push({ line: i + 1, end: i + 1 });
  });
  return hits;
}

export const check = (src, path = "") => (/\.(?:py|sh|bash|zsh)$/.test(path) ? hashComments(src) : jsComments(src));
