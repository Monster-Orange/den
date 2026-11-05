/**
 * The browser tab follows the theme, and a raster mark is drawn in the top
 * bar (0.3.0-dev.22), against a real server on a fixture distribution with
 * two local themes (an SVG mark with a dark variant, a PNG mark with a dark
 * variant), in a real browser, driven through the ◐ menu.
 *
 * - the page's one icon link is the active theme's, per mode: den's .ico,
 *   then the SVG theme's (image/svg+xml), then the PNG theme's
 *   (image/png); each switch is a new URL;
 * - in light the base file, in dark the dark variant; switching modes
 *   (also System following the OS) changes the href;
 * - a PNG mark is an <img> at the bar's 22px, clipped to its shape, the
 *   dark file in dark mode;
 * - below 480px the brand shows only its mark, and the link keeps its name.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import type { Browser, Page } from "playwright";
import { png } from "../../fixtures/images.js";

const ENGINE = process.cwd();
const PORT = 25876 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
let tmp: string;
let dist: string;
let server: ChildProcess | null = null;
let browser: Browser | null = null;

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#336699"/></svg>';
const SVG_DARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="4" fill="#ffcc00"/></svg>';
const PNG = png(48, 48, { rgba: [20, 110, 190, 255] });
const PNG_DARK = png(48, 48, { rgba: [250, 190, 40, 255] });

function get(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE}${p}`, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

/** plugins/<id>/: den's manifest with this mark and no favicon of its own. */
function theme(
  id: string,
  mark: Record<string, string>,
  files: Record<string, string | Buffer>,
) {
  const dir = path.join(dist, "plugins", id);
  fs.mkdirSync(dir, { recursive: true });
  const m = JSON.parse(
    fs.readFileSync(
      path.join(ENGINE, "themes", "den", "den-theme.json"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
  Object.assign(m, { id, name: id.toUpperCase(), version: "1.2.3", mark });
  delete m.favicon;
  delete m.homepage;
  fs.writeFileSync(path.join(dir, "den-theme.json"), JSON.stringify(m));
  for (const [f, c] of Object.entries(files))
    fs.writeFileSync(path.join(dir, f), c);
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-fav-")));
  dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "home"));
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(dist, "config", "den.yml"),
    yaml.stringify({
      brand: { name: "Acme", theme: "den" },
      github_org: "acme-corp",
      web: { port: 18888 },
      environments: ["local"],
    }),
  );
  fs.writeFileSync(
    path.join(dist, "config", "local", "user.yml"),
    yaml.stringify({ appearance: { mode: "light" } }),
  );
  theme(
    "vec",
    { svg: "mark.svg", svg_dark: "mark-dark.svg", shape: "rounded" },
    { "mark.svg": SVG, "mark-dark.svg": SVG_DARK },
  );
  theme(
    "pix",
    { png: "mark.png", png_dark: "mark-dark.png", shape: "circle" },
    { "mark.png": PNG, "mark-dark.png": PNG_DARK },
  );
  server = spawn(
    process.execPath,
    [
      path.join(ENGINE, "node_modules", ".bin", "tsx"),
      path.join(ENGINE, "src", "ui", "server", "index.ts"),
    ],
    {
      cwd: dist,
      env: {
        ...process.env,
        DEN_ROOT: dist,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        PORT: String(PORT),
        DEN_NO_OPEN: "1",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      if ((await get("/api/server-info")) === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start within 20s");
}, 40_000);

afterAll(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
  server = null;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(
  url = "/services",
  width = 1440,
  colorScheme: "light" | "dark" = "light",
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    colorScheme,
  });
  const p = await ctx.newPage();
  await p.route("**/api/changelog", (r) => r.fulfill({ json: [] }));
  await p.goto(BASE + url);
  await p.waitForSelector("#appearance-btn");
  return p;
}

/** Pick a row of the ◐ menu (Appearance or Theme), as a user does. */
async function pick(p: Page, label: string): Promise<void> {
  await p.click("#appearance-btn");
  await p.getByRole("menuitemradio", { name: label, exact: true }).click();
}

/** The page's icon links, and what the one there is serves. */
async function icon(p: Page) {
  const hrefs = await p.$$eval('link[rel~="icon"]', (ls) =>
    ls.map((l) => l.getAttribute("href") ?? ""),
  );
  const r = await p.request.get(BASE + hrefs[0]);
  return {
    hrefs,
    href: hrefs[0],
    type: r.headers()["content-type"],
    body: await r.body(),
  };
}

/** Wait until the icon link's href passes `ok`. */
async function iconWhere(p: Page, pattern: RegExp) {
  await p.waitForFunction(
    (src) =>
      new RegExp(src).test(
        document.querySelector('link[rel~="icon"]')?.getAttribute("href") ?? "",
      ),
    pattern.source,
    { timeout: 5000 },
  );
  return icon(p);
}

describe("the browser tab follows the theme (0.3.0-dev.22)", () => {
  it("den → an SVG-mark theme → a PNG-mark theme: a new URL and type each time, one link", async () => {
    if (!browser) return;
    const p = await open();
    const den = await iconWhere(p, /^\/theme-favicon\/den\?mode=light&v=/);
    expect(den.hrefs).toHaveLength(1);
    expect(den.type).toBe("image/x-icon");
    await pick(p, "VEC");
    const vec = await iconWhere(
      p,
      /^\/theme-favicon\/vec\?mode=light&v=1\.2\.3-/,
    );
    expect(vec.hrefs).toHaveLength(1);
    expect(vec.type).toBe("image/svg+xml");
    expect(vec.body.toString()).toBe(SVG);
    await pick(p, "PIX");
    const pix = await iconWhere(
      p,
      /^\/theme-favicon\/pix\?mode=light&v=1\.2\.3-/,
    );
    expect(pix.hrefs).toHaveLength(1);
    expect(pix.type).toBe("image/png");
    expect(pix.body.equals(PNG)).toBe(true);
    expect(new Set([den.href, vec.href, pix.href]).size).toBe(3);
    // A reload keeps the theme's icon (no Den default on first paint).
    await p.reload();
    const again = await iconWhere(p, /^\/theme-favicon\/pix\?mode=light&v=/);
    expect([again.hrefs.length, again.type]).toEqual([1, "image/png"]);
    await pick(p, "Org default (Den)");
    await iconWhere(p, /^\/theme-favicon\/den\?/);
    await p.context().close();
  }, 60_000);

  it("an SVG mark with svg_dark: the base file in light, svg_dark in dark; mode switches change the href", async () => {
    if (!browser) return;
    const p = await open();
    await pick(p, "VEC");
    const light = await iconWhere(p, /^\/theme-favicon\/vec\?mode=light&/);
    expect([light.type, light.body.toString()]).toEqual(["image/svg+xml", SVG]);
    await pick(p, "Dark");
    const dark = await iconWhere(p, /^\/theme-favicon\/vec\?mode=dark&/);
    expect([dark.type, dark.body.toString()]).toEqual([
      "image/svg+xml",
      SVG_DARK,
    ]);
    expect(dark.href).not.toBe(light.href);
    await pick(p, "Light");
    expect(
      (await iconWhere(p, /^\/theme-favicon\/vec\?mode=light&/)).href,
    ).toBe(light.href);
    // System follows the OS.
    await pick(p, "System");
    await p.emulateMedia({ colorScheme: "dark" });
    expect((await iconWhere(p, /^\/theme-favicon\/vec\?mode=dark&/)).href).toBe(
      dark.href,
    );
    await p.emulateMedia({ colorScheme: "light" });
    await iconWhere(p, /^\/theme-favicon\/vec\?mode=light&/);
    await pick(p, "Light");
    await pick(p, "Org default (Den)");
    await iconWhere(p, /^\/theme-favicon\/den\?/);
    await p.context().close();
  }, 60_000);
});

describe("a raster mark in the top bar (0.3.0-dev.22)", () => {
  it("is an <img> at 22px, clipped to its shape, the dark file in dark mode", async () => {
    if (!browser) return;
    const p = await open();
    await pick(p, "PIX");
    const mark = async () =>
      p.evaluate(() => {
        const host = document.querySelector(
          ".den-top .den-mark",
        ) as HTMLElement;
        const img = host.querySelector("img");
        const box = host.getBoundingClientRect();
        const ib = img?.getBoundingClientRect();
        return {
          src: img?.getAttribute("src") ?? null,
          loaded: !!img && img.complete && img.naturalWidth === 48,
          host: [box.width, box.height],
          img: ib ? [ib.width, ib.height] : null,
          radius: getComputedStyle(host).borderRadius,
          overflow: getComputedStyle(host).overflow,
        };
      });
    await p.waitForFunction(() =>
      document.querySelector(".den-top .den-mark img[src$='mark.png']"),
    );
    await p.waitForFunction(
      () =>
        (document.querySelector(".den-top .den-mark img") as HTMLImageElement)
          ?.naturalWidth === 48,
    );
    expect(await mark()).toEqual({
      src: "/theme/pix/mark.png",
      loaded: true,
      host: [22, 22],
      img: [22, 22],
      radius: "50%",
      overflow: "hidden",
    });
    await pick(p, "Dark");
    await p.waitForFunction(() =>
      document.querySelector(".den-top .den-mark img[src$='mark-dark.png']"),
    );
    expect((await mark()).src).toBe("/theme/pix/mark-dark.png");
    expect((await mark()).host).toEqual([22, 22]);
    await pick(p, "Light");
    await pick(p, "Org default (Den)");
    await p.context().close();
  }, 60_000);
});

describe("the brand below 480px (SA's dev.21 run)", () => {
  it("shows only the mark; the link keeps its name at every width", async () => {
    if (!browser) return;
    for (const width of [400, 479, 480, 600, 1024]) {
      const p = await open("/services", width);
      await p.waitForSelector(".den-top .den-mark img");
      const title = await p.evaluate(() => {
        const t = document.querySelector(".den-top .den-title") as HTMLElement;
        const r = t.getBoundingClientRect();
        return { text: (t.textContent ?? "").trim(), w: r.width, h: r.height };
      });
      const link = p.getByRole("link", { name: title.text, exact: true });
      expect({ width, links: await link.count() }).toEqual({ width, links: 1 });
      expect(await link.isVisible()).toBe(true);
      const shown = title.w > 1 && title.h > 1;
      expect({ width, shown }).toEqual({ width, shown: width >= 480 });
      // The mark stays at 22px.
      const box = await p.locator(".den-top .den-mark").boundingBox();
      expect([box?.width, box?.height]).toEqual([22, 22]);
      await p.context().close();
    }
  }, 90_000);
});
