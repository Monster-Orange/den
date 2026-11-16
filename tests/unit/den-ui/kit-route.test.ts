/**
 * den-ui in Den: Den serves the kit's files at /kit/… from the package in
 * its own install (never a CDN), and every page loads the kit's fonts,
 * tokens and base before the theme, so the theme wins.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  kitAssetFile,
  serveUiAsset,
} from "../../../src/ui/server/ui-assets.js";
import { ROUTES } from "../../../src/ui/server/route-classes.js";

const ROOT = path.join(__dirname, "../../..");
const PUBLIC = path.join(ROOT, "src/ui/server/public");
const KIT = ["/kit/fonts.css", "/kit/tokens.css", "/kit/base.css"];

/** A response that keeps what was written. */
function fakeRes() {
  const r = {
    status: 0,
    headers: {} as Record<string, string>,
    body: Buffer.alloc(0),
    writeHead(s: number, h?: Record<string, string>) {
      r.status = s;
      Object.assign(r.headers, h ?? {});
      return r;
    },
    end(b?: Buffer | string) {
      if (b) r.body = Buffer.from(b);
      return r;
    },
  };
  return r;
}

describe("den-ui at /kit/", () => {
  it("finds the kit's stylesheets and fonts in Den's own install", () => {
    for (const p of [
      ...KIT,
      "/kit/fonts/rubik-latin-400-normal.woff2",
      "/kit/fonts/space-mono-latin-ext-400-normal.woff2",
    ]) {
      const f = kitAssetFile(p);
      expect(f).toBe(path.join(ROOT, "packages/den-ui/src", p.slice(5)));
    }
  });

  it("nothing else: not a path out of the kit, not a file it doesn't name", () => {
    for (const p of [
      "/kit/../package.json",
      "/kit/%2e%2e/package.json",
      "/kit/fonts/../../package.json",
      "/kit/nope.css",
      "/kit/fonts/OFL.txt",
      "/kit/",
      "/kit",
    ])
      expect(kitAssetFile(p)).toBeNull();
  });

  it("serves them with their types; an unknown /kit/ path is a 404", () => {
    const css = fakeRes();
    expect(serveUiAsset(css as never, "/kit/tokens.css", PUBLIC)).toBe(true);
    expect(css.status).toBe(200);
    expect(css.headers["Content-Type"]).toBe("text/css; charset=utf-8");
    expect(css.body.toString()).toContain("--accent-text");
    const font = fakeRes();
    serveUiAsset(
      font as never,
      "/kit/fonts/rubik-latin-500-normal.woff2",
      PUBLIC,
    );
    expect(font.status).toBe(200);
    expect(font.headers["Content-Type"]).toBe("font/woff2");
    expect(font.body.subarray(0, 4).toString()).toBe("wOF2");
    const none = fakeRes();
    expect(serveUiAsset(none as never, "/kit/nope.css", PUBLIC)).toBe(true);
    expect(none.status).toBe(404);
  });

  it("serves the shared update pill, its script and its stylesheet", () => {
    const js = fakeRes();
    serveUiAsset(js as never, "/kit/update-pill.js", PUBLIC);
    expect(js.status).toBe(200);
    expect(js.headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
    expect(js.body.toString()).toContain("export function showUpdate");
    const css = fakeRes();
    serveUiAsset(css as never, "/kit/update-pill.css", PUBLIC);
    expect(css.status).toBe(200);
    expect(css.headers["Content-Type"]).toBe("text/css; charset=utf-8");
    expect(css.body.toString()).toContain(".den-upd .upd-pill");
  });

  it("is a page file in the route list", () => {
    expect(ROUTES.some((r) => r.path === "/kit/*")).toBe(true);
  });

  it("every page loads the kit's fonts, tokens and base, in that order, before the theme", () => {
    const pages = fs
      .readdirSync(PUBLIC)
      .filter((f) => f.endsWith(".html"))
      .filter((f) =>
        fs.readFileSync(path.join(PUBLIC, f), "utf-8").includes("/theme.css"),
      );
    expect(pages.length).toBeGreaterThan(5);
    const wrong = pages.filter((f) => {
      const html = fs.readFileSync(path.join(PUBLIC, f), "utf-8");
      const at = [...KIT, "/theme.css"].map((h) => html.indexOf(`href="${h}"`));
      return at.some((i) => i < 0) || at.some((i, k) => k && i < at[k - 1]);
    });
    expect(wrong).toEqual([]);
  });

  it("ships inside Den's own package", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
    ) as { files: string[]; workspaces?: string[] };
    expect(pkg.files).toContain("packages/den-ui/");
    expect(pkg.workspaces).toEqual(["packages/*"]);
  });
});
