import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";
import { navItemHtml } from "../../../packages/den-ui/src/shell-html.js";

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
<span style="background: var(--sunken)"><span class="den-bdg warn soft" data-testid="warn-soft-on-sunken">3</span></span>
<a class="den-ni" href="#">Agents <span class="den-bdg warn soft" data-testid="nav-soft">2</span></a>
<button type="button">Related <span class="den-bdg count" data-testid="count-99">99+</span></button>
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

describe("the kit's badge: a warn tint and a count in a tab (issue 1973)", () => {
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
    expect(s.alpha).toBe(1);
    expect(s.bg).not.toBe(t.warn);
    await p.context().close();
  });

  it("warn soft: its tint is solid, the same over any backdrop", async () => {
    if (skip()) return;
    const p = await open();
    const plain = await look(p, "warn-soft");
    const onSunken = await look(p, "warn-soft-on-sunken");
    expect(onSunken.bg).toBe(plain.bg);
    expect(
      await p.getByTestId("warn-soft").evaluate((e) => {
        const probe = document.createElement("span");
        probe.style.background =
          "color-mix(in srgb, var(--warn) 14%, var(--surface))";
        e.parentElement!.append(probe);
        const want = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return want;
      }),
    ).toBe(plain.bg);
    await p.context().close();
  });

  it("warn soft in the rail is regular weight; elsewhere it keeps 600", async () => {
    if (skip()) return;
    const p = await open();
    expect((await look(p, "nav-soft")).weight).toBe("400");
    expect((await look(p, "warn-soft")).weight).toBe("600");
    await p.context().close();
  });

  it("navItemHtml draws a soft warn badge on request", () => {
    const h = navItemHtml(
      { label: "Agents", href: "/a", badge: { n: 2, warn: true, soft: true } },
      "item",
      "en",
    );
    expect(h).toContain('class="den-bdg warn soft" data-badge="warn"');
    expect(
      navItemHtml(
        { label: "Agents", href: "/a", badge: { n: 2, warn: true } },
        "item",
        "en",
      ),
    ).toContain('class="den-bdg warn" data-badge="warn"');
  });

  it("count: tight, 2px from its word and 2px each side", async () => {
    if (skip()) return;
    const p = await open();
    const one = await look(p, "count");
    expect(one.w).toBeLessThanOrEqual(18);
    const many = await look(p, "count-99");
    expect(many.w).toBeLessThanOrEqual(24);
    expect(
      await p
        .getByTestId("count")
        .evaluate((e) => getComputedStyle(e).marginInlineStart),
    ).toBe("2px");
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
