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

const PAGE = (lang: string, body: string, regions: boolean) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/toast.css"></head>
<body><main><button id="before">Before</button><button id="other">Other</button></main>
${body}
<script type="module">
import * as kit from "/toast.js";
window.kit = kit;
${regions ? "kit.ensureToastRegions();" : ""}
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
    /** A host that makes the regions at start (as Den's shell does). */
    regions?: boolean;
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
        body: PAGE(o.lang ?? "en", o.body ?? "", o.regions ?? true),
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
    ensureToastRegions: (d?: Document) => void;
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

// The toast in a region: the kit's, or Hub's #art-toast.
const TOAST = ":is([data-den-toast], #art-toast) > [data-kind]";
const toasts = (p: Page) => p.locator(TOAST).count();

describe("issue 559: the toast in a browser", () => {
  it("the page's first toast: its region is on the page, empty, before the toast comes in", async () => {
    if (skip()) return;
    const p = await open({ regions: false });
    const r = await p.evaluate(() => {
      const w = window as unknown as W;
      w.kit.showToast({ message: "First" });
      // Same task as the call: the region is there, and still empty.
      const reg = document.querySelector('[data-den-toast="status"]');
      return { there: !!reg?.isConnected, kids: reg?.children.length ?? -1 };
    });
    expect(r).toEqual({ there: true, kids: 0 });
    await p.clock.runFor(100);
    expect(await toasts(p)).toBe(1);
    expect(await p.locator("[data-toast-msg]").textContent()).toBe("First");
    await p.context().close();
  });

  it("ensureToastRegions: both regions, empty, made once", async () => {
    if (skip()) return;
    const p = await open({ regions: false });
    const r = await p.evaluate(() => {
      const w = window as unknown as W;
      w.kit.ensureToastRegions();
      w.kit.ensureToastRegions();
      return [...document.querySelectorAll("[data-den-toast]")].map(
        (x) => `${x.getAttribute("data-den-toast")}:${x.children.length}`,
      );
    });
    expect(r).toEqual(["status:0", "alert:0"]);
    // With the regions made at load, a toast goes straight in.
    await show(p, { message: "Now" });
    expect(await toasts(p)).toBe(1);
    await p.context().close();
  });

  it("a toast shown just after a server's toast is hydrated: only the new one stays", async () => {
    if (skip()) return;
    const p = await open({
      body:
        '<div id="art-toast" role="status" aria-live="polite" data-ttl="8000">' +
        '<div class="den-toast" data-kind="status"><span class="den-toast-words"><span class="den-toast-msg" data-toast-msg>Old</span></span></div></div>',
    });
    await p.evaluate(() => {
      const w = window as unknown as W;
      w.kit.hydrateToast();
      w.kit.showToast({ message: "New" });
    });
    await p.clock.runFor(200);
    expect(await toasts(p)).toBe(1);
    expect(await p.locator("[data-toast-msg]").textContent()).toBe("New");
    await p.context().close();
  });

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
      { k: "alert", role: "alert", live: "assertive", text: "" },
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
    expect(await p.locator("[data-toast-msg]").textContent()).toBe(
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
    await p.hover("[data-den-toast] > [data-kind]");
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
    // Out, then back in 50 ms later: a screen reader hears it.
    expect(await toasts(p)).toBe(0);
    await p.clock.runFor(49);
    expect(await toasts(p)).toBe(0);
    await p.clock.runFor(1);
    expect(await toasts(p)).toBe(1);
    await p.clock.runFor(7949);
    expect(await toasts(p)).toBe(1);
    await p.clock.runFor(2);
    expect(await toasts(p)).toBe(0);
    await p.context().close();
  });

  it("390 px: × on the first line, the actions one row 4–8 px under the words, 44 px taps, full width less 16 px", async () => {
    if (skip()) return;
    const cases = [
      {
        lang: "en",
        o: {
          kind: "error",
          message: "Couldn't save the settings",
          detail: "Request a1b2c3d4",
          actions: [{ label: "Retry" }, { label: "Copy details" }],
        },
      },
      {
        lang: "en",
        o: {
          message: "Removed keeper",
          undo: true,
          link: { href: "/s", label: "Settings" },
        },
      },
      {
        lang: "ja",
        o: {
          message: "keeper を削除しました",
          undo: true,
          link: { href: "/s", label: "設定" },
        },
      },
    ];
    for (const mode of ["light", "dark"] as const)
      for (const c of cases) {
        const p = await open({ width: 390, mode, lang: c.lang });
        await show(p, c.o);
        const b = await p.evaluate(() => {
          const t = document.querySelector("[data-den-toast] > [data-kind]")!;
          for (const a of t.getAnimations()) a.finish();
          const r = (e: Element | null) => e && e.getBoundingClientRect();
          const words = r(t.querySelector("[data-toast-words]"))!;
          const msg = t.querySelector("[data-toast-msg]")!;
          const line = parseFloat(getComputedStyle(msg).lineHeight);
          const acts = r(t.querySelector("[data-toast-acts]"))!;
          const taps = [...t.querySelectorAll("button, a")].map((e) => ({
            h: r(e)!.height,
            top: r(e)!.top,
          }));
          const close = r(t.querySelector("[data-toast-close]"));
          return {
            width: r(t)!.width,
            gap: acts.top - words.bottom,
            actsOneRow: new Set(
              [
                ...t.querySelectorAll(
                  "[data-toast-acts] button, [data-toast-acts] a",
                ),
              ]
                .filter((e) => e.matches("button, a"))
                .map((e) => Math.round(r(e)!.top)),
            ).size,
            minTap: Math.min(...taps.map((x) => x.h)),
            close: close && {
              mid: close.top + close.height / 2,
              line1: r(msg)!.top + line / 2,
              besideWords: close.left >= words.right - 0.5,
            },
          };
        });
        const tag = `${mode} ${c.lang} ${c.o.message}`;
        expect([tag, b.width]).toEqual([tag, 390 - 32]);
        expect([tag, b.gap >= 4 && b.gap <= 8]).toEqual([tag, true]);
        expect([tag, b.actsOneRow]).toEqual([tag, 1]);
        expect([tag, b.minTap >= 44]).toEqual([tag, true]);
        if (b.close) {
          expect([tag, Math.abs(b.close.mid - b.close.line1) <= 3]).toEqual([
            tag,
            true,
          ]);
          expect([tag, b.close.besideWords]).toEqual([tag, true]);
        }
        await p.context().close();
      }
  });

  it("390 px: a one-line plain toast stays sized to its words", async () => {
    if (skip()) return;
    const p = await open({ width: 390 });
    await show(p, { message: "Saved" });
    const w = await p.evaluate(
      () =>
        document
          .querySelector("[data-den-toast] > [data-kind]")!
          .getBoundingClientRect().width,
    );
    expect(w).toBeLessThan(200);
    await p.context().close();
  });

  it("the error glyph: at least 3:1 against the toast, light and dark", async () => {
    if (skip()) return;
    for (const mode of ["light", "dark"] as const) {
      const p = await open({ mode });
      await show(p, { kind: "error", message: "Down" });
      const ratio = await p.evaluate(() => {
        const t = document.querySelector("[data-den-toast] > [data-kind]")!;
        const rgb = (v: string) =>
          (v.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        const lum = (c: number[]) => {
          const [r, g, b] = c.map((x) => {
            const v = x / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const a = lum(rgb(getComputedStyle(t).backgroundColor));
        const b = lum(
          rgb(getComputedStyle(t.querySelector("[data-toast-ic]")!).color),
        );
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      expect([mode, ratio >= 3]).toEqual([mode, true]);
      await p.context().close();
    }
  });

  it("20 px up by default; a host with a bottom bar sets --den-toast-bottom", async () => {
    if (skip()) return;
    const p = await open();
    const gap = () =>
      p.evaluate(
        () =>
          window.innerHeight -
          document
            .querySelector("[data-den-toast] > [data-kind]")!
            .getBoundingClientRect().bottom,
      );
    await show(p, { message: "Saved" });
    expect(Math.round(await gap())).toBe(20);
    await p.evaluate(() =>
      document.documentElement.style.setProperty("--den-toast-bottom", "70px"),
    );
    expect(Math.round(await gap())).toBe(70);
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
        const t = document.querySelector(
          "[data-den-toast] > [data-kind]",
        ) as HTMLElement;
        const u = document.querySelector("[data-toast-undo]") as HTMLElement;
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
        undo: box("[data-toast-undo]"),
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
          getComputedStyle(
            document.querySelector("[data-den-toast] > [data-kind]")!,
          ).animationName,
      );
      expect([reduce, anim]).toEqual([
        reduce,
        reduce ? "none" : "den-toast-in",
      ]);
      await p.context().close();
    }
  });
});
