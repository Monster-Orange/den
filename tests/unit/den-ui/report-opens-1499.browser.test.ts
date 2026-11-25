/**
 * Issue 1499: Report opens its form at once, and fills the screenshot in
 * when it's ready. The capture (html-to-image) is held back 10 s here, as
 * a slow machine or Safari can.
 *
 *   - the form is open within 1 s, the shot's box saying it's being taken;
 *   - the shot fills in that box later, of the page without the form; the
 *     Title field doesn't move (within 1 px), and keeps the focus and the
 *     words typed (Hub Design: no jump), at 1280 and 390;
 *   - Send works before the shot is there: the report goes without it,
 *     and Review says so;
 *   - a shot that lands on Review shows there, but goes only if the person
 *     picks "Include it", which opens the first step (where they black out
 *     anything private) and comes back to Review;
 *   - a capture that fails says so on Review.
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
import * as strings from "../../../packages/den-ui/src/strings.js";

const { kitT } = strings as unknown as {
  kitT: (l: string, k: string, v?: object) => string;
};

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
<link rel="stylesheet" href="/kit/tokens.css">
<link rel="stylesheet" href="/kit/base.css">
<link rel="stylesheet" href="/kit/dialog.css">
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

async function open(
  b: Browser,
  o: { width?: number; height?: number; fail?: boolean } = {},
): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: o.width ?? 1280, height: o.height ?? 800 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    if (u.pathname === "/vendor/html-to-image.js") {
      if (o.fail) return r.fulfill({ status: 404, body: "" });
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
  await p.waitForSelector("dialog[open]", { timeout: 1_000 });
}

/** The Title field's top, in the window. */
const titleTop = (p: Page) =>
  p.evaluate(
    () =>
      document.querySelector('[data-f="title"]')!.getBoundingClientRect().top,
  );

/** What the page's send got. */
const sent = (p: Page) =>
  p.evaluate(
    () =>
      (window as unknown as { sent: Array<{ title: string; shot: number }> })
        .sent,
  );

/** From the first step to Review. */
async function toReview(p: Page) {
  await p.fill('[data-f="title"]', "Slow page");
  await p.click('[data-act="next"]');
  await p.click('[data-act="review"]');
  await p.waitForSelector('[data-act="send"]');
}

async function send(p: Page) {
  await p.click('[data-act="send"]');
  await p.waitForFunction(
    () => (window as unknown as { sent: unknown[] }).sent.length === 1,
    undefined,
    { timeout: 5_000 },
  );
}

/** With DEN_1499_SHOTS set to a folder (under the temp dir), the frames
 * design review asks for. */
const SHOTS = process.env.DEN_1499_SHOTS;

for (const name of ["chromium", "webkit"]) {
  describe(`issue 1499: Report opens at once (${name})`, () => {
    const b = () => browsers[name]!;

    it("is open within 1 s, the shot's box saying it's being taken", async () => {
      if (!b()) return;
      const p = await open(b());
      try {
        await report(p);
        expect(await p.textContent("[data-shot-box] [data-shot-wait]")).toBe(
          kitT("en", "kit.report.shotWait"),
        );
        expect(await p.locator("canvas[data-shot]").count()).toBe(0);
      } finally {
        await p.context().close();
      }
    }, 30_000);

    for (const width of [1280, 390])
      it(
        `fills the shot in at ${width} with no jump: the page without the form, focus and words kept`,
        async () => {
          if (!b()) return;
          const p = await open(b(), { width });
          try {
            await report(p);
            await p.fill('[data-f="title"]', "Slow page");
            const before = await titleTop(p);
            await p.waitForSelector("canvas[data-shot]", {
              timeout: DELAY + 30_000,
            });
            expect(await p.locator("[data-shot-wait]").count()).toBe(0);
            expect(Math.abs((await titleTop(p)) - before)).toBeLessThanOrEqual(
              1,
            );
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
        await toReview(p);
        expect(
          await p.locator("[data-shot-box] [data-shot-wait]").count(),
        ).toBe(1);
        expect(await p.textContent("[data-shot-late]")).toBe(
          kitT("en", "kit.report.shotLateWait"),
        );
        // The faded box's words keep full contrast: nothing around them
        // is see-through.
        expect(
          await p.evaluate(() => {
            let e: Element | null = document.querySelector(
              "[data-shot-box] [data-shot-wait]",
            );
            const o: string[] = [];
            for (; e; e = e.parentElement) o.push(getComputedStyle(e).opacity);
            return o.every((x) => x === "1");
          }),
        ).toBe(true);
        await send(p);
        expect(Date.now() - t0).toBeLessThan(DELAY);
        expect(await sent(p)).toEqual([{ title: "Slow page", shot: 0 }]);
      } finally {
        await p.context().close();
      }
    }, 30_000);

    it(
      "shows a shot that lands on Review, and doesn't send it unless chosen",
      async () => {
        if (!b()) return;
        const p = await open(b());
        try {
          await report(p);
          await toReview(p);
          await p.waitForSelector("[data-shot-box] img[data-shot-review]", {
            timeout: DELAY + 30_000,
          });
          expect(await p.textContent("[data-shot-late]")).toBe(
            kitT("en", "kit.report.shotLateIn"),
          );
          await send(p);
          expect(await sent(p)).toEqual([{ title: "Slow page", shot: 0 }]);
        } finally {
          await p.context().close();
        }
      },
      DELAY + 60_000,
    );

    for (const [width, height] of [
      [1280, 800],
      [390, 844],
    ] as const)
      it(
        `at ${width}x${height}, Review's note and Include it sit above a faded thumbnail, in the first view`,
        async () => {
          if (!b()) return;
          const p = await open(b(), { width, height });
          try {
            await report(p);
            await toReview(p);
            await p.waitForSelector('[data-act="shotinclude"]', {
              timeout: DELAY + 30_000,
            });
            const got = await p.evaluate(() => {
              const r = (sel: string) =>
                document.querySelector(sel)!.getBoundingClientRect();
              const dlg = r("dialog[open]");
              const box = r("[data-shot-box]");
              const seen = (x: DOMRect) =>
                x.top >= dlg.top &&
                x.bottom <= Math.min(dlg.bottom, window.innerHeight);
              const note = r("[data-shot-late]");
              const inc = r('[data-act="shotinclude"]');
              const img = document.querySelector("[data-shot-box] img")!;
              return {
                above: note.bottom <= box.top && inc.bottom <= box.top,
                seen: seen(note) && seen(inc),
                thumb: box.width <= 240.5,
                opacity: getComputedStyle(img).opacity,
              };
            });
            expect(got).toEqual({
              above: true,
              seen: true,
              thumb: true,
              opacity: "0.5",
            });
          } finally {
            await p.context().close();
          }
        },
        DELAY + 60_000,
      );

    it(
      "Include it opens the first step to mask it, back to Review, and then it goes",
      async () => {
        if (!b()) return;
        const p = await open(b());
        try {
          await report(p);
          await toReview(p);
          await p.waitForSelector('[data-act="shotinclude"]', {
            timeout: DELAY + 30_000,
          });
          await p.click('[data-act="shotinclude"]');
          await p.waitForSelector("canvas[data-shot]");
          await p.click('[data-act="review"]');
          await p.waitForSelector("[data-shot-box] img[data-shot-review]");
          expect(await p.locator("[data-shot-late]").count()).toBe(0);
          await send(p);
          const [r] = await sent(p);
          expect(r!.shot).toBeGreaterThan(0);
        } finally {
          await p.context().close();
        }
      },
      DELAY + 60_000,
    );

    it("says on Review when the shot couldn't be taken", async () => {
      if (!b()) return;
      const p = await open(b(), { fail: true });
      try {
        await report(p);
        await toReview(p);
        expect(await p.textContent("[data-shot-failed]")).toBe(
          kitT("en", "kit.report.shotFailed"),
        );
        await send(p);
        expect(await sent(p)).toEqual([{ title: "Slow page", shot: 0 }]);
      } finally {
        await p.context().close();
      }
    }, 30_000);

    if (SHOTS)
      it(
        "saves the frames review asks for",
        async () => {
          fs.mkdirSync(SHOTS, { recursive: true });
          const shot = (p: Page, f: string) =>
            p.screenshot({ path: path.join(SHOTS, `${name}-${f}.png`) });
          for (const width of [1280, 390]) {
            const p = await open(b(), { width });
            try {
              await report(p);
              await shot(p, `${width}-taking`);
              await p.waitForSelector("canvas[data-shot]", {
                timeout: DELAY + 30_000,
              });
              await shot(p, `${width}-shot-in`);
            } finally {
              await p.context().close();
            }
          }
          for (const [width, height] of [
            [1280, 800],
            [390, 844],
          ]) {
            const p = await open(b(), { width, height });
            try {
              await report(p);
              await toReview(p);
              await shot(p, `${width}-review-taking`);
              await p.waitForSelector('[data-act="shotinclude"]', {
                timeout: DELAY + 30_000,
              });
              await shot(p, `${width}-review-landed`);
            } finally {
              await p.context().close();
            }
          }
        },
        4 * DELAY + 160_000,
      );
  });
}
