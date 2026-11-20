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
    ) as { exports: Record<string, string | Record<string, string>> };
    // The nav inventory (./inventory, its reference files) ships from
    // inventory/, not src/: checked on its own below.
    const srcExports = Object.fromEntries(
      Object.entries(pkg.exports).filter(
        // The marks and the site folder (issue 644) are folders: below.
        ([k]) => !k.startsWith("./inventory") && !k.endsWith("/*"),
      ),
    ) as Record<string, string>;
    const files = fs
      .readdirSync(path.join(PKG, "src"))
      .filter((f) => /\.(js|css)$/.test(f))
      .sort();
    const targets = Object.values(srcExports)
      .map((t) => t.replace(/^\.\/src\//, ""))
      .sort();
    expect(targets).toEqual(files);
    for (const [key, target] of Object.entries(srcExports)) {
      expect(fs.existsSync(path.join(PKG, target))).toBe(true);
      // A .css is exported with its extension; a .js without.
      const base = path.basename(target);
      expect(key).toBe(
        base.endsWith(".css") ? `./${base}` : `./${base.replace(/\.js$/, "")}`,
      );
    }
  });

  it("exports the marks and the site folder (issue 644), each a folder in src/", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PKG, "package.json"), "utf-8"),
    ) as { exports: Record<string, unknown> };
    for (const d of ["marks", "site"]) {
      expect(pkg.exports[`./${d}/*`]).toBe(`./src/${d}/*`);
      expect(fs.statSync(path.join(PKG, "src", d)).isDirectory()).toBe(true);
    }
  });

  it("exports the nav inventory, its types and its reference files", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PKG, "package.json"), "utf-8"),
    ) as {
      exports: Record<string, string | Record<string, string>>;
      files: string[];
    };
    const inv = pkg.exports["./inventory"] as Record<string, string>;
    expect(fs.existsSync(path.join(PKG, inv.default!))).toBe(true);
    expect(fs.existsSync(path.join(PKG, inv.types!))).toBe(true);
    expect(pkg.exports["./inventory/reference/*"]).toBe(
      "./inventory/reference/*",
    );
    expect(pkg.files).toContain("inventory/");
  });
});
