import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ts from "typescript";
import {
  AGENTS_ENTRY,
  AGENTS_PUBLIC,
  agentsFiles,
  agentsSource,
  strayParts,
  withoutComments,
} from "./helpers/agents-source.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-agents-source-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);

describe("agentsSource: the agents page's code, as source-text tests read it", () => {
  write(
    "agents-page.js",
    [
      "/** Calls /in-doc-comment. */",
      'import { a } from "/agents-core.js";',
      'import { b } from "/agents-section.js";',
      '// import { c } from "/agents-commented.js";',
      'export const url = "/in-entry"; // /in-line-comment',
    ].join("\n"),
  );
  write(
    "agents-core.js",
    'import "/agents-rows.js";\nexport const a = "/in-core";',
  );
  write(
    "agents-rows.js",
    'import "/agents-core.js";\nexport const r = `/in-rows${1}`;',
  );
  write("agents-section.js", 'export const b = "/in-section";');
  write("agents-commented.js", 'export const c = "/in-commented";');

  it("follows the entry's /agents-*.js imports, once each, cycles included", () => {
    expect(agentsFiles(dir)).toEqual([
      "agents-page.js",
      "agents-core.js",
      "agents-rows.js",
      "agents-section.js",
    ]);
  });

  it("a marker only in a comment, or in a file no part imports, isn't there", () => {
    const src = agentsSource(dir);
    for (const m of ["/in-entry", "/in-core", "/in-rows"])
      expect(src).toContain(m);
    for (const m of ["/in-doc-comment", "/in-line-comment", "/in-commented"])
      expect(src).not.toContain(m);
  });

  it("keeps strings, templates and regexes that look like comments", () => {
    const code = [
      'const u = "http://x/*y*/";',
      "const t = `a ${'//'} b`;",
      "const r = /\\/\\/[/*]/g; // gone",
    ].join("\n");
    expect(withoutComments(code)).toBe(
      [
        'const u = "http://x/*y*/";',
        "const t = `a ${'//'} b`;",
        "const r = /\\/\\/[/*]/g; ",
      ].join("\n"),
    );
  });

  it("the real page: its lines kept, its doc comment gone, its calls there", () => {
    const real = fs.readFileSync(
      path.join(AGENTS_PUBLIC, AGENTS_ENTRY),
      "utf-8",
    );
    const code = withoutComments(real);
    expect(code.split("\n").length).toBe(real.split("\n").length);
    expect(code.length).toBeLessThan(real.length);
    expect(agentsSource()).toContain("/sessions");
  });
});

describe("agentsSource's edges", () => {
  const edge = fs.mkdtempSync(path.join(os.tmpdir(), "den-agents-edge-"));
  afterAll(() => fs.rmSync(edge, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(edge, "agents-page.js"),
    [
      'const late = () => import("/agents-late.js");',
      'const named = "/agents-stray.js";',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(edge, "agents-late.js"),
    'export const l = "/in-late";',
  );

  it("follows a part loaded with import()", () => {
    expect(agentsFiles(edge)).toEqual(["agents-page.js", "agents-late.js"]);
    expect(agentsSource(edge)).toContain("/in-late");
  });

  it("names a part the code mentions but never imports", () => {
    expect(strayParts(edge)).toEqual(["agents-stray.js"]);
  });

  it("the real page names no part it doesn't import", () => {
    expect(strayParts()).toEqual([]);
  });

  it("after a keyword, a slash starts a regex, so a quote in it opens no string", () => {
    const code = [
      "function f(s) {",
      '  return /"/.test(s); // a',
      "}",
      "const k = typeof /'/; // b",
      "const v = void /`/; // c",
    ].join("\n");
    expect(withoutComments(code)).toBe(
      [
        "function f(s) {",
        '  return /"/.test(s); ',
        "}",
        "const k = typeof /'/; ",
        "const v = void /`/; ",
      ].join("\n"),
    );
  });

  it("a regex holding //, a template holding a string, a comment across lines", () => {
    const code = [
      "const r = /a\\/\\/b/;",
      'const t = `x ${"}`"} y`;',
      "/* one",
      "   two */ const z = 1;",
    ].join("\n");
    expect(withoutComments(code)).toBe(
      [
        "const r = /a\\/\\/b/;",
        'const t = `x ${"}`"} y`;',
        "",
        " const z = 1;",
      ].join("\n"),
    );
  });
});

const ENTRY_IMPORT =
  /(?:^|[;\s])(?:import|export)\b[^;]*?["']\/agents-page\.js["']|\bimport\s*\(\s*["']\/agents-page\.js["']/m;
const importsEntry = (code: string) => ENTRY_IMPORT.test(withoutComments(code));

describe("the agents page's parts never import its entry", () => {
  it("finds a static, re-export or dynamic import of the entry, not a comment", () => {
    expect(importsEntry('import { st } from "/agents-page.js";')).toBe(true);
    expect(importsEntry('export { st } from "/agents-page.js";')).toBe(true);
    expect(importsEntry('const m = await import("/agents-page.js");')).toBe(true);
    expect(importsEntry('import "/agents-page.js";')).toBe(true);
    expect(importsEntry('// import { st } from "/agents-page.js";')).toBe(false);
    expect(importsEntry('const href = "/agents-page.js";')).toBe(false);
  });

  it("no part the real page loads imports agents-page.js", () => {
    const parts = agentsFiles().filter((f) => f !== AGENTS_ENTRY);
    expect(parts.length).toBeGreaterThan(0);
    const bad = parts.filter((f) =>
      importsEntry(fs.readFileSync(path.join(AGENTS_PUBLIC, f), "utf-8")),
    );
    expect(bad).toEqual([]);
  });
});

describe("the entry adds the stale-pick listeners, once each", () => {
  const added = (code: string, type: string) =>
    code.split(`addEventListener("${type}", dropStalePick, true)`).length - 1;

  it("pointerdown and keydown, in agents-page.js and in no part", () => {
    const entry = withoutComments(
      fs.readFileSync(path.join(AGENTS_PUBLIC, AGENTS_ENTRY), "utf-8"),
    );
    const all = agentsSource();
    for (const type of ["pointerdown", "keydown"]) {
      expect(added(entry, type)).toBe(1);
      expect(added(all, type)).toBe(1);
    }
  });
});

function importedWrites(code: string): string[] {
  const sf = ts.createSourceFile("part.js", code, ts.ScriptTarget.Latest, true);
  const imported = new Set<string>();
  for (const st of sf.statements)
    if (ts.isImportDeclaration(st))
      st.importClause?.namedBindings &&
        ts.isNamedImports(st.importClause.namedBindings) &&
        st.importClause.namedBindings.elements.forEach((e) =>
          imported.add(e.name.text),
        );
  const shadowed = (id: ts.Identifier) => {
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      const local = (d: ts.Node) =>
        (ts.isVariableDeclaration(d) || ts.isParameter(d)) &&
        ts.isIdentifier(d.name) &&
        d.name.text === id.text;
      if (ts.isFunctionLike(n) && n.parameters.some(local)) return true;
      if (ts.isBlock(n) || ts.isSourceFile(n))
        for (const st of n.statements)
          if (
            ts.isVariableStatement(st) &&
            st.declarationList.declarations.some(local) &&
            !ts.isSourceFile(n)
          )
            return true;
    }
    return false;
  };
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    let target: ts.Expression | undefined;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      target = n.left;
    else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken ||
        n.operator === ts.SyntaxKind.MinusMinusToken)
    )
      target = n.operand;
    if (
      target &&
      ts.isIdentifier(target) &&
      imported.has(target.text) &&
      !shadowed(target)
    )
      out.push(target.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("no agents-page module assigns a name it imports", () => {
  it("finds =, op= and ++ on an import, not on a local of the same name", () => {
    const head = 'import { a, b, c } from "/agents-core.js";\n';
    expect(importedWrites(head + "function f() { a = 1; }")).toEqual(["a"]);
    expect(importedWrites(head + "b += 2; c++;")).toEqual(["b", "c"]);
    expect(importedWrites(head + "function f(a) { a = 1; }")).toEqual([]);
    expect(importedWrites(head + "function f() { let b; b = 1; }")).toEqual([]);
    expect(importedWrites(head + "const o = {}; o.a = 1;")).toEqual([]);
  });

  it("the real page and its parts write only their own top-level names", () => {
    const bad = agentsFiles().flatMap((f) =>
      importedWrites(
        fs.readFileSync(path.join(AGENTS_PUBLIC, f), "utf-8"),
      ).map((n) => `${f}: ${n}`),
    );
    expect(bad).toEqual([]);
  });
});
