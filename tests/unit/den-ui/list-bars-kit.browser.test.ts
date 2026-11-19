/**
 * den-ui: the filter bar (issue 552) and the bulk bar (issue 553) in a
 * browser, with no product around them: a bare page loads tokens.css,
 * base.css, both bars' CSS and JS, and a host script that passes data and
 * callbacks. The page is served under `script-src 'self'; style-src
 * 'self'`, and any violation fails. Playwright's own headless Chromium.
 *
 * Filter bar:
 *   - the accessibility tree: "Filters (2)" (expanded false) controls a
 *     group named Filters; "Chosen filters" lists the chips
 *   - keys: Enter opens, Esc in the panel closes and focus goes back to
 *     Filters; Space on an option chooses it, focus stays on it; removing
 *     a chip focuses the next one, then the one before, then Filters;
 *     Clear all focuses Filters; a facet's Clear focuses its first option;
 *     a host's update() keeps focus where it was
 *   - 1280: the host's find box, Filters and the host's Sort on one line,
 *     the chips under it (wrapping), the panel under them
 *   - 390: no sideways page scroll; the find box on its own line; the chips
 *     scroll in their own row (one line); every control is 44px tall
 * Bulk bar:
 *   - hidden at 0; with 3 a region named "3 selected", said once by a
 *     polite live region; Clear, then the actions, a disabled one skipped
 *   - sticky: 12px over the bottom of the window while the list scrolls
 *   - an action calls the host, which opens the kit's dialog with the
 *     button as opener: Esc brings focus back to the button
 *   - Clear: the bar hides, the host hears it, focus goes where the host
 *     says, "Selection cleared" is said
 *   - 390: no sideways scroll; each action the bar's width, 44px tall
 * Both, light and dark: colours come from the kit's tokens of that mode
 * and each text passes WCAG AA on what is behind it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'";
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser] });
});

const skip = () => !browser;

const ROWS = Array.from(
  { length: 60 },
  (_, i) =>
    `<li><input type="checkbox" aria-label="Row ${i + 1}"> Row ${i + 1}</li>`,
).join("");

const PAGE = (lang: string, mode: string) => `<!doctype html>
<html lang="${lang}"${mode ? ` data-mode="${mode}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/filter-bar.css"><link rel="stylesheet" href="/bulk-bar.css">
<link rel="stylesheet" href="/dialog.css"><link rel="stylesheet" href="/page.css"></head>
<body><main id="main">
<input id="find" type="search" aria-label="Find in the list">
<button id="sort" type="button">Sort</button>
<div id="fb"></div>
<label class="all"><input type="checkbox" id="all"> All</label>
<ul id="list">${ROWS}</ul>
<div id="bulk"></div>
</main><script type="module" src="/page.js"></script></body></html>`;

// The host's own page: its look and its script, both 'self'.
const PAGE_CSS = `body { margin: 0; background: var(--bg); color: var(--text);
  font-family: var(--sans); font-size: var(--fs-m); }
main { padding: 16px; }
#find { min-height: 36px; box-sizing: border-box; font: inherit; }
#sort { min-height: 36px; font: inherit; }
#list { list-style: none; margin: 0; padding: 0; }
#list li { height: 40px; display: flex; align-items: center; gap: 8px; }`;

const PAGE_JS = `
import { mountFilterBar } from "/filter-bar.js";
import { mountBulkBar } from "/bulk-bar.js";
import { askConfirm } from "/dialog.js";
window.FACETS = [
  { id: "kind", label: "Kind", options: [
    { value: "doc", label: "Docs", count: 12 },
    { value: "mock", label: "Mocks", count: 4 },
    { value: "image", label: "Images", count: 0 } ] },
  { id: "made", label: "Made by", options: [
    { value: "people", label: "People", count: 7 },
    { value: "agents", label: "Agents", count: 9 },
    { value: "mine", label: "My agents", count: 2 } ] },
  { id: "status", label: "Status", options: [
    { value: "draft", label: "Draft", count: 2 },
    { value: "review", label: "In review", count: 5 },
    { value: "paused", label: "Paused", count: 1 } ] },
];
window.changes = [];
window.fb = mountFilterBar(document.getElementById("fb"), {
  id: "fb",
  facets: FACETS,
  selected: { status: ["draft"], made: ["mine"] },
  start: document.getElementById("find"),
  end: document.getElementById("sort"),
  onChange: (selected, change) => changes.push({ selected, change }),
});
window.acts = [];
window.clears = 0;
window.bulk = mountBulkBar(document.getElementById("bulk"), {
  count: 0,
  actions: [],
  onAction: (id, button) => {
    acts.push(id);
    if (id === "replace")
      window.asked = askConfirm({ title: "Replace them?", message: "Pick one.", opener: button });
  },
  onClear: () => { clears++; },
  returnFocus: () => document.getElementById("all"),
});
window.ready = true;
`;

const SERVED = new Set([
  "tokens.css",
  "base.css",
  "filter-bar.css",
  "bulk-bar.css",
  "dialog.css",
  "filter-bar.js",
  "bulk-bar.js",
  "dialog.js",
  "strings.js",
]);

async function open(
  o: { lang?: string; mode?: string; width?: number } = {},
): Promise<Page> {
  const width = o.width ?? 1280;
  const ctx = await browser!.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
    colorScheme: o.mode === "dark" ? "dark" : "light",
    locale: o.lang ?? "en",
  });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    (window as unknown as { csp: string[] }).csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { csp: string[] }).csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    const headers = { "content-security-policy": CSP };
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        headers,
        body: PAGE(o.lang ?? "en", o.mode ?? ""),
      });
    if (u.pathname === "/page.js")
      return r.fulfill({ contentType: "text/javascript", body: PAGE_JS });
    if (u.pathname === "/page.css")
      return r.fulfill({ contentType: "text/css", body: PAGE_CSS });
    const f = u.pathname.slice(1);
    if (SERVED.has(f) && fs.existsSync(path.join(SRC, f)))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(path.join(SRC, f), "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${ORIGIN}/`);
  await p
    .waitForFunction(
      () => (window as { ready?: boolean }).ready === true,
      null,
      { timeout: 10_000 },
    )
    .catch((e: Error) => {
      throw new Error(`page not ready: ${errors.join("; ") || e.message}`);
    });
  return p;
}

async function done(p: Page) {
  expect(
    await p.evaluate(() => (window as unknown as { csp: string[] }).csp),
  ).toEqual([]);
  await p.context().close();
}

type Change = { selected: Record<string, string[]>; change: unknown };
const lastChange = (p: Page) =>
  p.evaluate(() => {
    const c = (window as unknown as { changes: Change[] }).changes;
    return c[c.length - 1] ?? null;
  });
/** What has focus: its class and accessible text. */
const focused = (p: Page) =>
  p.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "body";
    return `${a.id ? `#${a.id}` : `.${a.className}`} ${(a.getAttribute("aria-label") ?? a.textContent ?? "").trim()}`;
  });
const toggle = (p: Page) => p.locator(".den-fb-toggle");

describe("filter bar in a browser", () => {
  it("the accessibility tree: Filters (2) controls the Filters group; Chosen filters lists the chips", async () => {
    if (skip()) return;
    const p = await open();
    const btn = p.getByRole("button", { name: "Filters (2)", expanded: false });
    expect(await btn.count()).toBe(1);
    expect(await p.getByRole("group", { name: "Filters" }).count()).toBe(0);
    const chips = p.getByRole("list", { name: "Chosen filters" });
    expect(
      await chips
        .getByRole("button")
        .evaluateAll((els) =>
          els.map((e) => e.getAttribute("aria-label") ?? e.textContent!.trim()),
        ),
    ).toEqual([
      "Remove Made by: My agents",
      "Remove Status: Draft",
      "Clear all",
    ]);
    await btn.click();
    const panel = p.getByRole("group", { name: "Filters" });
    expect(await panel.isVisible()).toBe(true);
    expect(
      await p
        .getByRole("button", { name: "Filters (2)", expanded: true })
        .count(),
    ).toBe(1);
    expect(await panel.getByRole("group", { name: "Status" }).count()).toBe(1);
    expect(
      await panel
        .getByRole("group", { name: "Status" })
        .getByRole("button", { pressed: true })
        .count(),
    ).toBe(1);
    // A count of 0 can't be chosen.
    expect(
      await panel.getByRole("button", { name: /Images/ }).isDisabled(),
    ).toBe(true);
    await done(p);
  });

  it("keys: Enter opens, Space chooses and keeps focus, Esc closes back to Filters", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus("#find");
    await p.keyboard.press("Tab");
    expect(await focused(p)).toBe(".den-fb-toggle Filters (2)");
    await p.keyboard.press("Enter");
    expect(await toggle(p).getAttribute("aria-expanded")).toBe("true");
    const paused = p.locator('.den-fb-opt[data-value="paused"]');
    await paused.focus();
    await p.keyboard.press("Space");
    expect(await paused.getAttribute("aria-pressed")).toBe("true");
    expect(
      await p.evaluate(() =>
        document.activeElement?.getAttribute("data-value"),
      ),
    ).toBe("paused");
    expect((await toggle(p).textContent())!.trim()).toBe("Filters (3)");
    expect(await lastChange(p)).toEqual({
      selected: { made: ["mine"], status: ["draft", "paused"] },
      change: { facet: "status", value: "paused", on: true },
    });
    await p.keyboard.press("Escape");
    expect(await toggle(p).getAttribute("aria-expanded")).toBe("false");
    expect(await p.locator(".den-fb-panel").isVisible()).toBe(false);
    expect(await focused(p)).toBe(".den-fb-toggle Filters (3)");
    await done(p);
  });

  it("removing a chip focuses the next, then the one before, then Filters", async () => {
    if (skip()) return;
    const p = await open();
    await p.evaluate(() =>
      (window as unknown as { fb: { update: (d: object) => void } }).fb.update({
        selected: { kind: ["doc"], made: ["mine"], status: ["draft"] },
      }),
    );
    const chip = (n: number) => p.locator(".den-fb-chip").nth(n);
    await chip(1).focus();
    await p.keyboard.press("Enter");
    expect(await focused(p)).toBe(".den-fb-chip Remove Status: Draft");
    expect(await lastChange(p)).toEqual({
      selected: { kind: ["doc"], status: ["draft"] },
      change: { facet: "made", value: "mine", on: false },
    });
    await p.keyboard.press("Enter");
    expect(await focused(p)).toBe(".den-fb-chip Remove Kind: Docs");
    await p.keyboard.press("Enter");
    expect(await p.locator(".den-fb-chip").count()).toBe(0);
    expect(await p.locator(".den-fb-chips").count()).toBe(0);
    expect(await focused(p)).toBe(".den-fb-toggle Filters");
    await done(p);
  });

  it("Clear all focuses Filters; a facet's Clear its first option; update() keeps focus", async () => {
    if (skip()) return;
    const p = await open();
    await p.locator(".den-fb-clear-all").focus();
    await p.keyboard.press("Enter");
    expect(await focused(p)).toBe(".den-fb-toggle Filters");
    expect(await lastChange(p)).toEqual({
      selected: {},
      change: { clear: null },
    });
    await p.keyboard.press("Enter");
    await p.locator('.den-fb-opt[data-value="review"]').focus();
    await p.keyboard.press("Space");
    const clear = p.locator('.den-fb-facet-clear[data-facet="status"]');
    expect(await clear.getAttribute("aria-label")).toBe("Clear Status");
    await clear.focus();
    await p.keyboard.press("Enter");
    expect(await lastChange(p)).toEqual({
      selected: {},
      change: { clear: "status" },
    });
    expect(
      await p.evaluate(() =>
        document.activeElement?.getAttribute("data-value"),
      ),
    ).toBe("draft");
    // The host sends new counts: focus stays on the same option.
    await p.evaluate(() => {
      const w = window as unknown as {
        fb: { update: (d: object) => void };
        FACETS: { options: { count: number }[] }[];
      };
      w.FACETS[2]!.options[0]!.count = 40;
      w.fb.update({ facets: w.FACETS });
    });
    expect(
      await p.evaluate(() =>
        document.activeElement?.getAttribute("data-value"),
      ),
    ).toBe("draft");
    expect(
      await p
        .locator('.den-fb-opt[data-value="draft"] .den-fb-n')
        .textContent(),
    ).toBe("40");
    await done(p);
  });

  it("1280: find, Filters and Sort on one line; chips wrap under it; the panel under them", async () => {
    if (skip()) return;
    const p = await open();
    await toggle(p).click();
    const box = async (sel: string) =>
      (await p.locator(sel).first().boundingBox())!;
    const find = await box("#find");
    const btn = await box(".den-fb-toggle");
    const sort = await box("#sort");
    const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
    expect(Math.abs(mid(find) - mid(btn))).toBeLessThanOrEqual(2);
    expect(Math.abs(mid(sort) - mid(btn))).toBeLessThanOrEqual(2);
    expect(find.x).toBeLessThan(btn.x);
    expect(btn.x).toBeLessThan(sort.x);
    const chips = await box(".den-fb-chips");
    const panel = await box(".den-fb-panel");
    expect(chips.y).toBeGreaterThanOrEqual(btn.y + btn.height);
    expect(panel.y).toBeGreaterThanOrEqual(chips.y + chips.height);
    expect(
      await p
        .locator(".den-fb-chips")
        .evaluate((e) => getComputedStyle(e).flexWrap),
    ).toBe("wrap");
    await done(p);
  });

  it("390: no sideways scroll, find on its own line, chips scroll in one row, 44px controls", async () => {
    if (skip()) return;
    const p = await open({ width: 390 });
    await p.evaluate(() =>
      (window as unknown as { fb: { update: (d: object) => void } }).fb.update({
        selected: {
          kind: ["doc", "mock"],
          made: ["people", "agents", "mine"],
          status: ["draft", "review", "paused"],
        },
      }),
    );
    await toggle(p).click();
    expect(
      await p.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    const find = (await p.locator("#find").boundingBox())!;
    const btn = (await toggle(p).boundingBox())!;
    expect(btn.y).toBeGreaterThanOrEqual(find.y + find.height);
    const row = await p.locator(".den-fb-chips").evaluate((e) => ({
      scroll: e.scrollWidth,
      client: e.clientWidth,
      overflow: getComputedStyle(e).overflowX,
      tops: [...e.querySelectorAll("button")].map(
        (b) => b.getBoundingClientRect().top,
      ),
    }));
    expect(row.overflow).toBe("auto");
    expect(row.scroll).toBeGreaterThan(row.client);
    expect(new Set(row.tops).size).toBe(1);
    const heights = await p
      .locator(
        ".den-fb-toggle, .den-fb-chip, .den-fb-clear-all, .den-fb-opt, .den-fb-facet-clear",
      )
      .evaluateAll((els) =>
        els.map(
          (e) => [e.className, e.getBoundingClientRect().height] as const,
        ),
      );
    expect(heights.length).toBeGreaterThan(10);
    for (const [c, h] of heights) expect([c, h >= 44]).toEqual([c, true]);
    await done(p);
  });

  it("es and ja: the kit's words", async () => {
    if (skip()) return;
    const es = await open({ lang: "es" });
    expect((await toggle(es).textContent())!.trim()).toBe("Filtros (2)");
    expect(
      await es.getByRole("list", { name: "Filtros elegidos" }).count(),
    ).toBe(1);
    await done(es);
    const ja = await open({ lang: "ja" });
    expect((await toggle(ja).textContent())!.trim()).toBe("絞り込み（2）");
    expect(
      await ja.getByRole("button", { name: "Status：Draft を外す" }).count(),
    ).toBe(1);
    await done(ja);
  });
});

const bulkSet = (p: Page, count: number) =>
  p.evaluate((n) => {
    (
      window as unknown as { bulk: { update: (d: object) => void } }
    ).bulk.update({
      count: n,
      actions: [
        { id: "pause", label: "Pause", count: n },
        { id: "wont", label: "Won’t do", count: n },
        { id: "replace", label: "Replaced by…", count: n },
        { id: "move", label: "Move", count: 0, disabled: true },
      ],
    });
  }, count);

describe("bulk bar in a browser", () => {
  it("hidden at 0; with 3 a region named 3 selected, said once, Clear then the actions", async () => {
    if (skip()) return;
    const p = await open();
    const bar = p.locator(".den-bulk");
    expect(await bar.isVisible()).toBe(false);
    await bulkSet(p, 3);
    expect(await bar.isVisible()).toBe(true);
    const region = p.getByRole("region", { name: "3 selected" });
    expect(await region.count()).toBe(1);
    expect(await p.locator(".den-bulk-live").textContent()).toBe("3 selected");
    expect(await p.locator(".den-bulk-live").getAttribute("aria-live")).toBe(
      "polite",
    );
    // From the last row, Tab goes into the bar.
    await p.locator("#list input").last().focus();
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      await p.keyboard.press("Tab");
      order.push(
        await p.evaluate(() => document.activeElement!.textContent!.trim()),
      );
    }
    expect(order.slice(0, 4)).toEqual([
      "Clear",
      "Pause 3",
      "Won’t do 3",
      "Replaced by… 3",
    ]);
    await p.keyboard.press("Tab");
    expect(
      await p.evaluate(() => document.activeElement!.textContent!.trim()),
    ).not.toBe("Move 0");
    await done(p);
  });

  it("sticks 12px over the bottom of the window while the list scrolls", async () => {
    if (skip()) return;
    const p = await open();
    await bulkSet(p, 3);
    for (const y of [0, 600]) {
      await p.evaluate((top) => window.scrollTo(0, top), y);
      const b = (await p.locator(".den-bulk").boundingBox())!;
      expect(Math.round(b.y + b.height)).toBe(800 - 12);
    }
    await done(p);
  });

  it("an action calls the host; its dialog gives focus back to the button", async () => {
    if (skip()) return;
    const p = await open();
    await bulkSet(p, 3);
    const btn = p.getByRole("button", { name: "Replaced by… 3" });
    await btn.focus();
    await p.keyboard.press("Enter");
    expect(
      await p.evaluate(() => (window as unknown as { acts: string[] }).acts),
    ).toEqual(["replace"]);
    const dlg = p.getByRole("alertdialog", { name: "Replace them?" });
    await dlg.waitFor();
    await p.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached" });
    expect(
      await p.evaluate(() => document.activeElement!.textContent!.trim()),
    ).toBe("Replaced by… 3");
    // A disabled action never reaches the host.
    await p.locator('.den-bulk-act[data-action="move"]').click({ force: true });
    expect(
      await p.evaluate(() => (window as unknown as { acts: string[] }).acts),
    ).toEqual(["replace"]);
    await done(p);
  });

  it("Clear: hides, tells the host, focus goes where the host says, and it is said", async () => {
    if (skip()) return;
    const p = await open();
    await bulkSet(p, 3);
    await p.locator(".den-bulk-clear").focus();
    await p.keyboard.press("Enter");
    expect(await p.locator(".den-bulk").isVisible()).toBe(false);
    expect(
      await p.evaluate(() => (window as unknown as { clears: number }).clears),
    ).toBe(1);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("all");
    expect(await p.locator(".den-bulk-live").textContent()).toBe(
      "Selection cleared",
    );
    await done(p);
  });

  it("390: no sideways scroll; each action the bar's width and 44px tall", async () => {
    if (skip()) return;
    const p = await open({ width: 390 });
    await bulkSet(p, 3);
    expect(
      await p.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    const m = await p.locator(".den-bulk").evaluate((bar) => {
      const acts = bar
        .querySelector(".den-bulk-actions")!
        .getBoundingClientRect();
      return {
        acts: acts.width,
        buttons: [...bar.querySelectorAll("button")].map((b) => {
          const r = b.getBoundingClientRect();
          return {
            w: r.width,
            h: r.height,
            act: b.classList.contains("den-bulk-act"),
          };
        }),
      };
    });
    for (const b of m.buttons) {
      expect(b.h).toBeGreaterThanOrEqual(44);
      if (b.act) expect(Math.abs(b.w - m.acts)).toBeLessThanOrEqual(1);
    }
    await done(p);
  });
});

/** Every text on the bars passes AA on what is behind it, in this mode. */
async function themeCheck(mode: "light" | "dark") {
  const p = await open({ mode });
  await toggle(p).click();
  await bulkSet(p, 3);
  const r = await p.evaluate(() => {
    const rgb = (c: string): number[] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (m)
        return m[1]!
          .split(/[ ,/]+/)
          .filter(Boolean)
          .map(Number);
      const s = c.match(/color\(srgb ([^)]+)\)/);
      if (s)
        return s[1]!
          .split(/[ /]+/)
          .filter(Boolean)
          .map((x, i) => (i < 3 ? Number(x) * 255 : Number(x)));
      throw new Error(`colour? ${c}`);
    };
    const lum = (c: number[]) => {
      const [r, g, b] = c.slice(0, 3).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    /** The first opaque background up the tree. */
    const behind = (el: Element | null): number[] => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor);
        if ((c[3] ?? 1) > 0.5) return c;
      }
      return rgb(getComputedStyle(document.body).backgroundColor);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (x! + 0.05) / (y! + 0.05);
    };
    const token = (name: string) => {
      const probe = document.createElement("i");
      probe.style.color = `var(${name})`;
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    };
    const sel = [
      ".den-fb-toggle",
      ".den-fb-chip",
      ".den-fb-chip-facet",
      ".den-fb-clear-all",
      '.den-fb-opt[aria-pressed="true"]',
      '.den-fb-opt[aria-pressed="false"]:not([disabled])',
      ".den-fb-n",
      ".den-fb-facet-name",
      ".den-bulk-count",
      ".den-bulk-clear",
      ".den-bulk-act:not([disabled])",
    ];
    const pairs = sel.map((s) => {
      const el = document.querySelector(s);
      if (!el) return [s, 0] as const;
      return [s, ratio(rgb(getComputedStyle(el).color), behind(el))] as const;
    });
    return {
      pairs,
      bulkBg: getComputedStyle(document.querySelector(".den-bulk")!)
        .backgroundColor,
      panelBg: getComputedStyle(document.querySelector(".den-fb-panel")!)
        .backgroundColor,
      chipBorder: getComputedStyle(document.querySelector(".den-fb-chip")!)
        .borderTopColor,
      surface: token("--surface"),
      accent: token("--accent"),
    };
  });
  for (const [s, c] of r.pairs) expect([s, c >= 4.5]).toEqual([s, true]);
  expect(r.bulkBg).toBe(r.surface);
  expect(r.panelBg).toBe(r.surface);
  expect(r.chipBorder).toBe(r.accent);
  await done(p);
  return r.surface;
}

describe("both bars, light and dark", () => {
  it("tokens of each mode; every text passes AA", async () => {
    if (skip()) return;
    const light = await themeCheck("light");
    const dark = await themeCheck("dark");
    expect(light).not.toBe(dark);
  });
});
