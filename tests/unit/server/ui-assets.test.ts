/**
 * Vendored browser libraries (the graph's ELK layout) are served by Den's own
 * server from node_modules, never a CDN, so the UI works offline. npm hoists
 * Den's dependencies into a distribution's node_modules, so the lookup walks
 * up from the engine root.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  UI_MODULES,
  VENDOR_ASSETS,
  vendorAssetFile,
} from "../../../src/ui/server/ui-assets.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-vendor-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("vendorAssetFile", () => {
  it("serves elkjs's bundled build at /vendor/elk.bundled.js", () => {
    expect(VENDOR_ASSETS["/vendor/elk.bundled.js"]).toBe(
      "elkjs/lib/elk.bundled.js",
    );
  });

  it("finds a hoisted dependency above the engine root (a packed install)", () => {
    const dist = path.join(tmp, "acme");
    const engine = path.join(dist, "node_modules", "@monster-orange", "den");
    fs.mkdirSync(engine, { recursive: true });
    const lib = path.join(dist, "node_modules", "elkjs", "lib");
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, "elk.bundled.js"), "// elk");
    expect(vendorAssetFile("/vendor/elk.bundled.js", engine)).toBe(
      path.join(lib, "elk.bundled.js"),
    );
  });

  it("finds it in Den's own checkout", () => {
    const file = vendorAssetFile("/vendor/elk.bundled.js");
    expect(file).not.toBeNull();
    expect(fs.readFileSync(file!, "utf-8")).toMatch(/ELK/);
  });

  it("serves xterm.js and its fit addon (the Agents tab's panes, AG-4a-term) from Den's own dependencies, MIT", () => {
    for (const [url, rel] of [
      ["/vendor/xterm.mjs", "@xterm/xterm/lib/xterm.mjs"],
      ["/vendor/xterm.css", "@xterm/xterm/css/xterm.css"],
      ["/vendor/addon-fit.mjs", "@xterm/addon-fit/lib/addon-fit.mjs"],
    ]) {
      expect(VENDOR_ASSETS[url]).toBe(rel);
      expect(vendorAssetFile(url)).not.toBeNull();
    }
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
      dependencies: Record<string, string>;
    };
    // Pinned, exact: the served bytes change only with Den itself.
    expect(pkg.dependencies["@xterm/xterm"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@xterm/addon-fit"]).toMatch(/^\d+\.\d+\.\d+$/);
    for (const name of ["@xterm/xterm", "@xterm/addon-fit"])
      expect(
        (
          JSON.parse(
            fs.readFileSync(`node_modules/${name}/package.json`, "utf-8"),
          ) as { license: string }
        ).license,
      ).toBe("MIT");
    // An ES module with no import of its own: it loads offline as it is.
    expect(
      fs.readFileSync(vendorAssetFile("/vendor/xterm.mjs")!, "utf-8"),
    ).not.toMatch(/^\s*import\s/m);
  });

  it("returns null for a path that is not a vendored asset, or not installed", () => {
    expect(vendorAssetFile("/vendor/../package.json")).toBeNull();
    expect(vendorAssetFile("/vendor/elk.bundled.js", "/")).toBeNull();
  });
});

describe("UI_MODULES", () => {
  it("names the graph's static modules, each a file in public/", () => {
    expect(UI_MODULES).toEqual(
      expect.arrayContaining([
        "/graph.js",
        "/graph-model.js",
        "/panel.js",
        "/graph.css",
      ]),
    );
    const pub = path.resolve("src/ui/server/public");
    for (const m of UI_MODULES) expect(fs.existsSync(pub + m)).toBe(true);
  });
});
