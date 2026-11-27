/**
 * den-ui: the pager (pager.js, pager.css) in a browser, with no product
 * around it: a bare page loads tokens.css, base.css and pager.css and
 * draws pagers with invented words and links.
 *
 *   - sizes: the ends are square icon buttons, 32px with a mouse, 44px on
 *     touch and at 390; the icons mirror right to left
 *   - keys: ← and → from the page body, the list or the pager, never from
 *     a field; Home and End on the pager; off for compact unless asked
 *   - the selects and the number field (clamped) move at once; each move
 *     fires den-pager-nav and calls onNavigate
 *   - a 600px row folds to ⋯, which opens a sheet with the per-page choice
 *   - compact: First and Last only on a row wider than 600px; Enter in the
 *     page field moves
 *   - with no script, a select's GET form keeps the filters and #list
 *
 * The checks with no browser are pager-kit.test.ts.
 */
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

const PAGE = (script: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/pager.css"></head>
<body><input id="field">
<ul id="list"><li tabindex="0" id="row">row</li></ul><div id="a"></div>
<div id="r" dir="rtl"></div><div id="one"></div>
<div id="narrow" style="width:480px"></div>
<div id="k1" style="width:360px"></div><div id="k2" style="width:700px"></div>
<script type="module">
import { pagerHtml, hydratePager } from "/pager.js";
const W = { range: "{from}–{to} of {total}", label: "Pages", first: "First",
  firstSr: "First page", prev: "Previous", prevSr: "Previous page", next: "Next",
  nextSr: "Next page", last: "Last", lastSr: "Last page", pageOf: "Page {select} of {n}",
  pageShort: "{p} / {n}", pageSr: "Page {p} of {n}", go: "Go", perPage: "{select} per page",
  more: "More" };
const href = (page, pages, per0 = 50) => (t) => {
  let p = page, per = per0;
  if (t === "first") p = 1; else if (t === "prev") p = page - 1;
  else if (t === "next") p = page + 1; else if (t === "last") p = pages;
  else if (t && t.page) p = t.page; else if (t && t.per) { per = t.per; p = 1; }
  const q = new URLSearchParams({ state: "open" });
  if (p > 1) q.set("page", String(p));
  if (per !== per0 || t && t.per) q.set("per", String(per));
  return "/list?" + q + "#list";
};
window.navs = []; window.events = [];
const put = (id, m) => {
  const el = document.getElementById(id);
  el.innerHTML = pagerHtml({ words: W, ...m });
  const n = el.firstElementChild;
  ${script ? 'n.addEventListener("den-pager-nav", (e) => { events.push([id, e.detail.kind]); e.preventDefault(); }); hydratePager(n, { list: "list", onNavigate: (a) => navs.push([id, a.kind, JSON.stringify(a.target), a.href]) });' : ""}
};
put("a", { from: 101, to: 150, total: 809, per: 50, page: 3, href: href(3, 17) });
put("one", { from: 1, to: 50, total: 809, per: 50, page: 1, href: href(1, 17) });
put("r", { from: 101, to: 150, total: 809, per: 50, page: 3, href: href(3, 17) });
put("narrow", { from: 101, to: 150, total: 809, per: 50, page: 3, href: href(3, 17) });
put("k1", { compact: true, from: 6, to: 10, total: 125, per: 5, page: 2, href: href(2, 25, 5) });
put("k2", { compact: true, from: 6, to: 10, total: 125, per: 5, page: 2, href: href(2, 25, 5) });
window.ready = true;
</script></body></html>`;

async function open(
  o: { width?: number; touch?: boolean; script?: boolean } = {},
): Promise<Page> {
  const touch = o.touch ?? false;
  const ctx = await browser!.newContext({
    viewport: { width: o.width ?? 1280, height: 900 },
    hasTouch: touch,
    isMobile: touch,
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        body: PAGE(o.script ?? true),
      });
    const f = path.join(SRC, u.pathname.slice(1));
    if (/^\/[\w-]+\.(css|js)$/.test(u.pathname) && fs.existsSync(f))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(f, "utf-8"),
      });
    return r.fulfill({ contentType: "text/plain", body: "landed" });
  });
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction("window.ready === true");
  expect(errs).toEqual([]);
  return p;
}

const box = (p: Page, sel: string) =>
  p.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  })()`) as Promise<[number, number]>;
const shown = (p: Page, sel: string) =>
  p.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((x) => x.getBoundingClientRect().width > 0).length`,
  ) as Promise<number>;
const navs = (p: Page) => p.evaluate("window.navs") as Promise<string[][]>;

describe("pager in a browser", () => {
  it("draws square icon ends: 32px with a mouse, 44px on touch", async () => {
    if (skip()) return;
    const p = await open();
    for (const d of ["first", "prev", "next", "last"])
      expect(await box(p, `#a .den-pager-${d}`)).toEqual([32, 32]);
    expect(await box(p, "#a .den-pager-next svg")).toEqual([16, 16]);
    await p.context().close();
    const t = await open({ width: 390, touch: true });
    for (const d of ["first", "prev", "next", "last"])
      expect(await box(t, `#a .den-pager-${d}`)).toEqual([44, 44]);
    expect(
      await t.evaluate("document.documentElement.scrollWidth > innerWidth"),
    ).toBe(false);
    await t.context().close();
  });

  it("mirrors the icons right to left, and not left to right", async () => {
    if (skip()) return;
    const p = await open();
    const tf = (sel: string) =>
      p.evaluate(
        `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).transform`,
      );
    expect(await tf("#r .den-pager-next svg")).toBe(
      "matrix(-1, 0, 0, 1, 0, 0)",
    );
    expect(await tf("#a .den-pager-next svg")).toBe("none");
    await p.context().close();
  });

  it("moves with ← and → from the body or the list, never from a field", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus("#row");
    await p.keyboard.press("ArrowRight");
    await p.keyboard.press("ArrowLeft");
    await p.focus("#field");
    await p.keyboard.press("ArrowRight");
    const n = await navs(p);
    const own = n.filter((x) => x[0] === "a");
    expect(own.map((x) => x[2])).toEqual(['"next"', '"prev"']);
    expect(n.filter((x) => x[0] === "k1" || x[0] === "k2")).toEqual([]);
    await p.context().close();
  });

  it("goes to the first and last page with Home and End on the pager", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus("#a .den-pager-next");
    await p.keyboard.press("Home");
    await p.keyboard.press("End");
    expect((await navs(p)).map((x) => x[3])).toEqual([
      "/list?state=open#list",
      "/list?state=open&page=17#list",
    ]);
    await p.context().close();
  });

  it("follows a select at once and fires den-pager-nav", async () => {
    if (skip()) return;
    const p = await open();
    await p.selectOption("#a .den-pager-wide select", "9");
    await p.selectOption("#a .den-pager-side select", "100");
    await p.click("#a .den-pager-next");
    expect((await navs(p)).map((x) => [x[1], x[2]])).toEqual([
      ["page", '{"page":9}'],
      ["per", '{"per":100}'],
      ["page", '"next"'],
    ]);
    expect(await p.evaluate("window.events.length")).toBe(3);
    expect(
      await p.evaluate(
        "getComputedStyle(document.querySelector('#a .den-pager-submit')).display",
      ),
    ).toBe("none");
    await p.context().close();
  });

  it("does nothing on an end that is off", async () => {
    if (skip()) return;
    const p = await open();
    await p.click("#one .den-pager-prev", { force: true });
    await p.focus("#one .den-pager-next");
    await p.keyboard.press("Home");
    expect(await navs(p)).toEqual([]);
    expect(await p.getAttribute("#one .den-pager-prev", "role")).toBe("link");
    expect(p.url()).toBe(`${ORIGIN}/`);
    await p.context().close();
  });

  it("folds a 600px row to ⋯, which opens a sheet with the per-page choice", async () => {
    if (skip()) return;
    const p = await open({ width: 390, touch: true });
    expect(await shown(p, "#a .den-pager-side")).toBe(0);
    await p.click("#a .den-pager-opts");
    await p.waitForFunction(
      "document.querySelector('#a .den-pager-menu').matches(':popover-open')",
    );
    expect(
      await p.evaluate(
        "[...document.querySelector('#a .den-pager-menu').classList]",
      ),
    ).toContain("den-pager-sheet");
    expect(await shown(p, "#a .den-pager-menu select")).toBe(1);
    await p.keyboard.press("Escape");
    await p.context().close();
  });

  it("compact: First and Last only on a row wider than 600px", async () => {
    if (skip()) return;
    const p = await open();
    expect(await shown(p, "#k1 .den-pager-end")).toBe(2);
    expect(await shown(p, "#k2 .den-pager-end")).toBe(4);
    await p.context().close();
  });

  it("compact: Enter in the page field moves, clamped to the last page", async () => {
    if (skip()) return;
    const p = await open();
    await p.fill("#k1 .den-pager-num", "99");
    await p.press("#k1 .den-pager-num", "Enter");
    expect((await navs(p)).map((x) => [x[0], x[2], x[3]])).toEqual([
      ["k1", '{"page":25}', "/list?state=open&page=25#list"],
    ]);
    await p.context().close();
  });

  it("with no script, a select's form keeps the filters and #list", async () => {
    if (skip()) return;
    const p = await open({ script: false });
    expect(
      await p.evaluate(
        "getComputedStyle(document.querySelector('#a .den-pager-wide .den-pager-submit')).display",
      ),
    ).not.toBe("none");
    await p.selectOption("#a .den-pager-wide select", "7");
    await Promise.all([
      p.waitForURL(/page=7/),
      p.click("#a .den-pager-wide .den-pager-submit"),
    ]);
    expect(p.url()).toBe(`${ORIGIN}/list?state=open&page=7#list`);
    await p.context().close();
  });
});
