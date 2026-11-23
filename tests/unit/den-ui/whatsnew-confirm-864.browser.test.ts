/**
 * Issue 864: What's new waited behind a pop-up already open (issue 793),
 * but a kit confirm opened over What's new. A confirm that does async work
 * before it asks (Services' Delete project fetches first) could open on
 * top of a What's new that came up meanwhile: two modals, two primary
 * buttons. Now a kit ask (askConfirm, askText, tell) asked while What's
 * new is open steps it aside: one pop-up at a time, the person's question
 * first. What's new is not counted as seen, and it comes back once the
 * question is answered.
 *
 * The kit's own whatsnew.js and dialog.js, from source, on a page of their
 * own, in Chromium and WebKit.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const ENGINES = ["chromium", "webkit"] as const;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const name of ENGINES) browsers[name] = await launchBrowser(pw[name]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
});

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/dialog.css">
<link rel="stylesheet" href="/whatsnew.css">
</head>
<body><button id="version-pill" type="button">v1.2.0</button>
<button id="del" type="button">Delete project</button>
<script type="module">
import { askConfirm, tell } from "/dialog.js";
import { configureWhatsNew, setEntries, openWhatsNew, closeWhatsNew } from "/whatsnew.js";
window.seen = [];
configureWhatsNew({
  lang: "en",
  reportButton: () => "",
  onClose: (v) => window.seen.push(v),
});
setEntries([
  { version: "1.2.0", date: "2026-11-22", sections: { Fixed: [{ text: "A fix" }] } },
]);
window.kit = { askConfirm, tell, openWhatsNew, closeWhatsNew };
window.ask = (fn) => {
  window.answer = undefined;
  window.kit[fn]({ title: "Delete this project?", message: "It goes for good." })
    .then((v) => { window.answer = v; });
};
window.ready = true;
</script></body></html>`;

async function page(engine: (typeof ENGINES)[number]): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    const f = path.join(SRC, path.basename(u.pathname));
    const type = u.pathname.endsWith(".js")
      ? "text/javascript"
      : u.pathname.endsWith(".css")
        ? "text/css"
        : "";
    if (type && fs.existsSync(f))
      return r.fulfill({
        contentType: type,
        body: fs.readFileSync(f, "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(
    () => (window as unknown as { ready?: boolean }).ready,
  );
  return p;
}

type W = {
  kit: { openWhatsNew(): void; closeWhatsNew(): void };
  ask(fn: string): void;
  answer: unknown;
  seen: unknown[];
};

/** The modal dialogs open now, by id ("" for the ask, which has none). */
const modals = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll("dialog[open]")]
      .filter((d) => d.matches(":modal"))
      .map((d) => (d.id === "cl-overlay" ? "whatsnew" : "ask")),
  );
const seen = (p: Page) => p.evaluate(() => (window as unknown as W).seen);
/** A turn of the event loop and a frame, for close events and focus. */
const settle = (p: Page) =>
  p.evaluate(
    () =>
      new Promise((r) =>
        setTimeout(() => requestAnimationFrame(() => r(null)), 30),
      ),
  );
const focusIn = (p: Page) =>
  p.evaluate(() => {
    const a = document.activeElement;
    const d = a?.closest("dialog");
    return d ? (d.id === "cl-overlay" ? "whatsnew" : "ask") : "page";
  });

for (const engine of ENGINES)
  describe(`864 one pop-up at a time, ${engine}`, () => {
    const skip = () => !browsers[engine];

    it("a confirm asked while What's new is open is the only pop-up", async () => {
      if (skip()) return;
      const p = await page(engine);
      await p.evaluate(() => (window as unknown as W).kit.openWhatsNew());
      expect(await modals(p)).toEqual(["whatsnew"]);
      await p.evaluate(() => (window as unknown as W).ask("askConfirm"));
      await settle(p);
      expect(await modals(p)).toEqual(["ask"]);
      // The keyboard is in the question, not left behind on the page.
      expect(await focusIn(p)).toBe("ask");
      // Stepped aside, not read: it isn't counted as seen.
      expect(await seen(p)).toEqual([]);
      await p.context().close();
    });

    it("What's new comes back once the confirm is answered, and the answer is kept", async () => {
      if (skip()) return;
      const p = await page(engine);
      await p.evaluate(() => (window as unknown as W).kit.openWhatsNew());
      await p.evaluate(() => (window as unknown as W).ask("askConfirm"));
      await settle(p);
      await p.click('dialog.dk-confirm[open] [value="ok"]');
      await settle(p);
      expect(await p.evaluate(() => (window as unknown as W).answer)).toBe(
        true,
      );
      expect(await modals(p)).toEqual(["whatsnew"]);
      expect(await focusIn(p)).toBe("whatsnew");
      expect(await seen(p)).toEqual([]);
      // Read and closed by the person: now it counts as seen, once.
      await p.click("#cl-got-it-btn");
      await settle(p);
      expect(await modals(p)).toEqual([]);
      expect(await seen(p)).toEqual(["1.2.0"]);
      await p.context().close();
    });

    it("Escape on the confirm also brings What's new back", async () => {
      if (skip()) return;
      const p = await page(engine);
      await p.evaluate(() => (window as unknown as W).kit.openWhatsNew());
      await p.evaluate(() => (window as unknown as W).ask("askConfirm"));
      await settle(p);
      await p.keyboard.press("Escape");
      await settle(p);
      expect(await p.evaluate(() => (window as unknown as W).answer)).toBe(
        false,
      );
      expect(await modals(p)).toEqual(["whatsnew"]);
      await p.context().close();
    });

    it("tell does the same as a confirm", async () => {
      if (skip()) return;
      const p = await page(engine);
      await p.evaluate(() => (window as unknown as W).kit.openWhatsNew());
      await p.evaluate(() => (window as unknown as W).ask("tell"));
      await settle(p);
      expect(await modals(p)).toEqual(["ask"]);
      await p.keyboard.press("Escape");
      await settle(p);
      expect(await modals(p)).toEqual(["whatsnew"]);
      await p.context().close();
    });

    it("closed by the page while stepped aside, What's new stays closed", async () => {
      if (skip()) return;
      const p = await page(engine);
      await p.evaluate(() => (window as unknown as W).kit.openWhatsNew());
      await p.evaluate(() => (window as unknown as W).ask("askConfirm"));
      await settle(p);
      await p.evaluate(() => (window as unknown as W).kit.closeWhatsNew());
      await p.keyboard.press("Escape");
      await settle(p);
      expect(await modals(p)).toEqual([]);
      await p.context().close();
    });

    it("as before (issue 793): What's new asked under an open confirm waits for it", async () => {
      if (skip()) return;
      const p = await page(engine);
      await p.evaluate(() => (window as unknown as W).ask("askConfirm"));
      await p.evaluate(() => (window as unknown as W).kit.openWhatsNew());
      await settle(p);
      expect(await modals(p)).toEqual(["ask"]);
      await p.keyboard.press("Escape");
      await settle(p);
      expect(await modals(p)).toEqual(["whatsnew"]);
      await p.context().close();
    });
  });
