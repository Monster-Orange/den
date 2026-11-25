// The scanner from Den's scripts/brittle-ratchet.mjs (copied at Den next/queue, 11-24), shared by the brittle
// browser-test rules: mo/no-fixed-sleep, and later mo/no-positional-locator and mo/no-class-selector.
// scan(src) gives each kind's lines: sleeps, positional, classSelectors, englishAsserts. Strings, templates,
// regexes and comments are blanked first, so a pattern inside text or a comment never counts.
// Plain Node, no imports. Keep in step with Den's copy until Den uses this one (lint doc section 5).
export const KINDS = [
  "sleeps",
  "positional",
  "classSelectors",
  "englishAsserts",
];

const ADVICE = {
  sleeps:
    "wait for a state instead: await expect(locator).toBeVisible(), " +
    "expect.poll(…), page.waitForFunction(…) or waitForResponse(…)",
  positional:
    "pick by what the row is, not where it sits: getByRole(role, { name }), " +
    "getByLabel(…), a data-* attribute, or locator.filter({ hasText })",
  classSelectors:
    "use a role or label finder (getByRole, getByLabel) or a data-* " +
    "attribute or id the page keeps for tests, not a styling class",
  englishAsserts:
    "assert on state (a data-* value, a count, an aria-* attribute) or the " +
    "i18n key's text, not a literal English sentence",
};

// ---------------------------------------------------------------- scanning

/**
 * Blanks the inside of string, template and regex literals with spaces,
 * and comments with "\u0001" (newlines kept), so offsets line up with the
 * source. Code
 * patterns are searched in this text; a literal's own text is read from
 * the source at the same offset.
 */
export function codeOnly(src) {
  const out = src.split("");
  const blank = (a, b, ch = " ") => {
    for (let i = a; i < b; i++) if (out[i] !== "\n") out[i] = ch;
  };
  let i = 0;
  const n = src.length;
  const tmplDepth = []; // brace depth at each open ${ in a template
  let braces = 0;
  let lastSig = ""; // last significant code char, for regex detection
  const readString = (q, from) => {
    let j = from + 1;
    while (j < n && src[j] !== q && src[j] !== "\n") {
      if (src[j] === "\\") j++;
      j++;
    }
    return j; // at the closing quote (or end of line)
  };
  const readTemplate = (from) => {
    // from: index after ` or after a } closing ${…}; returns [end, opened]
    let j = from;
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") return [j, false];
      else if (src[j] === "$" && src[j + 1] === "{") return [j, true];
      else j++;
    }
    return [n, false];
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      blank(i, end, "\u0001");
      i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end, "\u0001");
      i = end;
    } else if (c === '"' || c === "'") {
      const e = readString(c, i);
      blank(i + 1, e);
      i = e + 1;
      lastSig = c;
    } else if (c === "`") {
      const [e, opened] = readTemplate(i + 1);
      blank(i + 1, e);
      if (opened) {
        tmplDepth.push(braces);
        i = e + 2;
        lastSig = "{";
      } else {
        i = e + 1;
        lastSig = "`";
      }
    } else if (
      c === "/" &&
      (lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig))
    ) {
      // A regex literal.
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      lastSig = "/";
    } else if (c === "{") {
      braces++;
      lastSig = c;
      i++;
    } else if (c === "}") {
      if (tmplDepth.length && tmplDepth[tmplDepth.length - 1] === braces) {
        tmplDepth.pop();
        const [e, opened] = readTemplate(i + 1);
        blank(i + 1, e);
        if (opened) {
          tmplDepth.push(braces);
          i = e + 2;
          lastSig = "{";
        } else {
          i = e + 1;
          lastSig = "`";
        }
      } else {
        braces--;
        lastSig = c;
        i++;
      }
    } else {
      if (!/\s/.test(c)) {
        // Identifier/number ends: a "/" after it is division.
        lastSig = /[\w$)\]]/.test(c) ? "a" : c;
      }
      i++;
    }
  }
  return out.join("");
}

/** The literal starting at `at` in src ("…", '…', `…` or /…/): [text, kind]. */
function literalAt(src, at) {
  const q = src[at];
  if (q !== '"' && q !== "'" && q !== "`" && q !== "/") return null;
  let j = at + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === "\\") j++;
    if (q !== "`" && src[j] === "\n") return null;
    j++;
  }
  return [src.slice(at + 1, j), q];
}

const lineOf = (starts, idx) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

const num = (s) => Number(String(s).replace(/_/g, ""));

/** A selector string with a .class token (attribute values and quoted parts ignored). */
export function hasClassToken(sel) {
  const s = sel
    .replace(/\$\{[^}]*\}/g, "x")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/"[^"]*"|'[^']*'/g, "");
  return (
    /(?:^|[\s>+~,(*\w\])])\.[A-Za-z_-][\w-]*/.test(s) &&
    !/^\s*\.\/|^\.\.?$/.test(s)
  );
}

/** Plain English: words of letters, `min` of them or more, nothing code-like. */
export function isEnglish(text, min = 2) {
  const t = text.trim();
  if (!t || /[/\\=<>{}[\]_$#@|`*^]/.test(t)) return false;
  if (/^[\w.-]+$/.test(t) && !/\s/.test(t) && min > 1) return false;
  const words = t
    .split(/\s+/)
    .filter((w) => /^[("']?[A-Za-z][a-z'’]*[A-Za-z]?[)"'.,:;!?…]*$/.test(w));
  const longWords = words.filter((w) => /[A-Za-z]{2,}/.test(w));
  return words.length >= min && longWords.length >= 1;
}

const SELECTOR_CALLS =
  /(?:\.|\b)(locator|\$\$?|\$\$?eval|waitForSelector|querySelector(?:All)?|closest|matches|click|dblclick|hover|fill|check|textContent|innerText|isVisible)\s*\([\s\u0001]*/g;
const ASSERT_CALLS =
  /\.(toBe|toEqual|toStrictEqual|toContain|toMatch|toHaveText|toContainText)\s*\([\s\u0001]*/g;
const LIST_INDEX =
  /(?<![\w$.])(?:rows|lines|cells|items|cols|columns|parts|boxes|els|elements|nodes|buttons|btns|links|tabs|cards|options|texts|labels|words|fields|out|output|stdout)\s*\[\s*\d+\s*\]/g;
const TEXT_FINDERS = /\b(getByText)\s*\([\s\u0001]*/g;

/** Counts each kind in one file's source: { kind: [line, …] }. */
export function scan(src) {
  const code = codeOnly(src);
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  const hits = Object.fromEntries(KINDS.map((k) => [k, []]));
  const add = (kind, idx) => hits[kind].push(lineOf(starts, idx));
  let m;

  // Sleeps.
  for (m of code.matchAll(/\bwaitForTimeout\s*\(/g)) add("sleeps", m.index);
  for (m of code.matchAll(
    /\bnew\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*setTimeout\s*\(\s*\1\s*,\s*([\d_]+)\s*\)/g,
  ))
    if (num(m[2]) >= 100) add("sleeps", m.index);
  for (m of code.matchAll(
    /\bawait\s+(?:setTimeout|sleep|delay|wait|pause)\s*\(\s*([\d_]+)\s*[,)]/g,
  ))
    if (num(m[1]) >= 100) add("sleeps", m.index);

  // Positional picks.
  for (m of code.matchAll(/\.(?:nth\s*\(|(?:first|last)\s*\(\s*\))/g))
    add("positional", m.index);
  for (m of src.matchAll(
    /:(?:nth-child|nth-of-type|nth-last-child|first-child|last-child|first-of-type|last-of-type)\b/g,
  ))
    if (code[m.index] === " ") add("positional", m.index); // in a string
  for (m of code.matchAll(/\)\s*\[\s*\d+\s*\]/g)) {
    // Walk back to the call's "(" and read the name before it.
    let depth = 0;
    let j = m.index;
    for (; j >= 0; j--) {
      if (code[j] === ")") depth++;
      else if (code[j] === "(" && --depth === 0) break;
    }
    const name = /([\w$]+)\s*$/.exec(code.slice(Math.max(0, j - 40), j));
    if (name && /^(match|exec|matchAll|if|while|for)$/.test(name[1])) continue;
    add("positional", m.index);
  }
  // A list of rows, lines or elements read by position (a name that says
  // so; other arrays, like a live check's clause names, don't count).
  for (m of code.matchAll(LIST_INDEX)) add("positional", m.index);

  // Raw class selectors.
  for (m of code.matchAll(SELECTOR_CALLS)) {
    const at = m.index + m[0].length;
    const lit = literalAt(src, at);
    if (lit && lit[1] !== "/" && hasClassToken(lit[0]))
      add("classSelectors", m.index);
  }

  // English-text asserts.
  for (m of code.matchAll(ASSERT_CALLS)) {
    const at = m.index + m[0].length;
    const lit = literalAt(src, at);
    if (!lit) continue;
    let text = lit[0];
    if (lit[1] === "/")
      text = text.replace(/\\b|\\s\+?|\^|\$/g, " ").replace(/\\(.)/g, "$1");
    if (lit[1] === "`" && text.includes("${")) continue;
    if (isEnglish(text, 2)) add("englishAsserts", m.index);
  }
  for (m of code.matchAll(TEXT_FINDERS)) {
    const at = m.index + m[0].length;
    const lit = literalAt(src, at);
    if (
      lit &&
      isEnglish(lit[1] === "/" ? lit[0].replace(/\\./g, "") : lit[0], 1)
    )
      add("englishAsserts", m.index);
  }
  for (const k of KINDS) hits[k].sort((a, b) => a - b);
  return hits;
}
