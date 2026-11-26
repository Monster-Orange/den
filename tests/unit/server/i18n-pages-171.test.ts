/**
 * den#171: Edge, Tests, Release, Logs, Environments and Services read in
 * the page's language. The pseudo-locale lint (i18n-pages.browser.test.ts)
 * needs a browser and sees only what the demo draws; this reads each
 * page's source instead, so a literal on a path the demo never takes (an
 * error line, an empty state) fails here too.
 *
 * What counts as a word people read:
 *   - the page's static markup (outside <head>, <script> and <style>): a
 *     text node not under data-t, and a title, aria-label, placeholder or
 *     alt not named in data-t-attr;
 *   - in its scripts (read by the TypeScript parser): an HTML fragment's
 *     text and those attributes, and a plain string that reads as prose
 *     (two words, or a capitalised word). A lowercase single word is a
 *     value (a state, a class), not a message.
 * Strings handed to t(), compared, used as keys, or given to the DOM's and
 * the network's own calls are code, not words.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";
import { enCatalog } from "./helpers/en-catalog.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

/** Each page, and the modules of its own that draw it. */
const PAGES: Record<string, string[]> = {
  Edge: ["edge.html", "edge-page.js"],
  Tests: ["index.html", "perf-report.js"],
  Release: ["release.html", "view-scope.js"],
  Logs: ["logs.html"],
  Environments: ["environments.html", "view-scope.js"],
  Services: ["services.html", "svc-panel.js"],
  // Issue 806: Projects' Add Service dialog.
  "Add Service": ["add-service.js"],
};

/**
 * Shown by their own names in every language: tools and formats, units,
 * keys on the keyboard, and the names the build fills in. Taken out before
 * the words are looked for.
 */
const NAMES = [
  "__DEN_CLI__",
  "__DEN_TITLE__",
  // Tools, formats and protocols.
  "Den",
  "git",
  "npm",
  "Docker",
  "GitHub",
  "Traefik",
  "mkcert",
  "TLS",
  "CA",
  "URL",
  "URLs",
  "HTTP",
  "http",
  "https",
  "SSE",
  "JSON",
  "YAML",
  "API",
  "ID",
  "OK",
  // Units.
  "ms",
  "KB",
  "MB",
  "GB",
  // Keys.
  "Enter",
  "Esc",
  "Shift",
  "Tab",
  "Ctrl",
  "Cmd",
];

/** Calls whose string arguments are code: lookups, selectors, events, I/O. */
const CODE_CALLS = new Set([
  "t",
  "tr",
  "tt",
  "T",
  "querySelector",
  "querySelectorAll",
  "getElementById",
  "closest",
  "matches",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "getAttribute",
  "setAttribute",
  "removeAttribute",
  "hasAttribute",
  "toggleAttribute",
  "createElement",
  "add",
  "remove",
  "toggle",
  "contains",
  "fetch",
  "api",
  "get",
  "set",
  "has",
  "delete",
  "append",
  "getItem",
  "setItem",
  "removeItem",
  "matchMedia",
  "startsWith",
  "endsWith",
  "includes",
  "indexOf",
  "split",
  "join",
  "replace",
  "replaceAll",
  "test",
  "match",
  "RegExp",
  "URL",
  "URLSearchParams",
  "EventSource",
  "WebSocket",
  "log",
  "warn",
  "error",
  "debug",
  "info",
  "busyAction",
  "postMessage",
  "pushState",
  "replaceState",
  "insertAdjacentHTML",
  "scrollIntoView",
  "toLocaleString",
  "toLocaleTimeString",
  "toLocaleDateString",
  "DateTimeFormat",
  "NumberFormat",
  "padStart",
  "localeCompare",
  "Event",
  "CustomEvent",
  // The native dialogs on Projects and Services are their own item
  // (den#133): they become the shell's own dialogs there.
  "confirm",
  "prompt",
  "alert",
]);

/** Properties a person reads: any word assigned to one is a message. */
const SHOWN_PROPS = new Set([
  "textContent",
  "title",
  "placeholder",
  "innerText",
]);

/** Properties whose strings are code: classes, ids, links, styles. */
const CODE_PROPS = new Set([
  "className",
  "id",
  "href",
  "src",
  "type",
  "name",
  "cssText",
  "method",
]);

/** A text with names, placeholders, paths, URLs and code taken out. */
function bare(s: string): string {
  let r = s
    .replace(/&[a-z]+;|&#\d+;/g, " ")
    .replace(/\{\w+\}/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\S+/g, " ")
    .replace(/(\/[\w.@~*-]+)+\/?/g, " ");
  for (const n of NAMES)
    r = r.replace(new RegExp(`(^|[^\\w-])${n}(?![\\w-])`, "g"), "$1 ");
  return r;
}
const words = (s: string) => /[A-Za-z]{2,}/.test(bare(s));
const prose = (s: string) => {
  const b = bare(s).trim();
  if (!/[A-Za-z]{2,}/.test(b)) return false;
  // CSS, selectors and identifiers.
  if (/[{};]|^[.#[:@]|^--\w|^[\w-]+\(|=>|^[\w.-]+=/.test(b)) return false;
  // A media query: "(max-width: 639px)".
  if (/^\([\w-]+:/.test(b)) return false;
  // A class list: lowercase names, one with a hyphen.
  if (/-/.test(b) && b.split(/\s+/).every((w) => /^[a-z0-9_-]*$/.test(w)))
    return false;
  return (
    /[A-Za-z]{2,}[^\s]*\s+[^\s]*[A-Za-z]{2,}/.test(b) ||
    // "Ports", "✕ Close", "filter…"
    /^[^\w\s]*\s*[A-Z][a-z]/.test(b) ||
    /[A-Za-z]{2,}…$/.test(b)
  );
};

/** Elements whose text is code or data, not words (as the browser lint). */
const RAW = /^<(code|kbd|pre|samp)\b|\stranslate="no"/i;

/**
 * The words an HTML fragment shows: text outside tags (not under a RAW
 * element) and the attributes people read. A template's pieces come
 * joined with "{x}" for each `${…}`; one may start inside a tag (its first
 * ">" before any "<").
 */
function fragmentWords(html: string): string[] {
  const out: string[] = [];
  const lt = html.indexOf("<");
  const gt = html.indexOf(">");
  let i = 0;
  if (gt !== -1 && (lt === -1 || gt < lt)) {
    attrWords(html.slice(0, gt), out);
    i = gt + 1;
  }
  const open: boolean[] = [];
  while (i < html.length) {
    const next = html.indexOf("<", i);
    const text = html.slice(i, next === -1 ? html.length : next);
    if (!open.some(Boolean) && words(text)) out.push(text.trim());
    if (next === -1) break;
    const close = html.indexOf(">", next);
    const tag = html.slice(next, close === -1 ? html.length : close + 1);
    attrWords(tag, out);
    if (/^<\//.test(tag)) open.pop();
    else if (!/\/>$|^<(br|hr|img|input|meta|link|wbr)\b/i.test(tag))
      open.push(RAW.test(tag));
    if (close === -1) break;
    i = close + 1;
  }
  return out;
}

/** A tag's title, aria-label, placeholder and alt (none under translate="no"). */
function attrWords(tag: string, out: string[]): void {
  if (/\stranslate="no"/i.test(tag)) return;
  for (const m of tag.matchAll(
    /(?:^|\s)(?:title|aria-label|placeholder|alt)\s*=\s*"([^"]*)"/gi,
  ))
    if (words(m[1])) out.push(m[1]);
}

const calleeName = (e: ts.Expression): string =>
  ts.isIdentifier(e)
    ? e.text
    : ts.isPropertyAccessExpression(e)
      ? e.name.text
      : ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)
        ? calleeName(e.expression)
        : "";

/** Whether a literal is assigned straight to a property a person reads. */
function shown(n: ts.Node): boolean {
  let p = n.parent;
  while (
    p &&
    (ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p))
  )
    p = p.parent;
  return (
    !!p &&
    ts.isBinaryExpression(p) &&
    p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(p.left) &&
    SHOWN_PROPS.has(p.left.name.text)
  );
}

/** Whether a literal sits where strings are code. */
function isCode(n: ts.Node): boolean {
  let p = n.parent;
  let child: ts.Node = n;
  // Climb through templates and string-building to the use.
  while (
    p &&
    (ts.isTemplateSpan(p) ||
      ts.isTemplateExpression(p) ||
      ts.isParenthesizedExpression(p) ||
      (ts.isBinaryExpression(p) &&
        p.operatorToken.kind === ts.SyntaxKind.PlusToken))
  ) {
    child = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (ts.isElementAccessExpression(p)) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isPropertyAssignment(p) && p.name === child) return true;
  if (ts.isBinaryExpression(p)) {
    const k = p.operatorToken.kind;
    if (
      k === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(p.left) &&
      CODE_PROPS.has(p.left.name.text)
    )
      return true;
    if (
      k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      k === ts.SyntaxKind.EqualsEqualsToken ||
      k === ts.SyntaxKind.ExclamationEqualsToken ||
      k === ts.SyntaxKind.InKeyword
    )
      return true;
  }
  if (
    (ts.isCallExpression(p) || ts.isNewExpression(p)) &&
    p.expression !== child
  )
    return CODE_CALLS.has(calleeName(p.expression));
  if (ts.isTaggedTemplateExpression(p)) return true;
  return false;
}

/**
 * The words a script's literals show; with `first` (the script's first
 * line in its file), each says its line.
 */
function scriptWords(src: string, file: string, first?: number): string[] {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found: string[] = [];
  const at = (n: ts.Node) =>
    first === undefined
      ? ""
      : `${sf.getLineAndCharacterOfPosition(n.getStart()).line + first}: `;
  let where = "";
  const out = {
    push: (...xs: string[]) => found.push(...xs.map((x) => where + x)),
  };
  const take = (n: ts.Node, text: string) => {
    if (isCode(n)) return;
    where = at(n);
    if (/[<>]/.test(text)) out.push(...fragmentWords(text));
    else if (prose(text) || (shown(n) && words(text))) out.push(text.trim());
  };
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      take(n, n.text);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      // Each piece on its own: the page's own fragments split by ${…}.
      const anyTag = [n.head, ...n.templateSpans.map((s) => s.literal)].some(
        (l) => /[<>]/.test(l.text),
      );
      if (!isCode(n)) {
        where = at(n);
        const whole = [n.head, ...n.templateSpans.map((s) => s.literal)]
          .map((l) => l.text)
          .join("{x}");
        if (anyTag) out.push(...fragmentWords(whole));
        else if (prose(whole) || (shown(n) && words(whole)))
          out.push(whole.trim());
      }
      n.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/**
 * The words a page's static markup shows; with `lines`, each says its
 * line. Scripts, styles and comments are blanked line for line.
 */
function markupWords(html: string, lines = false): string[] {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  const from = html.search(/<body[\s>]/);
  const first = html.slice(0, from).split("\n").length;
  const body = html
    .slice(from)
    .replace(/<script\b[\s\S]*?<\/script>/gi, blank)
    .replace(/<style\b[\s\S]*?<\/style>/gi, blank)
    .replace(/<\/?template\b[^>]*>/gi, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
  const found: string[] = [];
  let where = "";
  const out = { push: (x: string) => found.push(where + x) };
  let open = "";
  for (const m of body.matchAll(/<[^>]+>|[^<]+/g)) {
    const tok = m[0];
    if (lines) {
      const lead = tok.length - tok.trimStart().length;
      where = `${body.slice(0, m.index! + lead).split("\n").length + first - 1}: `;
    }
    if (tok.startsWith("<")) {
      if (!tok.startsWith("</")) {
        open = tok;
        const tAttr = /data-t-attr="([^"]*)"/.exec(tok)?.[1] ?? "";
        for (const a of tok.matchAll(
          /\s(title|aria-label|placeholder|alt)\s*=\s*"([^"]*)"/gi,
        ))
          if (words(a[2]) && !tAttr.includes(`${a[1]}:`)) out.push(a[2]);
      }
      continue;
    }
    if (words(tok) && !/\sdata-t="/.test(open) && !RAW.test(open))
      out.push(tok.trim());
  }
  return found;
}

/** Every English literal a page's sources show. */
function literals(file: string): string[] {
  const src = read(file);
  if (file.endsWith(".js")) return scriptWords(src, file, 1);
  const out = markupWords(src, true);
  const from = src.search(/<body[\s>]/);
  for (const m of src
    .slice(from)
    .matchAll(/(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)<\/script>/gi)) {
    const at = from + m.index! + m[1].length;
    out.push(...scriptWords(m[2], file, src.slice(0, at).split("\n").length));
  }
  return out;
}

describe("den#171: no English literal on these pages", () => {
  // i18n.test.ts holds every key the .js modules look up to en; the pages'
  // inline scripts and data-t keys are held here.
  it("every key these pages look up is in en", () => {
    const en = enCatalog();
    const keys = new Set<string>();
    for (const f of new Set(Object.values(PAGES).flat())) {
      const src = read(f);
      for (const m of src.matchAll(/\bt\(\s*"([\w.]+)"/g)) keys.add(m[1]);
      for (const m of src.matchAll(/data-t="([\w.-]+)"/g)) keys.add(m[1]);
      for (const m of src.matchAll(/data-t-attr="([^"]+)"/g))
        for (const pair of m[1].split(/\s+/)) keys.add(pair.split(":")[1]);
    }
    expect(keys.size).toBeGreaterThan(250);
    expect([...keys].filter((k) => !(k in en))).toEqual([]);
  });

  it.each(Object.keys(PAGES))("%s", (page) => {
    const found = PAGES[page].flatMap((f) =>
      literals(f).map((s) => `${f}: ${s.replace(/\s+/g, " ").slice(0, 100)}`),
    );
    expect(found).toEqual([]);
  });
});

describe("the check itself", () => {
  it("sees a fragment's text, an attribute, a prose string, and not code", () => {
    const src = [
      'el.innerHTML = `<p class="x">No routes.</p>`;',
      'b.title = "Open the log";',
      'const s = `<button title="Stop it">${t("k")}</button>`;',
      'if (st === "not running") x();',
      'document.querySelector(".a b");',
      'const v = t("edge.title");',
      'const state = "running";',
      'btn.textContent = "search";',
    ].join("\n");
    expect(scriptWords(src, "x.js")).toEqual([
      "No routes.",
      "Open the log",
      "Stop it",
      "search",
    ]);
    expect(
      markupWords(
        '<body><h1>Edge</h1><p data-t="k">Fine</p><input placeholder="Filter" data-t-attr="placeholder:k"><b title="Hi there">x</b></body>',
      ),
    ).toEqual(["Edge", "Hi there"]);
  });
});
