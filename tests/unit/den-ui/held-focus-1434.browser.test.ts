/**
 * Issue 1434: a button the kit holds while its request waits keeps the
 * keyboard's focus, during the hold and after it. A held button is
 * aria-disabled (not disabled, which drops focus to <body>), and a click
 * on it while held does nothing. In Chromium and WebKit.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const PUBLIC = path.join(__dirname, "../../../src/ui/server/public");
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

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"></head>
<body><input id="before"><button id="go">Save</button>
<form method="post" action="/sent"><button id="send">Send</button></form>
<div id="rs"></div>
<script type="module">
import * as kit from "/busy.js";
import { restartResultHtml, wireRestartNow } from "/restart-result.js";
window.restarts = (n) => {
  const rs = document.getElementById("rs");
  const list = Array.from({ length: n }, (_, i) => ({
    id: "a" + i, workspace: "w", state: "job",
    job: { command: "sleep", minutes: 1 },
  }));
  rs.innerHTML = restartResultHtml(list, (k) => k);
  wireRestartNow(rs, { t: (k) => k, api: async () => ({ ok: true }) });
};
kit.configureBusy({ dotsMs: 60000, toast: () => {} });
window.clicks = 0;
window.sends = 0;
const b = document.getElementById("go");
b.addEventListener("click", () => {
  window.clicks++;
  kit.pending(b, () => fetch("/probe", { method: "POST" }));
});
kit.watchForms();
// After the kit's own listener: the form never leaves the page here.
document.addEventListener("submit", (e) => {
  window.sends++;
  e.preventDefault();
});
window.ready = true;
</script></body></html>`;

async function open(b: Browser): Promise<{
  p: Page;
  answer: () => void;
}> {
  const ctx = await b.newContext({ reducedMotion: "reduce" });
  const p = await ctx.newPage();
  let answer = () => {};
  const waiting = new Promise<void>((res) => (answer = res));
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    if (u.pathname === "/probe") {
      await waiting;
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    if (u.pathname === "/sent") return; // never answers: the hold stays
    const file = path.join(
      u.pathname === "/restart-result.js" ? PUBLIC : SRC,
      u.pathname.slice(1),
    );
    if (/^\/[\w-]+\.(js|css)$/.test(u.pathname) && fs.existsSync(file))
      return r.fulfill({
        contentType: u.pathname.endsWith(".css")
          ? "text/css"
          : "text/javascript",
        body: fs.readFileSync(file, "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(
    () => (window as unknown as { ready?: boolean }).ready,
  );
  return { p, answer: () => answer() };
}

const active = (p: Page) => p.evaluate(() => document.activeElement?.id ?? "");
const state = (p: Page, sel: string) =>
  p.$eval(sel, (el) => ({
    busy: el.getAttribute("aria-busy"),
    off: el.getAttribute("aria-disabled"),
  }));

for (const engine of ["chromium", "webkit"]) {
  describe(`issue 1434: a held button keeps focus (${engine})`, () => {
    it("pressed with the keyboard: focus stays during the hold and after", async () => {
      const b = browsers[engine];
      if (!b) return;
      const { p, answer } = await open(b);
      await p.focus("#before");
      await p.keyboard.press("Tab");
      expect(await active(p)).toBe("go");
      await p.keyboard.press("Enter");
      await p.waitForSelector('#go[aria-busy="true"]');
      expect(await active(p)).toBe("go");
      expect(await state(p, "#go")).toEqual({ busy: "true", off: "true" });
      // Held: Enter and Space again do nothing.
      await p.keyboard.press("Enter");
      await p.keyboard.press("Space");
      expect(
        await p.evaluate(
          () => (window as unknown as { clicks: number }).clicks,
        ),
      ).toBe(1);
      answer();
      await p.waitForSelector("#go:not([aria-busy])");
      expect(await state(p, "#go")).toEqual({ busy: null, off: null });
      expect(await active(p)).toBe("go");
      await p.context().close();
    });

    it("a form's submitter, pressed with the keyboard, keeps focus while held", async () => {
      const b = browsers[engine];
      if (!b) return;
      const { p } = await open(b);
      await p.focus("#send");
      await p.keyboard.press("Enter");
      await p.waitForSelector('#send[aria-busy="true"]');
      await p.waitForTimeout(50);
      expect(await active(p)).toBe("send");
      expect(await state(p, "#send")).toEqual({ busy: "true", off: "true" });
      await p.context().close();
    });

    it("Restart now and Restart all now: removed when done, focus goes to the status line", async () => {
      const b = browsers[engine];
      if (!b) return;
      const { p } = await open(b);
      await p.evaluate(() =>
        (window as unknown as { restarts: (n: number) => void }).restarts(3),
      );
      await p.focus('[data-rs-now="a0"]');
      await p.keyboard.press("Enter");
      await p.waitForSelector('[data-rs-now="a0"]', { state: "detached" });
      expect(
        await p.evaluate(
          () =>
            document.activeElement?.matches(
              '[data-rs-agent="a0"] [data-rs-line]',
            ) ?? false,
        ),
      ).toBe(true);
      await p.focus("[data-rs-all]");
      await p.keyboard.press("Enter");
      await p.waitForSelector("[data-rs-all]", { state: "detached" });
      expect(
        await p.evaluate(
          () => document.activeElement?.matches("[data-rs-result]") ?? false,
        ),
      ).toBe(true);
      await p.context().close();
    });
  });
}
