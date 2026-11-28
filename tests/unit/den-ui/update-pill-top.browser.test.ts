import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser] });
});

const skip = () => !browser;

const PAGE = (style: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/update-pill.css">
<style>${style}</style></head>
<body class="den-has-shell"><main>Page</main>
<script type="module">
import { showUpdate } from "/update-pill.js";
showUpdate({ message: "A new version is available.", reloadLabel: "Reload", dismissLabel: "Not now" });
requestAnimationFrame(() => requestAnimationFrame(() => { window.ready = true; }));
</script></body></html>`;

async function pillTop(
  style: string,
  width: number,
  height: number,
): Promise<{ top: number; height: number }> {
  const ctx = await browser!.newContext({ viewport: { width, height } });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE(style) });
    const f = path.join(SRC, u.pathname.slice(1));
    if (/^\/[\w-]+\.(css|js)$/.test(u.pathname) && fs.existsSync(f))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(f, "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction("window.ready === true");
  const at = (await p.getByRole("region", { name: "Update" }).evaluate((el) => {
    const r = el.firstElementChild!.getBoundingClientRect();
    return { top: Math.round(r.top), height: Math.round(r.height) };
  })) as { top: number; height: number };
  await ctx.close();
  return at;
}

const SIZES: [number, number][] = [
  [1366, 1024],
  [820, 1180],
];

describe("the update pill's place under the shell's top bar", () => {
  it.each(SIZES)(
    "%ix%i: centred on the 48px bar, 1px above the top, as designed",
    async (w, h) => {
      if (skip()) return;
      expect(await pillTop("", w, h)).toEqual({ top: -1, height: 50 });
    },
  );

  it.each(SIZES)(
    "%ix%i: with no top bar (--den-top-h: 0px) the pill is whole, 8px down",
    async (w, h) => {
      if (skip()) return;
      const { top } = await pillTop(
        "body.den-has-shell { --den-top-h: 0px; }",
        w,
        h,
      );
      expect(top).toBe(8);
    },
  );

  it("a bar shorter than the pill never puts it above the window", async () => {
    if (skip()) return;
    const { top } = await pillTop(
      "body.den-has-shell { --den-top-h: 20px; }",
      1366,
      1024,
    );
    expect(top).toBeGreaterThanOrEqual(-1);
  });

  it.each(SIZES)(
    "%ix%i: a host's --den-overlay-top on the body or :root places it, with no kit selector",
    async (w, h) => {
      if (skip()) return;
      const bar = "body.den-has-shell { --den-top-h: 0px; }";
      const at = async (rule: string) => (await pillTop(bar + rule, w, h)).top;
      expect(await at("body { --den-overlay-top: 56px; }")).toBe(56);
      expect(await at("body { --den-overlay-top: calc(44px + 8px); }")).toBe(
        52,
      );
      expect(await at(":root { --den-overlay-top: 60px; }")).toBe(60);
    },
  );

  it("a host's own --upd-top on .den-upd wins", async () => {
    if (skip()) return;
    const { top } = await pillTop(
      "body.den-has-shell .den-upd { --upd-top: 64px; }",
      1366,
      1024,
    );
    expect(top).toBe(64);
  });
});
