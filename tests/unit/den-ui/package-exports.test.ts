/**
 * The UI kit's package exports every file a page imports from src/: a
 * consumer of the published package reaches each one by its subpath
 * (`@monster-orange/den-ui/busy`, `…/tokens.css`), never only by Den's
 * own /kit/ route. A new src/ file without an export fails here.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PKG = path.join(process.cwd(), "packages", "den-ui");

describe("den-ui package exports", () => {
  it("exports every .js and .css in src/, each to its own file", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PKG, "package.json"), "utf-8"),
    ) as { exports: Record<string, string> };
    const files = fs
      .readdirSync(path.join(PKG, "src"))
      .filter((f) => /\.(js|css)$/.test(f))
      .sort();
    const targets = Object.values(pkg.exports)
      .map((t) => t.replace(/^\.\/src\//, ""))
      .sort();
    expect(targets).toEqual(files);
    for (const [key, target] of Object.entries(pkg.exports)) {
      expect(fs.existsSync(path.join(PKG, target))).toBe(true);
      // A .css is exported with its extension; a .js without.
      const base = path.basename(target);
      expect(key).toBe(
        base.endsWith(".css") ? `./${base}` : `./${base.replace(/\.js$/, "")}`,
      );
    }
  });
});
