/**
 * Every word the shell shows goes through t() (R19, 0.3.0-dev.39). The
 * page is served in a pseudo-locale, "qps", whose catalog is en with every
 * text wrapped in ⟦…⟧; the shell (header, rail, top bar, scope menus, user
 * menu, palette, status drawer, lock popover, Runs dock, banners) is drawn
 * and opened, and every visible text and every title, aria-label and
 * placeholder outside the page's own <main> must be wrapped. What is left
 * once the wrapped parts are cut away may only be names (services, repos,
 * themes, languages, the product), numbers and glyphs: a literal English
 * word left in the shell fails here.
 *
 * Shell.js and header.js (with topbar.js and appearance.js) from disk, on
 * a stub origin like topbar.browser.test.ts's. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import type { Browser, Page } from "playwright";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** shell.js's en, every text wrapped in ⟦…⟧ (its placeholders kept). */
function pseudo(): Record<string, string> {
  const window: Record<string, unknown> = {};
  const ctx = vm.createContext({
    window,
    document: { getElementById: () => null, documentElement: { lang: "en" } },
    Intl,
  });
  try {
    vm.runInContext(
      fs.readFileSync(path.join(PUBLIC, "shell.js"), "utf-8"),
      ctx,
    );
  } catch {
    // shell.js stops at its first DOM use; its catalog is set before it.
  }
  const en = (window.denMessages as Record<string, Record<string, string>>).en;
  return Object.fromEntries(Object.entries(en).map(([k, v]) => [k, `⟦${v}⟧`]));
}

/** Names the stub serves, and what a shell may show untranslated. */
const NAMES = [
  "shop",
  "billing",
  "db",
  "local",
  "Den",
  "Paper",
  "English",
  "Español",
  "ws-a",
  "den",
  // The server fills these with the product's name (setHtmlFill).
  "__DEN_CLI__",
  "__DEN_TITLE__",
  // A check's output: never translated.
  "connect ECONNREFUSED",
];

async function mount(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const p = await ctx.newPage();
  const qps = JSON.stringify(pseudo());
  await p.route("http://den.test/**", async (r) => {
    const url = new URL(r.request().url());
    const json = (j: unknown, status = 200) => r.fulfill({ status, json: j });
    const file = /^\/([\w-]+\.js)$/.exec(url.pathname);
    if (file && fs.existsSync(path.join(PUBLIC, file[1])))
      return r.fulfill({
        contentType: "text/javascript; charset=utf-8",
        body: fs.readFileSync(path.join(PUBLIC, file[1]), "utf-8"),
      });
    switch (url.pathname) {
      case "/api/health/stream":
        return r.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: [
            {
              type: "result",
              result: {
                repo: "shop",
                service: "shop",
                ok: true,
                ms: 31,
                idx: 0,
              },
            },
            {
              type: "result",
              result: {
                repo: "billing",
                service: "billing",
                ok: false,
                error: "connect ECONNREFUSED",
                idx: 1,
              },
            },
            { type: "done" },
          ]
            .map((m) => `data: ${JSON.stringify(m)}\n\n`)
            .join(""),
        });
      case "/api/environments":
        return json(["local"]);
      case "/api/applications":
        return json({ applications: [] });
      case "/api/settings":
        return json({ shell: { pins: [], collapsed: false }, language: "qps" });
      case "/api/themes":
        return json({
          themes: [
            { id: "den", name: "Den", ok: true },
            { id: "paper", name: "Paper", ok: true },
          ],
          active: {
            id: "den",
            name: "Den",
            default_mode: "dark",
            mark: { text: "D" },
          },
          prefs: { theme: null, mode: "system" },
          org_default: { id: "den", name: "Den" },
        });
      case "/theme.css":
        return r.fulfill({ contentType: "text/css", body: "" });
      case "/api/sudo-password/status":
        return json({ set: false, passwordless: false });
      case "/api/sudo-password/vault-status":
        return json({
          backend: "1password",
          label: "1Password",
          configured: true,
          backendAvailable: true,
          hasStored: false,
        });
      case "/api/server-info":
        return json({
          version: "0.3.0-dev.39",
          pid: 1,
          startedAt: 1,
          stale: true,
        });
      case "/api/changelog":
        return json([]);
    }
    if (url.pathname.startsWith("/api/")) return json({});
    return r.fulfill({
      contentType: "text/html; charset=utf-8",
      body:
        `<!doctype html><html lang="qps"><head><style>:root { --mono: monospace; --sans: sans-serif; }</style></head><body>` +
        `<script>window.denMessages = { qps: ${qps} };</script>` +
        `<div id="den-shell" data-page="services"></div><script src="/shell.js"></script>` +
        `<main id="den-content"><h1>page</h1></main>` +
        `<script type="module">window.__hdr = await import("/header.js"); window.__hdr.initHealth();</script></body></html>`,
    });
  });
  await p.goto("http://den.test/services");
  await p.waitForSelector(".den-rail .den-ni");
  await p.waitForFunction(
    () => (window as unknown as { __hdr?: object }).__hdr,
  );
  await p.waitForSelector("#den-status.bad");
  return p;
}

/**
 * What the shell shows that is not wrapped: each visible text node and
 * each title / aria-label / placeholder outside <main>, with its ⟦…⟧
 * parts and the names cut away, reduced to its words.
 */
function leaks(p: Page): Promise<string[]> {
  return p.evaluate((names) => {
    const out = new Set<string>();
    const check = (s: string | null, where: string) => {
      if (!s) return;
      let rest = s;
      for (let prev = ""; prev !== rest; ) {
        prev = rest;
        rest = rest.replace(/⟦[^⟦⟧]*⟧/g, " ");
      }
      for (const n of names)
        rest = rest.replace(new RegExp(`(^|[^\\w-])${n}(?![\\w-])`, "g"), "$1");
      const words = rest.match(/[A-Za-z]{2,}/g);
      if (words) out.add(`${where}: ${s.trim().slice(0, 80)}`);
    };
    const visible = (e: Element) =>
      !!(e as HTMLElement).offsetParent ||
      getComputedStyle(e).position === "fixed";
    const skip = (e: Element) =>
      !!e.closest("#den-content, script, style, [hidden], [aria-hidden=true]");
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || skip(el) || !visible(el)) continue;
      check(
        n.textContent,
        `<${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}>`,
      );
    }
    for (const el of Array.from(
      document.body.querySelectorAll("[title], [aria-label], [placeholder]"),
    )) {
      if (el.closest("#den-content, script, style")) continue;
      for (const a of ["title", "aria-label", "placeholder"])
        check(el.getAttribute(a), `${el.tagName.toLowerCase()}[${a}]`);
    }
    return [...out];
  }, NAMES);
}

describe("the shell in a pseudo-locale", () => {
  it("shows no word that skipped t(), with every overlay open in turn", async () => {
    if (!browser) return;
    const p = await mount();
    const found = new Set<string>(await leaks(p));
    const open = async (sel: string, wait: string) => {
      await p.click(sel);
      await p.waitForSelector(wait);
      for (const l of await leaks(p)) found.add(l);
      await p.keyboard.press("Escape");
    };
    await open("#appearance-btn", ".den-pop");
    await open("#env-btn", ".den-pop");
    await open("#version-pill", ".cl-box #cl-title");
    await open("#den-status", "#den-drawer-title");
    await open("#den-search", "#den-pal-q");
    // The admin-password prompt, as a run's needs-sudo opens it (LK-0).
    // A string, so the browser does the import (not the test's compiler).
    await p.evaluate(
      "import('/topbar.js').then((m) => void m.askSudo({ command: 'sudo true' }))",
    );
    await p.waitForSelector("#den-lock-pop form");
    for (const l of await leaks(p)) found.add(l);
    await p.keyboard.press("Escape");
    await p.click("#den-runs");
    await p.waitForSelector("#den-dock");
    for (const l of await leaks(p)) found.add(l);
    expect([...found]).toEqual([]);
    await p.context().close();
  }, 60_000);
});
