/**
 * Raster marks and the theme favicon (0.3.0-dev.22) on the theme routes:
 * /theme/<id>/<file> serves a PNG or WebP mark with its type, and only the
 * files the manifest names; /theme-favicon/<id>?mode= serves the theme's
 * tab icon for a mode (its `favicon`, else its mark's file, the dark
 * variant in dark mode, else Den's own icon); /api/themes gives the
 * versioned favicon URL per mode.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { AppearancePrefs } from "../../../src/ui/server/appearance-prefs.js";
import {
  handleThemeRoutes,
  type ThemeRouteDeps,
} from "../../../src/ui/server/theme-routes.js";
import {
  resetThemeWarnings,
  type ThemeRoots,
} from "../../../src/ui/server/theme-runtime.js";
import { png, webp } from "../../fixtures/images.js";

const ENGINE = process.cwd();
const DEN_DIR = path.join(ENGINE, "themes", "den");
const DEN_ICON = path.join(
  ENGINE,
  "src",
  "ui",
  "server",
  "public",
  "favicon.ico",
);

let tmp: string;
let roots: ThemeRoots;
let server: http.Server;
let port: number;
let prefs: AppearancePrefs = { theme: null, mode: "system" };

const PNG = png(48, 48, { rgba: [10, 120, 200, 255] });
const PNG_DARK = png(48, 48, { rgba: [240, 200, 20, 255] });
const WEBP = webp(64, 64);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
const SVG_DARK =
  '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>';

/** A copy of den as plugins/<id>/ with its mark (and files) replaced. */
function plugin(
  id: string,
  mark: Record<string, string>,
  files: Record<string, string | Buffer>,
  favicon?: string,
) {
  const dir = path.join(roots.distRoot, "plugins", id);
  fs.cpSync(DEN_DIR, dir, { recursive: true });
  const file = path.join(dir, "den-theme.json");
  const m = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
    string,
    unknown
  >;
  Object.assign(m, { id, name: id.toUpperCase(), mark });
  delete m.favicon;
  if (favicon) m.favicon = favicon;
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
  for (const [f, c] of Object.entries(files))
    fs.writeFileSync(path.join(dir, f), c);
}

const get = (p: string) =>
  new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }>((resolve, reject) =>
    http
      .get({ host: "localhost", port, path: p }, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts),
          }),
        );
      })
      .on("error", reject),
  );

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-theme-raster-"));
  fs.mkdirSync(path.join(tmp, "dist", "plugins"), { recursive: true });
  roots = { distRoot: path.join(tmp, "dist"), engineRoot: ENGINE };
  plugin(
    "pix",
    { png: "mark.png", png_dark: "mark-dark.png", shape: "circle" },
    { "mark.png": PNG, "mark-dark.png": PNG_DARK, "other.png": PNG },
  );
  plugin("wbp", { webp: "mark.webp" }, { "mark.webp": WEBP });
  plugin(
    "vec",
    { svg: "mark.svg", svg_dark: "mark-dark.svg", shape: "rounded" },
    { "mark.svg": SVG, "mark-dark.svg": SVG_DARK },
  );
  plugin("txt", { text: "T" }, {});
  plugin(
    "tab",
    { png: "mark.png" },
    { "mark.png": PNG, "tab.png": PNG_DARK },
    "tab.png",
  );
  resetThemeWarnings();
  const deps: ThemeRouteDeps = {
    roots: () => roots,
    prefs: () => prefs,
    distributionTheme: () => null,
    warn: () => {},
  };
  server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (!handleThemeRoutes(req, res, pathname, deps)) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("raster marks on /theme/<id>/<file>", () => {
  it("serves a PNG and a WebP mark with image/png and image/webp, and no raster the manifest does not name", async () => {
    for (const [p, type, bytes] of [
      ["/theme/pix/mark.png", "image/png", PNG],
      ["/theme/pix/mark-dark.png", "image/png", PNG_DARK],
      ["/theme/wbp/mark.webp", "image/webp", WEBP],
    ] as const) {
      const r = await get(p);
      expect({ p, status: r.status, type: r.headers["content-type"] }).toEqual({
        p,
        status: 200,
        type,
      });
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.body.equals(bytes)).toBe(true);
    }
    for (const p of [
      "/theme/pix/other.png",
      "/theme/pix/tab.png",
      "/theme/wbp/mark.png",
      "/theme/pix/den-theme.json",
    ])
      expect([p, (await get(p)).status]).toEqual([p, 404]);
  });

  it("/api/themes gives the raster mark's URLs", async () => {
    prefs = { theme: "pix", mode: "system" };
    const a = JSON.parse((await get("/api/themes")).body.toString()).active;
    expect(a.mark).toMatchObject({
      svg: null,
      png: "/theme/pix/mark.png",
      png_dark: "/theme/pix/mark-dark.png",
      webp: null,
      shape: "circle",
    });
  });
});

describe("/theme-favicon/<id>", () => {
  const fav = async (id: string, mode: string) => {
    const r = await get(`/theme-favicon/${id}?mode=${mode}&v=x`);
    return { status: r.status, type: r.headers["content-type"], body: r.body };
  };

  it("is the theme's mark per mode: the dark variant in dark, the base file in light", async () => {
    expect(await fav("vec", "light")).toEqual({
      status: 200,
      type: "image/svg+xml",
      body: Buffer.from(SVG),
    });
    expect(await fav("vec", "dark")).toEqual({
      status: 200,
      type: "image/svg+xml",
      body: Buffer.from(SVG_DARK),
    });
    expect(await fav("pix", "light")).toEqual({
      status: 200,
      type: "image/png",
      body: PNG,
    });
    expect(await fav("pix", "dark")).toEqual({
      status: 200,
      type: "image/png",
      body: PNG_DARK,
    });
    // No dark variant: the base file in both modes.
    expect((await fav("wbp", "dark")).type).toBe("image/webp");
  });

  it("is the manifest's favicon in both modes when it gives one (den's is its .ico)", async () => {
    for (const mode of ["light", "dark"]) {
      expect(await fav("tab", mode)).toEqual({
        status: 200,
        type: "image/png",
        body: PNG_DARK,
      });
      const d = await fav("den", mode);
      expect([d.status, d.type]).toEqual([200, "image/x-icon"]);
    }
  });

  it("is Den's own icon for a text mark, and 404 for a theme that is not there", async () => {
    const t = await fav("txt", "dark");
    expect([t.status, t.type]).toEqual([200, "image/x-icon"]);
    expect(t.body.equals(fs.readFileSync(DEN_ICON))).toBe(true);
    for (const id of ["nope", "..", "%2e%2e", "Den"])
      expect([id, (await fav(id, "light")).status]).toEqual([id, 404]);
  });

  it("bare /theme-favicon is the active theme's, never cached", async () => {
    prefs = { theme: "pix", mode: "system" };
    const r = await get("/theme-favicon?mode=dark");
    expect([
      r.status,
      r.headers["content-type"],
      r.headers["cache-control"],
    ]).toEqual([200, "image/png", "no-store"]);
    expect(r.body.equals(PNG_DARK)).toBe(true);
  });

  it("/api/themes gives a favicon URL per mode carrying the id, the version, the mode and a content hash", async () => {
    const urls: Record<string, { light: string; dark: string }> = {};
    for (const id of ["den", "vec", "pix", "txt"]) {
      prefs = { theme: id, mode: "system" };
      urls[id] = JSON.parse(
        (await get("/api/themes")).body.toString(),
      ).active.favicon;
    }
    for (const [id, u] of Object.entries(urls))
      for (const mode of ["light", "dark"] as const)
        expect(u[mode]).toMatch(
          new RegExp(
            `^/theme-favicon/${id}\\?mode=${mode}&v=\\d+\\.\\d+\\.\\d+-[0-9a-f]{10}$`,
          ),
        );
    // A dark variant is another file: another hash.
    expect(urls.vec.light.split("v=")[1]).not.toBe(
      urls.vec.dark.split("v=")[1],
    );
    // Each URL serves what it names.
    expect((await get(urls.vec.dark)).body.toString()).toBe(SVG_DARK);
    expect((await get(urls.pix.light)).headers["content-type"]).toBe(
      "image/png",
    );
  });
});
