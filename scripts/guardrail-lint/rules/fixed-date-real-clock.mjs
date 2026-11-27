const ISO = /["'`]20\d\d-\d\d-\d\d(?:[T ][0-9:.]+Z?)?["'`]/;
const REAL = /\bnew Date\(\s*\)|\bDate\.now\(\s*\)/;
const DEADLINE = /\bDate\.now\(\s*\)\s*(?:\+|<=?|>=?)/g;
const FAKE = /useFakeTimers|setSystemTime|mockdate|clock\.install|page\.clock\./;
const CASE = /\b(?:it|test)(?:\.only|\.skip|\.each\([^)]*\))?\(\s*["'`]/g;

function caseBody(src, from) {
  const open = src.indexOf("{", from);
  if (open < 0) return [open, open];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return [open, i + 1];
  }
  return [open, src.length];
}

const lineAt = (src, i) => src.slice(0, i).split("\n").length;

export function check(src) {
  if (FAKE.test(src)) return [];
  const out = [];
  for (const m of src.matchAll(CASE)) {
    const [a, b] = caseBody(src, m.index);
    if (a < 0) continue;
    const body = src.slice(a, b);
    if (ISO.test(body) && REAL.test(body.replace(DEADLINE, ""))) out.push({ line: lineAt(src, m.index), end: lineAt(src, b) });
  }
  return out;
}
