import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readSettingsSources,
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
