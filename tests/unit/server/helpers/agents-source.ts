/**
 * The agents page's code for tests that read its text: the entry and every
 * /agents-*.js part it imports, joined, with comments removed.
 */
import * as fs from "fs";
import * as path from "path";

export const AGENTS_PUBLIC = path.join(
  process.cwd(),
  "src",
  "ui",
  "server",
  "public",
);
export const AGENTS_ENTRY = "agents-page.js";

const AFTER_REGEX_START = /[(,=:[!&|?{};+\-*%<>~^]/;
const KEYWORD_BEFORE =
  /(?:^|[^\w$])(?:return|typeof|case|in|of|void|throw|yield|await|delete|instanceof|new|else|do)\s*$/;

export function withoutComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const templateBraces: number[] = [];
  let braces = 0;
  let lastSig = "";
  const copyTo = (end: number) => {
    out += src.slice(i, end);
    i = end;
  };
  const stringEnd = (q: string, from: number) => {
    let j = from + 1;
    while (j < n && src[j] !== q && src[j] !== "\n")
      j += src[j] === "\\" ? 2 : 1;
    return Math.min(j + 1, n);
  };
  const templateEnd = (from: number): [number, boolean] => {
    let j = from;
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "`") return [j + 1, false];
      else if (src[j] === "$" && src[j + 1] === "{") return [j + 2, true];
      else j++;
    }
    return [n, false];
  };
  const template = (from: number) => {
    const [end, opened] = templateEnd(from);
    copyTo(end);
    if (opened) templateBraces.push(braces);
    lastSig = opened ? "{" : "`";
  };
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      out += src.slice(i, end).replace(/[^\n]/g, "");
      i = end;
    } else if (c === '"' || c === "'") {
      copyTo(stringEnd(c, i));
      lastSig = c;
    } else if (c === "`") {
      template(i + 1);
    } else if (
      c === "/" &&
      (lastSig === "" ||
        AFTER_REGEX_START.test(lastSig) ||
        (lastSig === "a" && KEYWORD_BEFORE.test(out.slice(-16))))
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      copyTo(Math.min(j + 1, n));
      lastSig = "/";
    } else if (c === "}" && templateBraces.at(-1) === braces) {
      templateBraces.pop();
      template(i + 1);
    } else {
      if (c === "{") braces++;
      if (c === "}") braces--;
      if (!/\s/.test(c)) lastSig = /[\w$)\]]/.test(c) ? "a" : c;
      copyTo(i + 1);
    }
  }
  return out;
}

function partImports(code: string): string[] {
  return [
    ...code.matchAll(
      /^\s*(?:import|export)\b[^;]*?\bfrom\s+"\/(agents-[a-z0-9-]+\.js)"/gm,
    ),
    ...code.matchAll(/^\s*import\s+"\/(agents-[a-z0-9-]+\.js)"/gm),
    ...code.matchAll(/\bimport\s*\(\s*"\/(agents-[a-z0-9-]+\.js)"\s*\)/g),
  ].map((m) => m[1]!);
}

export function agentsFiles(dir = AGENTS_PUBLIC): string[] {
  const seen: string[] = [];
  const visit = (f: string) => {
    if (seen.includes(f)) return;
    seen.push(f);
    const code = withoutComments(fs.readFileSync(path.join(dir, f), "utf-8"));
    for (const g of partImports(code)) visit(g);
  };
  visit(AGENTS_ENTRY);
  return seen;
}

export function agentsSource(dir = AGENTS_PUBLIC): string {
  return agentsFiles(dir)
    .map((f) => withoutComments(fs.readFileSync(path.join(dir, f), "utf-8")))
    .join("\n");
}

export function strayParts(dir = AGENTS_PUBLIC): string[] {
  const parts = agentsFiles(dir);
  const named = [
    ...agentsSource(dir).matchAll(/["'`]\/(agents-[a-z0-9-]+\.js)["'`]/g),
  ].map((m) => m[1]!);
  return [...new Set(named)].filter((f) => !parts.includes(f));
}
