/**
 * Issue 313: the top bar's remaining shared slots, in Chromium and WebKit,
 * on a bare page built from the kit's own files (the checks that need no
 * browser are topbar-slots-313.test.ts).
 *
 *   1. Chips from data: the end slot's chips are the kit's (chipHtml).
 *   2. The ⋯ overflow: chips that don't fit go behind ⋯, a kit menu that
 *      names each; a pick clicks the chip; wider again, they come back.
 *   4. The inventory: a host's own HTML around the bar (a banner, a
 *      wrapper that moves the bar, its own header and nav) is no
 *      difference, and no warning.
 *   5. Crumb labels at 1280 (and narrower): each visible label is whole,
 *      or ends in "…" (text-overflow: ellipsis) and is at least the kit's
 *      least width, or is hidden. Never part of a glyph.
 *
 * DEN_PW_WS: Den's own Playwright server instead of a local browser.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import {
  collectNav,
  compareNav,
  navWarnings,
} from "../../../packages/den-ui/inventory/nav-inventory.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit313.test";
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

const STYLES = ["tokens", "fonts", "base", "shell", "report", "dialog"];

/** `around`: the host's own HTML around the bar. */
const page = (around: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${STYLES.map((s) => `<link rel="stylesheet" href="/kit/${s}.css">`).join("\n")}
<style>body { margin: 0; }
#host-wrap { transform: translate(0, 40px); }
#host-banner { height: 40px; background: #eee; }</style>
</head>
<body class="den-has-shell">
${
  around
    ? `<div id="host-banner" role="note"><header><nav><a href="#x">Host</a><button type="button">Host button</button></nav></header></div>
<div id="host-wrap"><div class="den-shell" id="den-shell"></div></div>`
    : `<div class="den-shell" id="den-shell"></div>`
}
<main id="den-content"><header><h1>Page</h1></header><nav><a href="#y">Elsewhere</a></nav></main>
<script type="module" src="/app.js"></script>
</body></html>`;

/**
 * `?chips=N`: N chips from data, each a long status; `?long`: long crumbs.
 * A click on a chip is kept in window.clicked.
 */
const APP = `
import DenUI from "/kit/kit.js";
const q = new URLSearchParams(location.search);
window.clicked = [];
DenUI.configure({ lang: "en", product: { name: "Acme" } });
const long = q.has("long");
const crumbs = [
  { key: "org", label: "Company", value: long ? "The North Country Cooperative of Gardeners and Growers" : "North Co" },
  { key: "ws", label: "Project", value: long ? "The Quarterly Planning Project With A Very Long Name Too" : "Garden", menu: [{ label: "Garden", href: "#g", current: true }] },
  { key: "env", label: "Env", value: "local", menu: '<a href="#staging" role="menuitem">staging</a>' },
];
const n = Number(q.get("chips") || 0);
const chips = Array.from({ length: n }, (_, i) => ({
  id: "chip-" + i,
  dot: i % 2 ? "warn" : "",
  text: "Status number " + i + " is fine",
}));
const model = {
  product: { name: "Acme", version: "1.0.0", mark: { text: "A", label: "Acme" } },
  groups: [{ id: "work", label: "Work" }],
  nav: [{ id: "home", label: "Home", href: "/", group: "work", icon: "home", current: true }],
  slots: {
    start: DenUI.scopeHtml({ crumbs }) + DenUI.searchHtml(),
    end: chips,
    bell: { count: 2 },
    account: {},
  },
  settings: { href: "#settings" },
  account: { name: "Ada Lovelace", login: "ada", href: "#account" },
};
window.shell = DenUI.mount(document.getElementById("den-shell"), model);
document.addEventListener("click", (e) => {
  const c = e.target.closest && e.target.closest('[data-nav-kit="chip"]');
  if (c) window.clicked.push(c.id);
});
document.fonts.ready.then(() => { window.shell.fitTop(); window.ready = true; });
`;

async function open(
  b: Browser,
  query = "",
  width = 1280,
  around = false,
): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: page(around) });
    if (u.pathname === "/app.js")
      return r.fulfill({ contentType: "text/javascript", body: APP });
    const f = u.pathname.replace(/^\/kit\//, "");
    const file = path.join(SRC, f);
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: f.endsWith(".css")
          ? "text/css"
          : f.endsWith(".woff2")
            ? "font/woff2"
            : "text/javascript",
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/${query}`);
  await p.waitForFunction(
    () => (window as { ready?: boolean }).ready === true,
    undefined,
    { timeout: 10_000 },
  );
  return p;
}

/** Each crumb label that shows part of a glyph: "label: why". */
const badLabels = (p: Page) =>
  p.evaluate(() => {
    const out: string[] = [];
    const min =
      parseFloat(
        getComputedStyle(document.querySelector("header")!).getPropertyValue(
          "--den-crumb-label-min",
        ),
      ) || 24;
    for (const c of document.querySelectorAll('[data-nav-role="crumb"]')) {
      if (!c.getClientRects().length) continue;
      const k = c.firstElementChild as HTMLElement | null;
      if (!k || !k.getClientRects().length) continue;
      const word = k.textContent || "";
      if (k.scrollWidth <= k.clientWidth + 0.5) continue;
      const cs = getComputedStyle(k);
      if (cs.textOverflow !== "ellipsis")
        out.push(`${word}: cut with ${cs.textOverflow}`);
      else if (k.clientWidth < min)
        out.push(`${word}: ${k.clientWidth}px, under ${min}px`);
    }
    return out;
  });

/** The chips' state: shown ids, ids behind ⋯, any outside its group. */
const chipState = (p: Page) =>
  p.evaluate(() => {
    const chips = [
      ...document.querySelectorAll('[data-nav-kit="chip"]'),
    ] as HTMLElement[];
    const group = chips.length ? chips[0]!.parentElement! : null;
    const g = group ? group.getBoundingClientRect() : null;
    const more = document.getElementById("den-chips-more");
    const shown = chips.filter((c) => c.getClientRects().length);
    return {
      shown: shown.map((c) => c.id),
      over: chips
        .filter((c) => c.hasAttribute("data-den-over"))
        .map((c) => c.id),
      outside: shown
        .filter((c) => {
          const b = c.getBoundingClientRect();
          return !g || b.left < g.left - 0.5 || b.right > g.right + 0.5;
        })
        .map((c) => c.id),
      more: !!more && more.getClientRects().length > 0,
      moreName: more ? more.getAttribute("aria-label") : null,
    };
  });

for (const engine of ["chromium", "webkit"]) {
  describe(`issue 313: the top bar's shared slots (${engine})`, () => {
    it("1. draws the end slot's chips from data", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?chips=2");
      const s = await chipState(p);
      expect(s.shown).toEqual(["chip-0", "chip-1"]);
      expect(s.over).toEqual([]);
      expect(s.more).toBe(false);
      await p.context().close();
    }, 60_000);

    it("2. chips that don't fit go behind ⋯; a pick clicks the chip; wider, they come back", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, "?chips=8", 1000);
      const s = await chipState(p);
      expect(s.over.length).toBeGreaterThan(0);
      expect(s.outside).toEqual([]);
      expect(s.more).toBe(true);
      // The chips behind ⋯ are the last ones, in order.
      expect([...s.shown, ...s.over]).toEqual(
        Array.from({ length: 8 }, (_, i) => `chip-${i}`),
      );
      await p.click("#den-chips-more");
      const menu = p.getByRole("menu");
      await menu.waitFor();
      expect(await menu.getByRole("menuitem").count()).toBe(s.over.length);
      const last = s.over[s.over.length - 1]!;
      await menu
        .getByRole("menuitem", {
          name: new RegExp(last.replace("chip-", "") + " is"),
        })
        .click();
      expect(
        await p.evaluate(() => (window as { clicked?: string[] }).clicked),
      ).toEqual([last]);
      // Wider: every chip comes back, and ⋯ goes.
      await p.setViewportSize({ width: 2400, height: 800 });
      await p.waitForFunction(
        () => !document.querySelector("[data-den-over]"),
        undefined,
        { timeout: 5000 },
      );
      const w = await chipState(p);
      expect(w.over).toEqual([]);
      expect(w.outside).toEqual([]);
      expect(w.more).toBe(false);
      await p.context().close();
    }, 60_000);

    it("4. a host's own HTML around the bar is no difference and no warning", async () => {
      const b = browsers[engine];
      if (!b) return;
      const plain = await open(b, "?chips=2");
      const around = await open(b, "?chips=2", 1280, true);
      const ref = await collectNav(plain);
      const got = await collectNav(around);
      // The bar really moved (the wrapper's 40px).
      const bar = (s: typeof ref) =>
        s.elements.find((e) => e.tag === "header" && e.parent == null)!.box.y;
      expect(bar(got) - bar(ref)).toBe(40);
      expect(compareNav(got, ref)).toEqual([]);
      expect(navWarnings(got)).toEqual([]);
      await plain.context().close();
      await around.context().close();
    }, 60_000);

    for (const width of [1280, 1100, 960, 900]) {
      it(`5. crumb labels at ${width}: whole, ending in …, or hidden`, async () => {
        const b = browsers[engine];
        if (!b) return;
        const p = await open(b, "?long&chips=2", width);
        expect(await badLabels(p)).toEqual([]);
        await p.context().close();
      }, 60_000);
    }
  });
}
