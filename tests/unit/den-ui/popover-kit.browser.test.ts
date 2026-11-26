/**
 * den-ui: the popover, a small non-modal box anchored to what opened it
 * (a button, a link, or a node in an SVG map), in a browser with no
 * product around it: a bare page links tokens.css, base.css and
 * popover.css and opens it with the kit's openPopover.
 *
 *   - role="dialog", named by its label, never aria-modal; an anchor that
 *     is a button (an HTML button, or anything with role="button", an SVG
 *     node too) says aria-haspopup="dialog", and aria-expanded and
 *     aria-controls while it is open
 *   - focus moves to its first control; Esc closes it and focus goes back
 *     to the anchor; onClose is called once
 *   - a press outside closes it, a press inside never does; a press on
 *     nothing puts focus back on the anchor, a press on a control gives it
 *     focus
 *   - a press on the open anchor closes it, and that press's click never
 *     reaches the anchor, so a page that opens it on click doesn't open it
 *     again (and a link anchor doesn't follow its href)
 *   - no focus trap: Tab past its last control closes it and goes on to
 *     what follows the anchor; Shift+Tab before its first goes back to the
 *     anchor
 *   - placed below the anchor, or above when there is no room, always
 *     8px inside the viewport; an SVG node anchors it too
 *   - all of it in Chromium and WebKit
 *   - opening a second closes the first
 *   - at 1280 and 390, light and dark: colours from the tokens, and it
 *     never runs past the viewport's edges
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
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

const PAGE = (mode: string) => `<!doctype html>
<html lang="en"${mode ? ` data-mode="${mode}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/popover.css">
<style>body { margin: 0; min-height: 1600px; } #low { position: absolute; top: 760px; left: 8px; }
#right { position: absolute; top: 40px; right: 4px; } svg { position: absolute; top: 200px; left: 300px; }</style></head>
<body>
<button id="open">Open</button>
<button id="other">Other</button>
<button id="low">Low</button>
<button id="right">R</button>
<svg width="200" height="120" viewBox="0 0 200 120"><a id="node" href="/item/1"><rect x="20" y="20" width="160" height="40"/></a><g id="nodebtn" role="button" tabindex="0" aria-label="Node button"><rect x="20" y="70" width="160" height="40"/></g></svg>
<script type="module">
import { openPopover } from "/popover.js";
window.calls = [];
const card = (n) => {
  const d = document.createElement("div");
  d.innerHTML = '<p>Card ' + n + '</p><a id="more-' + n + '" href="/more">View more</a> <button id="dive-' + n + '" type="button">Dive in</button>';
  return d;
};
window.openOn = (id, n = 1, o = {}) => {
  window.pop = openPopover(document.getElementById(id), {
    content: card(n),
    label: "Card " + n,
    onClose: () => calls.push(["close", n]),
    ...o,
  });
  return window.pop.el.id;
};
window.opens = 0;
// A page that opens the popover from its anchor's click, as a product does.
window.wire = (id) => document.getElementById(id).addEventListener("click", (e) => {
  e.preventDefault();
  window.opens++;
  window.openOn(id);
});
window.ready = true;
</script></body></html>`;

async function openPage(
  browser: Browser,
  o: { mode?: string; width?: number } = {},
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: o.width ?? 1280, height: 800 },
    reducedMotion: "reduce",
    colorScheme: o.mode === "dark" ? "dark" : "light",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE(o.mode ?? "") });
    const f = u.pathname.slice(1);
    if (/^[a-z-]+\.(js|css)$/.test(f) && fs.existsSync(path.join(SRC, f)))
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
    .catch(() => {
      throw new Error(
        `the page never got ready: ${errors.join("; ") || "no error"}`,
      );
    });
  return p;
}

type Box = { top: number; bottom: number; left: number; right: number };
const boxOf = (p: Page, sel: string) =>
  p.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
    } as Box;
  });
const calls = (p: Page) =>
  p.evaluate(() => (window as unknown as { calls: unknown[] }).calls);
const active = (p: Page) => p.evaluate(() => document.activeElement?.id ?? "");
/** Where focus is once it has had a moment to land on `want` (a press moves it after its own events). */
const settled = (p: Page, want: string) =>
  p
    .waitForFunction((w) => document.activeElement?.id === w, want, {
      timeout: 2_000,
    })
    .catch(() => undefined)
    .then(() => active(p));

const opens = (p: Page) =>
  p.evaluate(() => (window as unknown as { opens: number }).opens);
const openOn = (p: Page, id: string, n = 1) =>
  p.evaluate(
    ([i, k]) =>
      (
        window as unknown as { openOn: (i: string, n: number) => string }
      ).openOn(i as string, k as number),
    [id, n] as const,
  );

for (const engine of ["chromium", "webkit"])
  describe(`den-ui popover (${engine})`, () => {
    const skip = () => !browsers[engine];
    const open = (o: { mode?: string; width?: number } = {}) =>
      openPage(browsers[engine]!, o);

    it("is a named, non-modal dialog; a button anchor says it's open", async () => {
      if (skip()) return;
      const p = await open();
      const id = await p.evaluate(() =>
        (window as unknown as { openOn: (i: string) => string }).openOn("open"),
      );
      const pop = p.getByRole("dialog", { name: "Card 1" });
      await expect(pop.isVisible()).resolves.toBe(true);
      await expect(pop.getAttribute("aria-modal")).resolves.toBeNull();
      await expect(
        p.locator("#open").getAttribute("aria-expanded"),
      ).resolves.toBe("true");
      await expect(
        p.locator("#open").getAttribute("aria-controls"),
      ).resolves.toBe(id);
      await expect(
        p.locator("#open").getAttribute("aria-haspopup"),
      ).resolves.toBe("dialog");
      await expect(active(p)).resolves.toBe("more-1");
      await p.context().close();
    });

    it("Esc closes it, gives focus back to the anchor, and calls onClose once", async () => {
      if (skip()) return;
      const p = await open();
      await p.evaluate(() =>
        (window as unknown as { openOn: (i: string) => string }).openOn("open"),
      );
      await p.keyboard.press("Escape");
      await expect(p.getByRole("dialog").count()).resolves.toBe(0);
      await expect(active(p)).resolves.toBe("open");
      await expect(
        p.locator("#open").getAttribute("aria-expanded"),
      ).resolves.toBe("false");
      await expect(calls(p)).resolves.toEqual([["close", 1]]);
      await p.context().close();
    });

    it("a press inside keeps it; a press outside closes it", async () => {
      if (skip()) return;
      const p = await open();
      await p.evaluate(() =>
        (window as unknown as { openOn: (i: string) => string }).openOn("open"),
      );
      await p.getByRole("dialog").click({ position: { x: 4, y: 4 } });
      await expect(p.getByRole("dialog").count()).resolves.toBe(1);
      await p.mouse.click(900, 600);
      await expect(p.getByRole("dialog").count()).resolves.toBe(0);
      await expect(calls(p)).resolves.toEqual([["close", 1]]);
      await p.context().close();
    });

    it("no focus trap: Tab past its last control closes it and goes on to what follows the anchor", async () => {
      if (skip()) return;
      const p = await open();
      await openOn(p, "open");
      await p.locator("#dive-1").focus();
      await p.keyboard.press("Tab");
      await expect(p.getByRole("dialog").count()).resolves.toBe(0);
      await expect(active(p)).resolves.toBe("other");
      await expect(calls(p)).resolves.toEqual([["close", 1]]);
      await p.context().close();
    });

    it("Shift+Tab before its first control closes it and goes back to the anchor", async () => {
      if (skip()) return;
      const p = await open();
      await openOn(p, "open");
      await expect(active(p)).resolves.toBe("more-1");
      await p.keyboard.press("Shift+Tab");
      await expect(p.getByRole("dialog").count()).resolves.toBe(0);
      await expect(active(p)).resolves.toBe("open");
      await p.context().close();
    });

    it("a press on nothing outside puts focus back on the anchor; a press on a control gives it focus", async () => {
      if (skip()) return;
      const p = await open();
      await openOn(p, "open");
      await p.mouse.click(900, 600);
      await expect(p.getByRole("dialog").count()).resolves.toBe(0);
      await expect(settled(p, "open")).resolves.toBe("open");
      await openOn(p, "open", 2);
      await p.locator("#other").click();
      await expect(p.getByRole("dialog").count()).resolves.toBe(0);
      await expect(settled(p, "other")).resolves.toBe("other");
      await p.context().close();
    });

    it("a press on the open anchor closes it, and its click never opens it again", async () => {
      if (skip()) return;
      const p = await open();
      await p.evaluate(() =>
        (window as unknown as { wire: (i: string) => void }).wire("open"),
      );
      await p.locator("#open").click();
      await expect(p.getByRole("dialog").count()).resolves.toBe(1);
      await expect(opens(p)).resolves.toBe(1);
      await p.locator("#open").click();
      await expect(p.getByRole("dialog").count()).resolves.toBe(0);
      await expect(opens(p)).resolves.toBe(1);
      await expect(calls(p)).resolves.toEqual([["close", 1]]);
      await expect(active(p)).resolves.toBe("open");
      // The next press opens it again: only the closing press's click is held back.
      await p.locator("#open").click();
      await expect(p.getByRole("dialog").count()).resolves.toBe(1);
      await expect(opens(p)).resolves.toBe(2);
      await p.context().close();
    });

    it("a press on an open SVG link node closes it and doesn't follow the link", async () => {
      if (skip()) return;
      const p = await open();
      await p.evaluate(() =>
        (window as unknown as { wire: (i: string) => void }).wire("node"),
      );
      await p.locator("#node").click();
      await expect(p.getByRole("dialog").count()).resolves.toBe(1);
      await p.locator("#node").click();
      await expect(p.getByRole("dialog").count()).resolves.toBe(0);
      await expect(opens(p)).resolves.toBe(1);
      expect(p.url()).toBe(`${ORIGIN}/`);
      await p.context().close();
    });

    it("an SVG node with role=button says aria-haspopup, aria-expanded and aria-controls", async () => {
      if (skip()) return;
      const p = await open();
      await p.locator("#nodebtn").focus();
      const id = await openOn(p, "nodebtn");
      const n = p.locator("#nodebtn");
      await expect(n.getAttribute("aria-haspopup")).resolves.toBe("dialog");
      await expect(n.getAttribute("aria-expanded")).resolves.toBe("true");
      await expect(n.getAttribute("aria-controls")).resolves.toBe(id);
      await p.keyboard.press("Escape");
      await expect(n.getAttribute("aria-expanded")).resolves.toBe("false");
      await expect(n.getAttribute("aria-controls")).resolves.toBeNull();
      await expect(active(p)).resolves.toBe("nodebtn");
      await p.context().close();
    });

    it("sits below its anchor, or above when there's no room, 8px inside the viewport", async () => {
      if (skip()) return;
      const p = await open();
      await p.evaluate(() =>
        (window as unknown as { openOn: (i: string) => string }).openOn("open"),
      );
      const a = await boxOf(p, "#open");
      let b = await boxOf(p, "[role=dialog]");
      expect(b.top).toBeGreaterThanOrEqual(a.bottom);
      expect(b.left).toBeGreaterThanOrEqual(8);
      await p.keyboard.press("Escape");
      await p.evaluate(() =>
        (window as unknown as { openOn: (i: string) => string }).openOn("low"),
      );
      const low = await boxOf(p, "#low");
      b = await boxOf(p, "[role=dialog]");
      expect(b.bottom).toBeLessThanOrEqual(low.top);
      expect(b.top).toBeGreaterThanOrEqual(8);
      await p.keyboard.press("Escape");
      await p.evaluate(() =>
        (window as unknown as { openOn: (i: string) => string }).openOn(
          "right",
        ),
      );
      b = await boxOf(p, "[role=dialog]");
      expect(b.right).toBeLessThanOrEqual(1280 - 8);
      await p.context().close();
    });

    it("an SVG node anchors it, and its focus comes back to the node", async () => {
      if (skip()) return;
      const p = await open();
      await p.locator("#node").focus();
      await p.evaluate(() =>
        (window as unknown as { openOn: (i: string) => string }).openOn("node"),
      );
      const n = await boxOf(p, "#node");
      const b = await boxOf(p, "[role=dialog]");
      expect(b.top).toBeGreaterThanOrEqual(n.bottom);
      await p.keyboard.press("Escape");
      await expect(active(p)).resolves.toBe("node");
      await p.context().close();
    });

    it("opening a second closes the first", async () => {
      if (skip()) return;
      const p = await open();
      await p.evaluate(() =>
        (
          window as unknown as { openOn: (i: string, n: number) => string }
        ).openOn("open", 1),
      );
      await p.evaluate(() =>
        (
          window as unknown as { openOn: (i: string, n: number) => string }
        ).openOn("other", 2),
      );
      await expect(p.getByRole("dialog").count()).resolves.toBe(1);
      await expect(
        p.getByRole("dialog", { name: "Card 2" }).count(),
      ).resolves.toBe(1);
      await expect(calls(p)).resolves.toEqual([["close", 1]]);
      await expect(
        p.locator("#open").getAttribute("aria-expanded"),
      ).resolves.toBe("false");
      await p.context().close();
    });

    for (const width of [1280, 390])
      for (const mode of ["light", "dark"])
        it(`at ${width}, ${mode}: the tokens' colours, inside the viewport`, async () => {
          if (skip()) return;
          const p = await open({ width, mode });
          await p.evaluate(() =>
            (window as unknown as { openOn: (i: string) => string }).openOn(
              "right",
            ),
          );
          const got = await p.locator("[role=dialog]").evaluate((el) => {
            const probe = document.createElement("div");
            document.body.append(probe);
            const tok = (
              v: string,
              prop: "backgroundColor" | "borderTopColor" | "color",
            ) => {
              probe.style.cssText = `background-color: var(${v}); border: 1px solid var(${v}); color: var(${v})`;
              return getComputedStyle(probe)[prop];
            };
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const out = {
              bg: s.backgroundColor === tok("--raised", "backgroundColor"),
              border:
                s.borderTopColor === tok("--border-strong", "borderTopColor"),
              text: s.color === tok("--text", "color"),
              left: r.left,
              right: r.right,
            };
            probe.remove();
            return out;
          });
          expect([got.bg, got.border, got.text]).toEqual([true, true, true]);
          expect(got.left).toBeGreaterThanOrEqual(8);
          expect(got.right).toBeLessThanOrEqual(width - 8);
          await p.context().close();
        });
  });
