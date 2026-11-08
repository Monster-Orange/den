/**
 * The hand-back check: is a hand-back to a person complete and plain?
 * `<cli> agents handback-check <file|->` runs it, and so does the Stop hook
 * Den gives default-pack personas (guardrails/stop-hook.ts). The template
 * is in guardrails/instructions.md:
 *
 *   ## Hand-back
 *   - URL: <the link to open>
 *   - Machine: <the machine it runs on>
 *   - Branch: <the branch>
 *   - What changed: <what is different now>
 *   - What to click: <the steps to see it>
 *   - Decisions:
 *     1. <a yes/no question>?
 *
 * It rejects a hand-back when:
 *
 * 1. A part is missing or empty. A part is a line that starts with its
 *    label and a colon (`URL:`, `- **Branch:** …`) or a heading that is its
 *    label (`### What changed`). Its content is the rest of the line and
 *    the lines after it, up to the next part. URL must hold a link (`://`)
 *    or say `none` (work with no page), optionally with a reason.
 *    Decisions may say `none`.
 * 2. It has a bare ID. An ID is `#<digits>` or 1-4 capitals, an optional
 *    `-`, digits and an optional `.<digits>` (`R12`, `AG-14`, `KB-4.1`).
 *    URLs, `inline code` and code blocks, and the URL and Branch parts are
 *    not scanned: they are literal. An ID is glossed (not bare) when:
 *      a. a parenthetical of at least two words follows it:
 *         `#5 (the hooks issue)`;
 *      b. a colon or dash, then at least two words, follows it:
 *         `R12: plain writing`, `R12 - plain writing`;
 *      c. it sits inside a parenthetical right after a word, and that
 *         parenthetical holds no other words: `plain writing (R12)`,
 *         `the issues (#5, #6)`;
 *      d. or the same ID was glossed earlier in the text.
 *    A word is a run of letters (an ID is not a word).
 * 3. A decision isn't a numbered yes/no question. Each item under
 *    Decisions must be numbered (`1.` or `1)`), end in `?`, not start
 *    with a question word (what, which, how, why, when, where, who), and
 *    not offer a choice (` or `).
 */

export const HANDBACK_PARTS = [
  "URL",
  "Machine",
  "Branch",
  "What changed",
  "What to click",
  "Decisions",
] as const;
export type HandbackPart = (typeof HANDBACK_PARTS)[number];

export interface HandbackResult {
  ok: boolean;
  /** One line each, plain, naming what to fix. */
  problems: string[];
}

/** The ID patterns the check looks for. */
export const ID_PATTERNS = [/#\d+/g, /\b[A-Z]{1,4}-?\d+(?:\.\d+)?\b/g];

const LABEL = new RegExp(
  `^\\s*(?:[-*+]\\s+)?(#{1,6}\\s+)?(?:\\*\\*|__)?(${HANDBACK_PARTS.map((p) =>
    p.replace(/ /g, "\\s+"),
  ).join("|")})(?:\\*\\*|__)?\\s*(:)?(?:\\*\\*|__)?\\s*(.*)$`,
  "i",
);

/** The hand-back's heading, which marks a message as one. */
export const HANDBACK_HEADING = /^\s*#{1,6}\s*hand-?\s?back\b/im;

/** Does this message present itself as a hand-back (its heading)? */
export function looksLikeHandback(text: string): boolean {
  return HANDBACK_HEADING.test(text);
}

interface Parts {
  found: Map<HandbackPart, string[]>;
  /** Line numbers (0-based) of the URL and Branch parts' content. */
  literal: Set<number>;
}

function canonical(label: string): HandbackPart {
  const l = label.replace(/\s+/g, " ").toLowerCase();
  return HANDBACK_PARTS.find((p) => p.toLowerCase() === l)!;
}

function splitParts(lines: string[]): Parts {
  const found = new Map<HandbackPart, string[]>();
  const literal = new Set<number>();
  let cur: HandbackPart | null = null;
  let fence = false;
  lines.forEach((line, n) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : LABEL.exec(line);
    // A label needs a colon, or to be the whole heading.
    if (m && (m[3] || (m[1] && !m[4].trim()))) {
      cur = canonical(m[2]);
      const body = m[4].trim();
      found.set(cur, body ? [body] : []);
      if (cur === "URL" || cur === "Branch") literal.add(n);
      return;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      cur = null;
      return;
    }
    if (!cur) return;
    if (line.trim()) found.get(cur)!.push(line.trim());
    if (cur === "URL" || cur === "Branch") literal.add(n);
  });
  return { found, literal };
}

/** Text with URLs and code replaced by spaces (offsets kept). */
function prose(line: string): string {
  const blank = (s: string) => " ".repeat(s.length);
  return line
    .replace(/`[^`]*`/g, blank)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank)
    .replace(/\bwww\.\S+/gi, blank);
}

const WORD = /[A-Za-z][A-Za-z'’]*(?:-[A-Za-z]+)*/g;

/** Words in s: runs of letters, once the IDs are taken out. */
function wordCount(s: string): number {
  let t = s;
  for (const re of ID_PATTERNS) t = t.replace(new RegExp(re.source, "g"), " ");
  return (t.match(WORD) ?? []).length;
}

/** Is the ID at [start, end) in this line glossed (rules a-c)? */
export function isGlossed(line: string, start: number, end: number): boolean {
  const after = line.slice(end);
  // a. "(two or more words)" right after.
  const paren = /^\s*\(([^)]*)\)/.exec(after);
  if (paren && wordCount(paren[1]) >= 2) return true;
  // b. ": two words" or " - two words" right after.
  const colon = /^\s*(?::|\s[-–—])\s*(.*)$/.exec(after);
  if (colon && wordCount(colon[1].split(/[.;!?]/)[0]) >= 2) return true;
  // c. inside "(…)" right after a word, the parenthetical only IDs.
  const open = line.lastIndexOf("(", start);
  const close = line.indexOf(")", end);
  if (open >= 0 && close >= 0 && line.slice(open, start).indexOf(")") < 0) {
    const inside = line.slice(open + 1, close);
    const before = line.slice(0, open);
    if (wordCount(inside) === 0 && /[A-Za-z][A-Za-z'’]*\s*$/.test(before))
      return true;
  }
  return false;
}

/**
 * The ID-shaped words in names Den itself gives (the product's title, the
 * workspace): a Den named "den-t2" is "Den T2", and its agent says so.
 * They are names, not IDs to explain.
 */
export function idsInNames(names: readonly (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const n of names)
    for (const re of ID_PATTERNS)
      for (const m of String(n ?? "").matchAll(new RegExp(re.source, "g")))
        out.add(m[0]);
  return [...out];
}

/** Bare IDs in the text, in order, each once. `known` are names, never bare. */
export function bareIds(
  text: string,
  skipLines: Set<number> = new Set(),
  known: ReadonlySet<string> = new Set(),
): string[] {
  const glossed = new Set<string>();
  const bare: string[] = [];
  let fence = false;
  text.split(/\r?\n/).forEach((raw, n) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      return;
    }
    if (fence || skipLines.has(n)) return;
    const line = prose(raw);
    const hits: { id: string; start: number; end: number }[] = [];
    for (const re of ID_PATTERNS)
      for (const m of line.matchAll(new RegExp(re.source, "g")))
        hits.push({ id: m[0], start: m.index!, end: m.index! + m[0].length });
    hits.sort((a, b) => a.start - b.start);
    for (const h of hits) {
      if (glossed.has(h.id) || known.has(h.id)) continue;
      if (isGlossed(line, h.start, h.end)) glossed.add(h.id);
      else if (!bare.includes(h.id)) bare.push(h.id);
    }
  });
  return bare;
}

const QUESTION_WORD = /^(what|which|how|why|when|where|who|whom|whose)\b/i;

/** Problems with the Decisions part's items. */
function decisionProblems(items: string[]): string[] {
  if (items.length === 1 && /^(none|no decisions?|nothing)\.?$/i.test(items[0]))
    return [];
  if (!items.length)
    return [
      "Decisions is empty. List each as a numbered yes/no question, or say none.",
    ];
  const out: string[] = [];
  for (const it of items) {
    const m = /^(\d+)[.)]\s+(.*)$/.exec(it);
    const q = (m ? m[2] : it.replace(/^[-*+]\s+/, "")).trim();
    const show = q.length > 60 ? `${q.slice(0, 57)}...` : q;
    if (!m)
      out.push(`Decision "${show}" is not numbered. Number it: 1., 2., …`);
    else if (!q.endsWith("?"))
      out.push(`Decision "${show}" is not a question. End it with "?".`);
    else if (QUESTION_WORD.test(q) || /\sor\s/i.test(q))
      out.push(
        `Decision "${show}" is not a yes/no question. Ask it so yes or no answers it.`,
      );
  }
  return out;
}

/** Check a hand-back. Pure: the text in, the problems out. */
export function checkHandback(
  text: string,
  known: ReadonlySet<string> = new Set(),
): HandbackResult {
  const lines = String(text ?? "").split(/\r?\n/);
  const { found, literal } = splitParts(lines);
  const problems: string[] = [];
  for (const part of HANDBACK_PARTS) {
    const body = found.get(part);
    if (body === undefined) {
      problems.push(`Missing "${part}:". Add it.`);
      continue;
    }
    if (part === "Decisions") {
      problems.push(...decisionProblems(body));
      continue;
    }
    if (!body.join(" ").trim())
      problems.push(`"${part}:" is empty. Fill it in.`);
    else if (
      part === "URL" &&
      !body.join(" ").includes("://") &&
      !/^\s*none\b/i.test(body.join(" "))
    )
      problems.push(
        `"URL:" has no link. Give the full address, with http:// or https://, or say none if this work has no page.`,
      );
  }
  for (const id of bareIds(lines.join("\n"), literal, known))
    problems.push(
      `"${id}" is not explained. Say what it is, e.g. "${id} (what it is)".`,
    );
  return { ok: problems.length === 0, problems };
}
