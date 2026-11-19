/**
 * den-ui: the Report screenshot shows what the person sees (issue 295).
 *
 * A page scrolled down, with an inner pane scrolled to its middle, a
 * sticky top bar, a sticky pane, a sticky header inside the pane, and a
 * fixed badge.
 * Every band has its own colour, so the pixels say which band is where.
 * capture()'s image must match the browser's own screenshot of the
 * viewport at each sample point: the bands on screen, not the top ones.
 *
 * On a bare page built from the kit's own files, in Chromium and WebKit.
 * DEN_PW_WS: Den's own Playwright server instead of a local browser.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const ROOT = path.join(__dirname, "../../..");
const SRC = path.join(ROOT, "packages/den-ui/src");
const LIB = path.join(ROOT, "node_modules/html-to-image/dist/html-to-image.js");
const ORIGIN = "http://shot.test";
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = await launchBrowser(kind);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

/** A colour per band: far apart, so antialiasing can't confuse two. */
const hue = (i: number, n: number, l: number) =>
  `hsl(${Math.round((i * 360) / n)} 80% ${l}%)`;

const BANDS = 10; // the page: 300px each
const PANE = 20; // the pane: 100px each

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
  html, body { margin: 0; }
  body { background: rgb(250, 250, 250); font: 14px sans-serif; }
  .bar { position: sticky; top: 0; height: 40px; background: rgb(20, 20, 20); color: white; z-index: 2; }
  .cols { display: grid; grid-template-columns: 400px 400px; }
  .band { height: 300px; }
  .pane { position: sticky; top: 40px; align-self: start; height: 500px; overflow: auto; }
  .pane .head { position: sticky; top: 0; height: 30px; background: rgb(255, 255, 255); }
  .pane .p { height: 100px; }
  .badge { position: fixed; right: 0; bottom: 0; width: 60px; height: 30px; background: rgb(0, 0, 200); }
</style></head>
<body>
<div class="bar">Top bar</div>
<div class="badge"></div>
<div class="cols">
  <div>${Array.from(
    { length: BANDS },
    (_, i) =>
      `<div class="band" style="background:${hue(i, BANDS, 45)}">Band ${i}</div>`,
  ).join("")}</div>
  <div class="pane" id="pane"><div class="head">Doc</div>${Array.from(
    { length: PANE },
    (_, i) =>
      `<div class="p" style="background:${hue(i, PANE, 70)}">Pane ${i}</div>`,
  ).join("")}</div>
</div>
<script type="module">
  import { configureShots, capture } from "/kit/report-shot.js";
  configureShots({ library: "/vendor/html-to-image.js" });
  window.shoot = async () => {
    const c = await capture({ seconds: 20 });
    return c ? { w: c.width, h: c.height, url: c.toDataURL("image/png") } : null;
  };
  window.ready = true;
</script>
</body></html>`;

async function open(b: Browser): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    if (u.pathname === "/vendor/html-to-image.js")
      return r.fulfill({
        contentType: "text/javascript",
        body: fs.readFileSync(LIB),
      });
    const f = u.pathname.replace(/^\/kit\//, "");
    const file = path.join(SRC, f);
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: "text/javascript",
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(
    () => (window as { ready?: boolean }).ready === true,
    undefined,
    { timeout: 10_000 },
  );
  return p;
}

/** RGB at each point of a PNG (a data: URL), read in the page. */
const pixels = (p: Page, url: string, pts: [number, number][]) =>
  p.evaluate(
    async ({ url, pts }) => {
      const img = new Image();
      await new Promise((ok, no) => {
        img.onload = ok;
        img.onerror = no;
        img.src = url;
      });
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      return pts.map(([x, y]) =>
        Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)),
      );
    },
    { url, pts },
  );

/** Sample points: the top bar, the page's column, the pane, its header, the fixed badge. */
const POINTS: [number, number][] = [
  [200, 20],
  [600, 20],
  [770, 585],
  ...[60, 150, 250, 350, 450, 550, 590].map(
    (y) => [200, y] as [number, number],
  ),
  ...[55, 100, 180, 260, 340, 420, 530].map(
    (y) => [600, y] as [number, number],
  ),
];

const near = (a: number[], b: number[]) =>
  a.every((v, i) => Math.abs(v - b[i]) <= 24);

describe.each(["chromium", "webkit"])(
  "Report screenshot keeps the scroll (%s)",
  (name) => {
    it("shows the bands on screen, not the top of the page or the pane", async () => {
      const b = browsers[name];
      if (!b) return;
      const p = await open(b);
      await p.evaluate(() => {
        window.scrollTo(0, 1000);
        document.getElementById("pane")!.scrollTop = 900;
      });
      // What is on screen: band 3 at the top of the page's column, pane 9
      // under the pane's header.
      const seen = await p.evaluate(() => {
        const at = (x: number, y: number) =>
          (document.elementFromPoint(x, y) as HTMLElement).textContent!.trim();
        return [at(200, 60), at(600, 100)];
      });
      expect(seen).toEqual(["Band 3", "Pane 9"]);
      const truth = `data:image/png;base64,${(await p.screenshot()).toString("base64")}`;
      const shot = await p.evaluate(() =>
        (
          window as unknown as {
            shoot: () => Promise<{ w: number; h: number; url: string } | null>;
          }
        ).shoot(),
      );
      expect(shot).not.toBeNull();
      expect([shot!.w, shot!.h]).toEqual([800, 600]);
      const want = await pixels(p, truth, POINTS);
      const got = await pixels(p, shot!.url, POINTS);
      const off = POINTS.map((pt, i) =>
        near(got[i], want[i])
          ? ""
          : `${pt.join(",")}: got ${got[i]} want ${want[i]}`,
      ).filter(Boolean);
      expect(off).toEqual([]);
      // The page itself is still where the person left it.
      const after = await p.evaluate(() => [
        window.scrollY,
        document.getElementById("pane")!.scrollTop,
      ]);
      expect(after).toEqual([1000, 900]);
    }, 60_000);
  },
);
