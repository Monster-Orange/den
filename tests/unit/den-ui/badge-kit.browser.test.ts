import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
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

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/shell.css">
<style>
.host-tabs { --den-bdg-fs: 10px; --den-bdg-lh: 16px; --den-bdg-pad: 0 3px; --den-bdg-min: 1.4em; }
.ico-tab { position: relative; display: inline-flex; width: 36px; height: 36px; }
</style></head>
<body>
<span id="t-warn"><span style="color: var(--warn)">w</span><span style="color: var(--bad)">b</span><span style="color: var(--on-accent)">o</span><span style="color: var(--accent-fill)">a</span></span>
<span class="den-bdg" data-testid="plain">3</span>
<span class="den-bdg warn" data-testid="warn">3</span>
<span class="den-bdg bad" data-testid="bad">3</span>
<span class="den-bdg warn soft" data-testid="warn-soft">3</span>
<span class="den-bdg bad strong" data-testid="bad-strong">3</span>
<button type="button">Comments <span class="den-bdg count" data-testid="count">7</span></button>
<button type="button">Checks <span class="den-bdg count bad" data-testid="count-bad">1</span></button>
<div class="host-tabs"><button type="button">Comments <span class="den-bdg count" data-testid="count-small">7</span></button></div>
<button type="button" class="ico-tab" aria-label="Comments, 4"><span class="den-bdg count corner" data-testid="corner">4</span></button>
</body></html>`;

async function open(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    const f = path.join(SRC, u.pathname.slice(1));
    if (/^\/[\w-]+\.css$/.test(u.pathname) && fs.existsSync(f))
      return r.fulfill({
        contentType: "text/css",
        body: fs.readFileSync(f, "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  return p;
}

type Look = {
  bg: string;
  color: string;
  weight: string;
  size: string;
  h: number;
  w: number;
  position: string;
  alpha: number;
};

const look = (p: Page, id: string) =>
  p.getByTestId(id).evaluate((e): Look => {
    const c = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    const bg = c.backgroundColor;
    const slash = /\/\s*([\d.]+)\s*\)$/.exec(bg);
    const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(bg);
    const alpha = Number(slash?.[1] ?? rgba?.[1] ?? 1);
    return {
      bg: c.backgroundColor,
      color: c.color,
      weight: c.fontWeight,
      size: c.fontSize,
      h: Math.round(r.height * 10) / 10,
      w: Math.round(r.width * 10) / 10,
      position: c.position,
      alpha,
    };
  });

const tokens = (p: Page) =>
  p
    .locator("#t-warn")
    .evaluate((e) =>
      Object.fromEntries(
        ["warn", "bad", "onAccent", "accentFill"].map((k, i) => [
          k,
          getComputedStyle(e.children[i]!).color,
        ]),
      ),
    ) as Promise<Record<string, string>>;

describe("the kit's badge: tints, solid bad, and a count in a tab (issue 1973)", () => {
  it("keeps the plain, warn and bad badges as they were", async () => {
    if (skip()) return;
    const p = await open();
    const t = await tokens(p);
    const warn = await look(p, "warn");
    expect(warn.bg).toBe(t.warn);
    expect(warn.weight).toBe("600");
    const bad = await look(p, "bad");
    expect(bad.color).toBe(t.bad);
    expect(bad.alpha).toBeLessThan(1);
    await p.context().close();
  });

  it("warn soft: warn words on a faint warn tint", async () => {
    if (skip()) return;
    const p = await open();
    const t = await tokens(p);
    const s = await look(p, "warn-soft");
    expect(s.color).toBe(t.warn);
    expect(s.alpha).toBeGreaterThan(0);
    expect(s.alpha).toBeLessThan(0.3);
    await p.context().close();
  });

  it("bad strong: on-accent words on solid bad", async () => {
    if (skip()) return;
    const p = await open();
    const t = await tokens(p);
    const s = await look(p, "bad-strong");
    expect(s.bg).toBe(t.bad);
    expect(s.color).toBe(t.onAccent);
    await p.context().close();
  });

  it("count: a solid accent pill sized for a tab, bad when it needs the person", async () => {
    if (skip()) return;
    const p = await open();
    const t = await tokens(p);
    const c = await look(p, "count");
    expect([c.bg, c.color, c.weight, c.size, c.h]).toEqual([
      t.accentFill,
      t.onAccent,
      "600",
      "11px",
      18,
    ]);
    expect(c.w).toBeGreaterThanOrEqual(17.6);
    const b = await look(p, "count-bad");
    expect([b.bg, b.color]).toEqual([t.bad, t.onAccent]);
    await p.context().close();
  });

  it("count: a host sizes it from its own class, with no kit selector", async () => {
    if (skip()) return;
    const p = await open();
    const c = await look(p, "count-small");
    expect([c.size, c.h]).toEqual(["10px", 16]);
    expect(c.w).toBeGreaterThanOrEqual(14);
    await p.context().close();
  });

  it("count corner: on an icon tab, out of the flow at its top end corner", async () => {
    if (skip()) return;
    const p = await open();
    const c = await look(p, "corner");
    expect(c.position).toBe("absolute");
    const at = await p.getByTestId("corner").evaluate((e) => {
      const r = e.getBoundingClientRect();
      const t = e.parentElement!.getBoundingClientRect();
      return { right: r.right > t.right - 8, top: r.top < t.top + 8 };
    });
    expect(at).toEqual({ right: true, top: true });
    expect(
      await p
        .getByTestId("corner")
        .evaluate((e) => getComputedStyle(e).pointerEvents),
    ).toBe("none");
    await p.context().close();
  });
});
