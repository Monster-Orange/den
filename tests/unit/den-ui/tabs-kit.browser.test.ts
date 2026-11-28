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
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/tabs.css"></head>
<body>
<div id="sw" style="width:600px"></div>
<div id="pg" style="width:600px"></div>
<div id="pn" style="width:600px"></div>
<section id="about">About text</section><section id="logs-p">Logs text</section><section id="keys">Keys text</section>
<div id="narrow" style="width:300px"></div>
<div id="tiny" style="width:120px"></div>
<div id="rtl" dir="rtl" style="width:300px"></div>
<div id="rtlcss" style="width:300px;direction:rtl"></div>
<div id="rtlwide" dir="rtl" style="width:600px"></div>
<div id="twice" style="width:600px"></div>
<script type="module">
import { tabsHtml, hydrateTabs } from "/tabs.js";
window.changes = []; window.keys = []; window.clicks = [];
addEventListener("keydown", (e) => keys.push([e.key, e.defaultPrevented]));
addEventListener("click", (e) => { clicks.push(e.defaultPrevented); e.preventDefault(); });
const MANY = ["Overview", "Activity", "Services", "Agents", "Settings", "Members", "Billing", "Audit"]
  .map((t, i) => ({ id: "m" + i, text: t, alert: i === 7 }));
const put = (id, m, o = {}) => {
  const el = document.getElementById(id);
  el.innerHTML = tabsHtml(m);
  return hydrateTabs(el.firstElementChild, { onChange: (v) => changes.push([id, v]), ...o });
};
window.handles = {
  sw: put("sw", { label: "View", chosen: "board", items: [
    { id: "list", text: "List" }, { id: "board", text: "Board" },
    { id: "map", text: "Map", disabled: true }, { id: "feed", text: "Feed" }] }),
  pg: put("pg", { kind: "page", label: "State", chosen: "open", items: [
    { id: "open", text: "Open", href: "/landed?open", count: 3 },
    { id: "closed", text: "Closed", href: "/landed?closed" }] }),
  pn: put("pn", { kind: "panel", label: "Details", items: [
    { id: "about", text: "About" }, { id: "logs", text: "Logs", panel: "logs-p" },
    { id: "keys", text: "Keys" }] }),
  narrow: put("narrow", { label: "Sections", items: MANY, chosen: "m0" }),
  tiny: put("tiny", { label: "Sections", items: MANY, chosen: "m2" }),
  rtl: put("rtl", { label: "Sections", items: MANY, chosen: "m0" }),
  rtlcss: put("rtlcss", { label: "Sections", items: MANY, chosen: "m0" }),
  rtlwide: put("rtlwide", { label: "View", items: [
    { id: "a", text: "One" }, { id: "b", text: "Two" }, { id: "c", text: "Three" }] }),
};
const t1 = put("twice", { label: "View", items: [{ id: "a", text: "A" }, { id: "b", text: "B" }] });
window.second = hydrateTabs(document.querySelector("#twice .den-tabs"), { onChange: (v) => changes.push(["twice2", v]) });
window.sameHandle = t1 === window.second;
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
window.ready = true;
</script></body></html>`;

async function open(
  o: { width?: number; forced?: boolean } = {},
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: o.width ?? 1280, height: 900 },
    reducedMotion: "reduce",
    forcedColors: o.forced ? "active" : "none",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
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

const js = <T>(p: Page, expr: string) => p.evaluate(expr) as Promise<T>;
const changes = (p: Page) => js<string[][]>(p, "window.changes");
const state = (p: Page, host: string, attr: string) =>
  js<(string | null)[][]>(
    p,
    `[...document.querySelectorAll(${JSON.stringify(`#${host} .den-tab`)})].map((b) => [b.dataset.id, b.getAttribute(${JSON.stringify(attr)}), b.getAttribute("tabindex")])`,
  );
const focused = (p: Page) =>
  js<string | null>(p, "document.activeElement?.dataset?.id ?? null");
const tab = (p: Page, host: string, id: string) =>
  p.locator(`#${host} [data-id="${id}"]`);
const css = (p: Page, sel: string, prop: string, pseudo = "") =>
  js<string>(
    p,
    `getComputedStyle(document.querySelector(${JSON.stringify(sel)}), ${pseudo ? JSON.stringify(pseudo) : "null"}).getPropertyValue(${JSON.stringify(prop)})`,
  );

describe("tabs in a browser: a switch", () => {
  it("a click chooses a segment: pressed, the one in the tab order, onChange", async () => {
    if (skip()) return;
    const p = await open();
    await tab(p, "sw", "feed").click();
    expect(await state(p, "sw", "aria-pressed")).toEqual([
      ["list", "false", "-1"],
      ["board", "false", "-1"],
      ["map", "false", "-1"],
      ["feed", "true", "0"],
    ]);
    await tab(p, "sw", "map").click({ force: true });
    await tab(p, "sw", "feed").click();
    expect(await changes(p)).toEqual([["sw", "feed"]]);
    await p.context().close();
  });

  it("arrows move and choose, skipping a disabled one and wrapping; Home and End go to the ends", async () => {
    if (skip()) return;
    const p = await open();
    await tab(p, "sw", "board").focus();
    await p.keyboard.press("ArrowRight");
    expect(await focused(p)).toBe("feed");
    await p.keyboard.press("ArrowRight");
    expect(await focused(p)).toBe("list");
    await p.keyboard.press("ArrowLeft");
    expect(await focused(p)).toBe("feed");
    await p.keyboard.press("Home");
    expect(await focused(p)).toBe("list");
    await p.keyboard.press("End");
    expect(await focused(p)).toBe("feed");
    expect((await changes(p)).map((c) => c[1])).toEqual([
      "feed",
      "list",
      "feed",
      "list",
      "feed",
    ]);
    const roving = (await state(p, "sw", "aria-pressed")).filter(
      (s) => s[2] === "0",
    );
    expect(roving).toEqual([["feed", "true", "0"]]);
    await p.context().close();
  });

  it("leaves a key with Alt, Ctrl, Meta or Shift to the browser", async () => {
    if (skip()) return;
    const p = await open();
    await tab(p, "sw", "board").focus();
    for (const k of [
      "Alt+ArrowLeft",
      "Control+Home",
      "Meta+ArrowRight",
      "Shift+End",
    ])
      await p.keyboard.press(k);
    expect(await focused(p)).toBe("board");
    expect(await changes(p)).toEqual([]);
    const own = (await js<[string, boolean][]>(p, "window.keys")).filter(
      (k) => !["Alt", "Control", "Meta", "Shift"].includes(k[0]),
    );
    expect(own).toEqual([
      ["ArrowLeft", false],
      ["Home", false],
      ["ArrowRight", false],
      ["End", false],
    ]);
    await p.context().close();
  });

  it("a second hydrate on the same tabs returns the first, wiring nothing twice", async () => {
    if (skip()) return;
    const p = await open();
    expect(await js<boolean>(p, "window.sameHandle")).toBe(true);
    await tab(p, "twice", "b").click();
    expect((await changes(p)).filter((c) => c[0].startsWith("twice"))).toEqual([
      ["twice", "b"],
    ]);
    await p.context().close();
  });
});

describe("tabs in a browser: page tabs", () => {
  it("are links: a click follows the href; arrows do nothing", async () => {
    if (skip()) return;
    const p = await open();
    expect(await state(p, "pg", "aria-current")).toEqual([
      ["open", "page", null],
      ["closed", null, null],
    ]);
    await tab(p, "pg", "open").focus();
    await p.keyboard.press("ArrowRight");
    expect(await focused(p)).toBe("open");
    expect(
      await p.locator("#pg").getByRole("link", { name: "Open, 3" }).count(),
    ).toBe(1);
    const href = await tab(p, "pg", "closed").getAttribute("href");
    expect(href).toBe("/landed?closed");
    await p.context().close();
  });
});

describe("tabs in a browser: panel tabs", () => {
  it("show one panel, labelled by its tab, and arrows and Space switch it", async () => {
    if (skip()) return;
    const p = await open();
    const panels = () =>
      js<[string, boolean, string | null, string | null][]>(
        p,
        `["about", "logs-p", "keys"].map((id) => { const s = document.getElementById(id); return [id, s.hidden, s.getAttribute("role"), s.getAttribute("aria-labelledby")]; })`,
      );
    expect(await panels()).toEqual([
      ["about", false, "tabpanel", "den-tab-about"],
      ["logs-p", true, "tabpanel", "den-tab-logs-p"],
      ["keys", true, "tabpanel", "den-tab-keys"],
    ]);
    await tab(p, "pn", "about").focus();
    await p.keyboard.press("End");
    expect((await panels()).map((x) => x[1])).toEqual([true, true, false]);
    await tab(p, "pn", "logs").click();
    expect((await panels()).map((x) => x[1])).toEqual([true, false, true]);
    expect(await state(p, "pn", "aria-selected")).toEqual([
      ["about", "false", "-1"],
      ["logs", "true", "0"],
      ["keys", "false", "-1"],
    ]);
    expect(p.url()).toBe(`${ORIGIN}/`);
    await p.context().close();
  });

  it("a plain click stays on the page; a modifier or middle click is the browser's", async () => {
    if (skip()) return;
    const p = await open();
    await p.evaluate(`(() => {
      const prevented = [];
      const b = document.querySelector('#pn .den-tab[data-id="keys"]');
      const row = b.parentElement;
      row.parentElement.addEventListener("click", (e) => prevented.push(e.defaultPrevented));
      const fire = (o) => b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...o }));
      fire({ ctrlKey: true }); fire({ metaKey: true }); fire({ shiftKey: true }); fire({ button: 1 });
      window.modClicks = prevented.slice();
      fire({});
      window.plainClick = prevented.at(-1);
    })()`);
    expect(await js<boolean[]>(p, "window.modClicks")).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(await js<boolean>(p, "window.plainClick")).toBe(true);
    expect(await changes(p)).toEqual([["pn", "keys"]]);
    await p.context().close();
  });
});

describe("tabs in a browser: narrow rows", () => {
  it("never wraps: one row that scrolls, with » shown only while tabs are hidden past it", async () => {
    if (skip()) return;
    const p = await open();
    const [rowH, tabH, sw, cw] = await js<number[]>(
      p,
      `(() => { const r = document.querySelector("#narrow .den-tabs-row"); return [r.getBoundingClientRect().height, document.querySelector("#narrow .den-tab").getBoundingClientRect().height + 2, r.scrollWidth, r.clientWidth]; })()`,
    );
    expect(Math.round(rowH)).toBe(Math.round(tabH));
    expect(sw).toBeGreaterThan(cw);
    expect(await css(p, "#narrow .den-tabs", "width")).toBe("300px");
    expect(
      await js<string>(
        p,
        "document.querySelector('#narrow .den-tabs').dataset.denTabsOver",
      ),
    ).toBe("end");
    expect(
      await js<boolean[]>(
        p,
        `[...document.querySelectorAll("#narrow .den-tabs-edge")].map((b) => b.hidden)`,
      ),
    ).toEqual([true, false]);
    expect(
      await js<boolean>(
        p,
        `document.querySelector("#narrow [data-den-tabs-edge=end] .den-tabs-dot").hidden`,
      ),
    ).toBe(false);
    await tab(p, "narrow", "m0").focus();
    await p.keyboard.press("End");
    await p.waitForFunction(
      "document.querySelector('#narrow .den-tabs').dataset.denTabsOver === 'start'",
    );
    const inView = await js<boolean>(
      p,
      `(() => { const r = document.querySelector("#narrow .den-tabs-row").getBoundingClientRect(); const b = document.querySelector('#narrow .den-tab[data-id="m7"]').getBoundingClientRect(); return b.left >= r.left && b.right <= r.right + 1; })()`,
    );
    expect(inView).toBe(true);
    expect(
      await js<number>(p, "document.documentElement.scrollWidth"),
    ).toBeLessThanOrEqual(1280);
    await p.context().close();
  });

  it("folds into one labelled select when even one tab can't fit", async () => {
    if (skip()) return;
    const p = await open();
    expect(
      await js<boolean[]>(
        p,
        `(() => { const t = document.querySelector("#tiny .den-tabs"); return [t.hasAttribute("data-folded"), t.querySelector(".den-tabs-row").hidden, t.querySelector(".den-tabs-fold").hidden]; })()`,
      ),
    ).toEqual([true, true, false]);
    const sel = p.locator("#tiny").getByRole("combobox", { name: "Sections" });
    expect(await sel.inputValue()).toBe("m2");
    await sel.selectOption("m5");
    expect(await changes(p)).toEqual([["tiny", "m5"]]);
    expect(await js<string>(p, "handles.tiny.chosen()")).toBe("m5");
    await p.context().close();
  });
});

describe("tabs in a browser: right to left", () => {
  it.each([
    ["rtl", "a dir=rtl ancestor"],
    ["rtlcss", "CSS direction only"],
  ])(
    "%s (%s): « and » point the reading way, at the right ends, with the fade facing in",
    async (host) => {
      if (skip()) return;
      const p = await open();
      const edges = await js<[string, string, boolean, number][]>(
        p,
        `[...document.querySelectorAll("#${host} .den-tabs-edge")].map((b) => [b.dataset.denTabsEdge, b.firstChild.textContent, b.hidden, Math.round(b.getBoundingClientRect().left)])`,
      );
      const at = Object.fromEntries(edges.map((e) => [e[0], e]));
      expect(at.start![1]).toBe("»");
      expect(at.end![1]).toBe("«");
      expect(at.start![2]).toBe(true);
      expect(at.end![2]).toBe(false);
      const box = await js<number[]>(
        p,
        `(() => { const r = document.querySelector("#${host} .den-tabs").getBoundingClientRect(); return [r.left, r.right]; })()`,
      );
      expect(at.end![3]).toBeLessThan(box[0]! + 40);
      expect(
        await css(
          p,
          `#${host} [data-den-tabs-edge=end]`,
          "background-image",
          "::before",
        ),
      ).toMatch(/^linear-gradient\(to right,/);
      expect(
        await css(
          p,
          `#${host} [data-den-tabs-edge=start]`,
          "background-image",
          "::before",
        ),
      ).toMatch(/^linear-gradient\(to left,/);
      await tab(p, host, "m0").focus();
      await p.keyboard.press("ArrowLeft");
      expect(await focused(p)).toBe("m1");
      await p.context().close();
    },
  );

  it("left to right keeps « at the start and the fade facing in", async () => {
    if (skip()) return;
    const p = await open();
    expect(
      await js<string[]>(
        p,
        `[...document.querySelectorAll("#narrow .den-tabs-edge")].map((b) => b.firstChild.textContent)`,
      ),
    ).toEqual(["«", "»"]);
    expect(
      await css(
        p,
        "#narrow [data-den-tabs-edge=end]",
        "background-image",
        "::before",
      ),
    ).toMatch(/^linear-gradient\(to left,/);
    await p.context().close();
  });

  it("rounds the outer corners and draws the dividers on the reading side", async () => {
    if (skip()) return;
    const p = await open();
    const sel = (i: number) => `#rtlwide [data-id="${"abc"[i - 1]}"]`;
    const r = (i: number, c: string) => css(p, sel(i), `border-${c}-radius`);
    expect(await r(1, "top-left")).toBe("0px");
    expect(await r(1, "top-right")).not.toBe("0px");
    expect(await r(1, "bottom-right")).not.toBe("0px");
    expect(await r(3, "top-right")).toBe("0px");
    expect(await r(3, "top-left")).not.toBe("0px");
    expect(await r(3, "bottom-left")).not.toBe("0px");
    expect(await css(p, sel(1), "border-right-width")).toBe("0px");
    expect(await css(p, sel(2), "border-right-width")).toBe("1px");
    expect(await css(p, sel(2), "border-left-width")).toBe("0px");
    await p.context().close();
  });
});

describe("tabs in a browser: forced colours", () => {
  it("outlines the chosen segment in Highlight", async () => {
    if (skip()) return;
    const p = await open({ forced: true });
    expect(await css(p, '#sw .den-tab[data-id="board"]', "outline-style")).toBe(
      "solid",
    );
    expect(await css(p, '#sw .den-tab[data-id="board"]', "outline-width")).toBe(
      "2px",
    );
    expect(await css(p, '#sw .den-tab[data-id="list"]', "outline-style")).toBe(
      "none",
    );
    await p.context().close();
  });
});
