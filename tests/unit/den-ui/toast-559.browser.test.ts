/**
 * Issue 559: the den-ui toast in a browser (toast.js, toast.css). The
 * page's clock is faked and paused.
 *
 *   - one live region on the page, empty before the words arrive, reused;
 *     an error goes to the alert region;
 *   - focus is never moved into it; Tab reaches Undo; Esc (focus inside)
 *     closes it and focus goes back where it was, never the body;
 *   - Undo runs once, then "Undone." shows for 3 s;
 *   - a new toast replaces the old, and the old Undo never runs;
 *   - hover holds it; leaving starts a full 3 s;
 *   - a server's toast (toastHtml, or Hub's #art-toast) is hydrated: timed
 *     and announced;
 *   - the look: inverted surface, at most 560 px, the focus ring in the
 *     page's background colour, a phone's actions under the words with a
 *     44 px tap, no animation under reduced motion.
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

const PAGE = (lang: string, body: string) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/toast.css"></head>
<body><main><button id="before">Before</button><button id="other">Other</button></main>
${body}
<script type="module">
import { showToast, hydrateToast, toastHtml } from "/toast.js";
window.kit = { showToast, hydrateToast, toastHtml };
window.undos = 0;
window.ready = true;
</script></body></html>`;

async function open(
  o: {
    lang?: string;
    mode?: "light" | "dark";
    reduce?: boolean;
    width?: number;
    body?: string;
  } = {},
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: o.width ?? 1280, height: 800 },
    reducedMotion: o.reduce === false ? "no-preference" : "reduce",
    colorScheme: o.mode === "dark" ? "dark" : "light",
    locale: o.lang ?? "en",
  });
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date("2026-11-25T10:00:00Z") });
  await p.clock.pauseAt(new Date("2026-11-25T10:00:00Z"));
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        body: PAGE(o.lang ?? "en", o.body ?? ""),
      });
    const f = u.pathname.slice(1);
    if (/^[a-z-]+\.(js|css)$/.test(f) && fs.existsSync(path.join(SRC, f)))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(path.join(SRC, f), "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(() => (window as { ready?: boolean }).ready === true);
  return p;
}

type W = Window & {
  kit: {
    showToast: (o: object) => { close(): void };
    hydrateToast: (d?: Document) => { close(): void } | null;
  };
  undos: number;
};

const show = (p: Page, o: object) =>
  p.evaluate((o) => {
    const w = window as unknown as W;
    const opts = { ...o } as Record<string, unknown>;
    if (opts.undo) {
      delete opts.undo;
      opts.onUndo = () => w.undos++;
    }
    w.kit.showToast(opts);
  }, o);

const toasts = (p: Page) => p.locator(".den-toast").count();

describe("issue 559: the toast in a browser", () => {
  it("one live region, empty before the words, reused; an error in the alert region", async () => {
    if (skip()) return;
    const p = await open();
    await show(p, { message: "One" });
    await show(p, { message: "Two" });
    const r = await p.evaluate(() => {
      const regs = [...document.querySelectorAll("[data-den-toast]")];
      return regs.map((x) => ({
        k: x.getAttribute("data-den-toast"),
        role: x.getAttribute("role"),
        live: x.getAttribute("aria-live"),
        text: x.textContent,
      }));
    });
    expect(r).toEqual([
      { k: "status", role: "status", live: "polite", text: "Two" },
    ]);
    await show(p, { kind: "error", message: "Down" });
    const roles = await p.evaluate(() =>
      [...document.querySelectorAll("[data-den-toast]")].map((x) => [
        x.getAttribute("role"),
        x.textContent!.includes("Down"),
      ]),
    );
    expect(roles).toEqual([
      ["status", false],
      ["alert", true],
    ]);
    await p.context().close();
  });

  it("focus is never taken; Tab reaches Undo; Esc closes and gives focus back", async () => {
    if (skip()) return;
    const p = await open();
    await p.focus("#other");
    await show(p, { message: "Removed", undo: true });
    expect(await p.evaluate(() => document.activeElement!.id)).toBe("other");
    await p.keyboard.press("Tab");
    expect(await p.evaluate(() => document.activeElement!.className)).toBe(
      "den-toast-undo",
    );
    await p.keyboard.press("Escape");
    expect(await toasts(p)).toBe(0);
    expect(await p.evaluate(() => document.activeElement!.id)).toBe("other");
    expect(await p.evaluate(() => (window as unknown as W).undos)).toBe(0);
    await p.context().close();
  });

  it("Undo runs once, then 'Undone.' for 3 s, and focus goes back", async () => {
    if (skip()) return;
    const p = await open({ lang: "ja" });
    await p.focus("#before");
    await show(p, { message: "削除しました", undo: true });
    await p.keyboard.press("Tab");
    await p.keyboard.press("Tab");
    await p.keyboard.press("Enter");
    expect(await p.evaluate(() => (window as unknown as W).undos)).toBe(1);
    expect(await p.locator(".den-toast-msg").textContent()).toBe(
      "元に戻しました。",
    );
    expect(await p.locator("[data-toast-undo]").count()).toBe(0);
    expect(
      await p.evaluate(() => document.activeElement !== document.body),
    ).toBe(true);
    await p.clock.runFor(2999);
    expect(await toasts(p)).toBe(1);
    await p.clock.runFor(1);
    expect(await toasts(p)).toBe(0);
    expect(await p.evaluate(() => (window as unknown as W).undos)).toBe(1);
    await p.context().close();
  });

  it("a new toast replaces the old; the old Undo is gone and never runs", async () => {
    if (skip()) return;
    const p = await open();
    await show(p, { message: "Removed A", undo: true });
    await show(p, { message: "Saved" });
    expect(await toasts(p)).toBe(1);
    expect(await p.locator("[data-toast-undo]").count()).toBe(0);
    await p.clock.runFor(20_000);
    expect(await p.evaluate(() => (window as unknown as W).undos)).toBe(0);
    await p.context().close();
  });

  it("8 s with Undo; hover holds it; leaving starts a full 3 s", async () => {
    if (skip()) return;
    const p = await open();
    await show(p, { message: "Removed", undo: true });
    await p.clock.runFor(7000);
    await p.hover(".den-toast");
    await p.clock.runFor(60_000);
    expect(await toasts(p)).toBe(1);
    await p.mouse.move(5, 5);
    await p.clock.runFor(2999);
    expect(await toasts(p)).toBe(1);
    await p.clock.runFor(1);
    expect(await toasts(p)).toBe(0);
    await p.context().close();
  });

  it("an error stays until Close; Close gives focus back", async () => {
    if (skip()) return;
    const p = await open({ lang: "es" });
    await p.focus("#other");
    await show(p, { kind: "error", message: "No se guardó" });
    await p.clock.runFor(10 * 60_000);
    expect(await toasts(p)).toBe(1);
    const close = p.locator("[data-toast-close]");
    expect(await close.getAttribute("aria-label")).toBe("Cerrar");
    await p.keyboard.press("Tab");
    await p.keyboard.press("Enter");
    expect(await toasts(p)).toBe(0);
    expect(await p.evaluate(() => document.activeElement!.id)).toBe("other");
    await p.context().close();
  });

  it("a server's toast in Hub's #art-toast is timed and announced", async () => {
    if (skip()) return;
    const p = await open({
      body:
        '<div id="art-toast" role="status" aria-live="polite" data-ttl="8000">' +
        '<div class="den-toast" data-kind="status"><span class="den-toast-words"><span class="den-toast-msg">Removed</span></span></div></div>',
    });
    await p.evaluate(() => (window as unknown as W).kit.hydrateToast());
    // Out, then back in: a screen reader hears it.
    expect(await toasts(p)).toBe(0);
    await p.clock.runFor(1);
    expect(await toasts(p)).toBe(1);
    await p.clock.runFor(7998);
    expect(await toasts(p)).toBe(1);
    await p.clock.runFor(2);
    expect(await toasts(p)).toBe(0);
    await p.context().close();
  });

  it("the look: inverted, at most 560 px, the ring in the page's background colour", async () => {
    if (skip()) return;
    for (const mode of ["light", "dark"] as const) {
      const p = await open({ mode });
      await show(p, {
        message: "A long message ".repeat(20),
        undo: true,
        link: { href: "/x", label: "Open" },
      });
      await p.focus("#other");
      await p.keyboard.press("Tab");
      const s = await p.evaluate(() => {
        const t = document.querySelector(".den-toast") as HTMLElement;
        const u = document.querySelector(".den-toast-undo") as HTMLElement;
        const root = getComputedStyle(document.documentElement);
        const probe = (v: string) => {
          const d = document.createElement("div");
          d.style.color = `var(${v})`;
          document.body.appendChild(d);
          const c = getComputedStyle(d).color;
          d.remove();
          return c;
        };
        const ts = getComputedStyle(t);
        const us = getComputedStyle(u);
        void root;
        return {
          bg: ts.backgroundColor,
          fg: ts.color,
          text: probe("--text"),
          pageBg: probe("--bg"),
          width: t.getBoundingClientRect().width,
          weight: us.fontWeight,
          ring: us.outlineColor,
          ringW: us.outlineWidth,
          focused: document.activeElement === u,
        };
      });
      expect([mode, s.bg]).toEqual([mode, s.text]);
      expect([mode, s.fg]).toEqual([mode, s.pageBg]);
      expect(s.width).toBeLessThanOrEqual(560);
      expect(s.weight).toBe("600");
      expect(s.focused).toBe(true);
      expect([mode, s.ring, s.ringW]).toEqual([mode, s.pageBg, "2px"]);
      await p.context().close();
    }
  });

  it("a phone: actions under the words, left-aligned, 44 px taps", async () => {
    if (skip()) return;
    const p = await open({ width: 390 });
    await show(p, {
      message: "Removed",
      undo: true,
      link: { href: "/x", label: "Open" },
    });
    const g = await p.evaluate(() => {
      const box = (s: string) =>
        document.querySelector(s)!.getBoundingClientRect();
      return {
        words: box(".den-toast-words"),
        acts: box(".den-toast-acts"),
        undo: box(".den-toast-undo"),
        link: box(".den-toast-link"),
      };
    });
    expect(g.acts.top).toBeGreaterThanOrEqual(g.words.bottom - 1);
    expect(Math.round(g.acts.left)).toBe(Math.round(g.words.left));
    expect(g.undo.height).toBeGreaterThanOrEqual(44);
    expect(g.link.height).toBeGreaterThanOrEqual(44);
    await p.context().close();
  });

  it("reduced motion: no animation; otherwise it slides in", async () => {
    if (skip()) return;
    for (const reduce of [true, false]) {
      const p = await open({ reduce });
      await show(p, { message: "Saved" });
      const anim = await p.evaluate(
        () =>
          getComputedStyle(document.querySelector(".den-toast")!).animationName,
      );
      expect([reduce, anim]).toEqual([
        reduce,
        reduce ? "none" : "den-toast-in",
      ]);
      await p.context().close();
    }
  });
});
