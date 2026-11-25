import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";
import {
  readSettingsSources,
  SETTINGS_PUBLIC,
  settingsFiles,
  stripComments,
} from "./helpers/settings-sources.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-settings-src-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

fs.writeFileSync(
  path.join(dir, "settings-registry.js"),
  '/* id: "in.comment" */\nexport const A = "https://x.test/a"; // id: "trailing"\n',
);
fs.writeFileSync(
  path.join(dir, "settings-rows-more.js"),
  'export const ROWS = [{ id: "from.part" }];\nconst re = /a\\/\\/b/;\nconst t = `x ${"//not"} y`;\n',
);
fs.writeFileSync(path.join(dir, "settings-ui-hub.js"), 'const h = "hub";\n');
fs.writeFileSync(path.join(dir, "settings-page.js"), 'const p = "page";\n');

describe("readSettingsSources", () => {
  it("reads the entry first, then each settings part, never the page", () => {
    expect(settingsFiles(dir)).toEqual([
      "settings-registry.js",
      "settings-rows-more.js",
      "settings-ui-hub.js",
    ]);
    const src = readSettingsSources({ dir });
    expect(src).toContain('id: "from.part"');
    expect(src).toContain('"hub"');
    expect(src).not.toContain('"page"');
  });

  it("leaves out comments, keeps strings, regexes and templates", () => {
    const src = readSettingsSources({ dir });
    expect(src).not.toContain("in.comment");
    expect(src).not.toContain("trailing");
    expect(src).toContain('"https://x.test/a"');
    expect(src).toContain("/a\\/\\/b/");
    expect(src).toContain('`x ${"//not"} y`');
  });

  it("a comment after a plain } is left out, and a template after one stays whole", () => {
    const out = stripComments(
      "const a = { x: 1 };\n// hidden1\nif (x) {}\nconst s = `a // kept ${b} c`;\n/* hidden2 */\n",
    );
    expect(out).not.toContain("hidden1");
    expect(out).not.toContain("hidden2");
    expect(out).toContain("const s = `a // kept ${b} c`;");
  });

  it("nested braces and templates inside a substitution", () => {
    const text =
      "const t = `x ${f({ a: `y ${z} //in` })} w`; // gone\nconst u = 1;\n";
    const out = stripComments(text);
    expect(out).toContain("const t = `x ${f({ a: `y ${z} //in` })} w`;");
    expect(out).not.toContain("gone");
    expect(out).toContain("const u = 1;");
  });

  it("a division is not read as a regex", () => {
    const out = stripComments(
      "const r = a / b; // gone\nconst q = (c) / 2 / d; // also\nconst e = 1;\n",
    );
    expect(out).toContain("const r = a / b;");
    expect(out).toContain("const q = (c) / 2 / d;");
    expect(out).not.toContain("gone");
    expect(out).not.toContain("also");
  });

  it("on the real registry, no whole-line // comment is left", () => {
    const src = readSettingsSources();
    expect(src.split("\n").filter((l) => /^\s*\/\//.test(l))).toEqual([]);
  });

  it("each real settings file, stripped, still parses with every line", () => {
    for (const f of settingsFiles()) {
      const text = fs.readFileSync(path.join(SETTINGS_PUBLIC, f), "utf-8");
      const out = stripComments(text);
      expect(out.split("\n")).toHaveLength(text.split("\n").length);
      const r = ts.transpileModule(out, {
        reportDiagnostics: true,
        compilerOptions: { allowJs: true, module: ts.ModuleKind.ESNext },
        fileName: f,
      });
      expect([f, r.diagnostics?.map((d) => d.messageText) ?? []]).toEqual([
        f,
        [],
      ]);
    }
  });

  it("keeps every line, so line-based matches still line up", () => {
    const text = "a\n/* one\ntwo */\nb // c\n";
    expect(stripComments(text).split("\n")).toHaveLength(
      text.split("\n").length,
    );
  });

  it("with comments: true, the text as written", () => {
    expect(readSettingsSources({ dir, comments: true })).toContain(
      "in.comment",
    );
  });
});
