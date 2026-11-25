/**
 * Issue 1499: Report opens its form at once, and fills the screenshot in
 * when it's ready. The capture (html-to-image) is held back 10 s here, as
 * a slow machine or Safari can.
 *
 *   - the form is open within 1 s, its shot area saying it's being taken;
 *   - the shot fills in later, of the page without the form, and doesn't
 *     take the focus or the words the person is typing;
 *   - Send works before the shot is there: the report goes without it,
 *     and Review says so. A shot the person never saw on the first step
 *     (where they black out anything private) never goes.
 *
 * On a bare page built from the kit's own files, in Chromium and WebKit.
 * DEN_PW_WS: Den's own Playwright server. DEN_SKIP_BROWSER_TESTS=1 skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const ROOT = path.join(__dirname, "../../..");
const SRC = path.join(ROOT, "packages/den-ui/src");
const LIB = path.join(ROOT, "node_modules/html-to-image/dist/html-to-image.js");
const ORIGIN = "http://report.test";
/** How long the capture's library is held back. */
const DELAY = 10_000;
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

// The page is one colour, so the shot's middle says whether the form
// (drawn over it) got into the picture.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>html, body { margin: 0; height: 100%; background: rgb(0, 128, 0); }</style>
</head><body><p>A page</p>
<script type="module">
  import { configureReport, openReport } from "/kit/report.js";
  window.sent = [];
  configureReport({
    library: "/vendor/html-to-image.js",
    adapter: {
      info: () => ({ repos: [{ repo: "acme/app" }], captureSeconds: 30 }),
      send: async (r) => {
        window.sent.push({ title: r.title, shot: r.shot ? r.shot.length : 0 });
        return { status: 200, data: { url: "https://example.test/issues/1" } };
      },
    },
  });
  window.report = () => void openReport();
  window.ready = true;
</script>
</body></html>`;

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

async function open(b: Browser): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: 1000, height: 700 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    if (u.pathname === "/vendor/html-to-image.js") {
      await new Promise((res) => setTimeout(res, DELAY));
      return r
        .fulfill({ contentType: "text/javascript", body: fs.readFileSync(LIB) })
        .catch(() => undefined);
    }
    const file = path.join(SRC, u.pathname.replace(/^\/kit\//, ""));
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: TYPES[path.extname(file)] ?? "text/plain",
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(() => (window as { ready?: boolean }).ready === true);
  return p;
}

/** Picks Report; resolves once the form is open, or fails after 1 s. */
async function report(p: Page) {
  await p.evaluate(() =>
    (window as unknown as { report: () => void }).report(),
  );
  await p.waitForSelector("dialog.fb-dlg[open]", { timeout: 1_000 });
}

for (const name of ["chromium", "webkit"]) {
  describe(`issue 1499: Report opens at once (${name})`, () => {
    const b = () => browsers[name]!;

    it("is open within 1 s, saying the screenshot is being taken", async () => {
      if (!b()) return;
      const p = await open(b());
      try {
        await report(p);
        expect(await p.textContent("[data-shot-wait]")).toBe(
          "Taking the screenshot…",
        );
        expect(await p.locator("canvas[data-shot]").count()).toBe(0);
      } finally {
        await p.context().close();
      }
    }, 30_000);

    it(
      "fills the shot in later: the page without the form, focus and words kept",
      async () => {
        if (!b()) return;
        const p = await open(b());
        try {
          await report(p);
          await p.fill('[data-f="title"]', "Slow page");
          await p.waitForSelector("canvas[data-shot]", {
            timeout: DELAY + 30_000,
          });
          expect(await p.locator("[data-shot-wait]").count()).toBe(0);
          const got = await p.evaluate(() => {
            const c = document.querySelector(
              "canvas[data-shot]",
            ) as HTMLCanvasElement;
            const px = c
              .getContext("2d")!
              .getImageData(c.width / 2, c.height / 2, 1, 1).data;
            const f = document.activeElement as HTMLInputElement | null;
            return {
              middle: [px[0], px[1], px[2]],
              focus: f?.getAttribute("data-f"),
              title: f?.value,
            };
          });
          expect(got).toEqual({
            middle: [0, 128, 0],
            focus: "title",
            title: "Slow page",
          });
        } finally {
          await p.context().close();
        }
      },
      DELAY + 60_000,
    );

    it("sends before the shot is there, without it, and Review says so", async () => {
      if (!b()) return;
      const p = await open(b());
      try {
        const t0 = Date.now();
        await report(p);
        await p.fill('[data-f="title"]', "Slow page");
        await p.click('[data-act="next"]');
        await p.click('[data-act="review"]');
        expect(await p.textContent("[data-shot-late]")).toBe(
          "No screenshot: it wasn't ready when you went on. Go back to the first step to add it.",
        );
        expect(await p.locator("[data-shot-review]").count()).toBe(0);
        await p.click('[data-act="send"]');
        await p.waitForFunction(
          () => (window as unknown as { sent: unknown[] }).sent.length === 1,
          undefined,
          { timeout: 5_000 },
        );
        expect(Date.now() - t0).toBeLessThan(DELAY);
        expect(
          await p.evaluate(
            () => (window as unknown as { sent: unknown[] }).sent,
          ),
        ).toEqual([{ title: "Slow page", shot: 0 }]);
      } finally {
        await p.context().close();
      }
    }, 30_000);
  });
}
