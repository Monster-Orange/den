import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
