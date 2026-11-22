/**
 * Issue 1024: the open bell repaints on every refresh (its poll, focus,
 * open). It used to set the whole panel's innerHTML, so every row was
 * rebuilt and its buttons were new elements: a mousedown on Allow, a
 * repaint, then the mouseup landed on a different element, and no click
 * happened (on a phone, the same for a tap). Now a repaint leaves an
 * unchanged row's DOM alone and replaces only a row whose content changed
 * (rows matched by data-ap-row, data-go-row, data-id or id).
 *
 * The kit's own hydrateBell, from its source, on a page of its own.
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

/** A row waiting for Allow, as Den's bell draws one; `rev` changes it. */
const allowRow = (id: string, rev = "1") =>
  `<div class="den-bell-row den-bell-allow" data-kind="allow" data-ap-row="${id}" data-rev="${rev}">` +
  `<span class="den-bell-t" data-line>An agent asks to add a test box (${rev})</span>` +
  `<button type="button" class="den-btn" data-bell="allow" data-ap="${id}">Allow</button>` +
  `<button type="button" class="den-btn" data-bell="deny" data-ap="${id}">Deny</button>` +
  `</div>`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  .den-bell-pop { position: fixed; top: 60px; right: 16px; width: 360px; }
  .den-bell-pop button { min-height: 44px; min-width: 80px; }
</style></head>
<body><button id="bell" type="button" title="Notifications">Bell</button>
<script type="module">
import { hydrateBell } from "/shell-client.js";
window.clicks = [];
window.panelHtml = "";
const bell = hydrateBell(document.getElementById("bell"), {
  lang: "en",
  panel: () => window.panelHtml,
});
bell.el.addEventListener("click", (e) => {
  const b = e.target.closest("[data-bell]");
  if (b) window.clicks.push(b.dataset.bell + ":" + b.dataset.ap);
});
window.bell = bell;
window.ready = true;
</script></body></html>`;

async function page(o: { phone?: boolean } = {}): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: o.phone
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 },
    ...(o.phone ? { hasTouch: true, isMobile: true } : {}),
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    const f = path.join(SRC, path.basename(u.pathname));
    if (u.pathname.endsWith(".js") && fs.existsSync(f))
      return r.fulfill({
        contentType: "text/javascript",
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

/** Sets the panel's HTML and repaints, as a refresh does. */
const repaint = (p: Page, html: string) =>
  p.evaluate((h) => {
    const w = window as unknown as {
      panelHtml: string;
      bell: { paint: () => void };
    };
    w.panelHtml = h;
    w.bell.paint();
  }, html);

const panel = (...rows: string[]) =>
  `<h2 id="den-bell-h">Notifications</h2><section data-scope="allow">${rows.join("")}</section>`;

/** Marks each row's element, so a later check can tell if it was kept. */
const mark = (p: Page) =>
  p.evaluate(() => {
    document.querySelectorAll("[data-ap-row]").forEach((el, i) => {
      (el as unknown as { __mark: number }).__mark = i + 1;
    });
  });
const marks = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll("[data-ap-row]")].map(
      (el) =>
        `${(el as HTMLElement).dataset.apRow}:${(el as unknown as { __mark?: number }).__mark ?? "new"}`,
    ),
  );
const clicks = (p: Page) =>
  p.evaluate(() => (window as unknown as { clicks: string[] }).clicks);

describe("the bell keeps an unchanged row across a repaint (issue 1024)", () => {
  it("a repaint with the same rows keeps every row's element", async () => {
    if (skip()) return;
    const p = await page();
    await repaint(p, panel(allowRow("a1"), allowRow("a2")));
    await p.click("#bell");
    await mark(p);
    await repaint(p, panel(allowRow("a1"), allowRow("a2")));
    expect(await marks(p)).toEqual(["a1:1", "a2:2"]);
    await p.context().close();
  });

  it("a changed row is new; the others are kept; a gone row leaves; a new one comes", async () => {
    if (skip()) return;
    const p = await page();
    await repaint(p, panel(allowRow("a1"), allowRow("a2"), allowRow("a3")));
    await p.click("#bell");
    await mark(p);
    await repaint(
      p,
      panel(allowRow("a1"), allowRow("a2", "2"), allowRow("a4")),
    );
    expect(await marks(p)).toEqual(["a1:1", "a2:new", "a4:new"]);
    await expect(
      p.locator('[data-ap-row="a2"]').getAttribute("data-rev"),
    ).resolves.toBe("2");
    await p.context().close();
  });

  it("mousedown on Allow, a repaint, mouseup: the click lands", async () => {
    if (skip()) return;
    const p = await page();
    await repaint(p, panel(allowRow("a1"), allowRow("a2")));
    await p.click("#bell");
    const b = (await p
      .locator('[data-ap-row="a2"] [data-bell="allow"]')
      .boundingBox())!;
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await repaint(p, panel(allowRow("a1"), allowRow("a2")));
    await p.mouse.up();
    expect(await clicks(p)).toEqual(["allow:a2"]);
    await p.context().close();
  });

  // A guard, not a red-first test: Chromium hit-tests a tap where the
  // finger lifts, so a tap landed on the new button even before the fix.
  // It keeps the phone path from breaking while rows are kept.
  it("on a phone: a touch on Allow, a repaint, the lift: the tap lands", async () => {
    if (skip()) return;
    const p = await page({ phone: true });
    await repaint(p, panel(allowRow("a1"), allowRow("a2")));
    await p.tap("#bell");
    const b = (await p
      .locator('[data-ap-row="a1"] [data-bell="allow"]')
      .boundingBox())!;
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [at],
    });
    await repaint(p, panel(allowRow("a1"), allowRow("a2")));
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    // The click a tap makes comes just after touchEnd; none ever comes when
    // the button was swapped under the finger.
    await p
      .waitForFunction(
        () => (window as unknown as { clicks: string[] }).clicks.length > 0,
        null,
        { timeout: 2000 },
      )
      .catch(() => {});
    expect(await clicks(p)).toEqual(["allow:a1"]);
    await p.context().close();
  });

  it("a section that goes leaves the next section's rows alone", async () => {
    if (skip()) return;
    const p = await page();
    const other = (id: string) =>
      `<div class="den-bell-row" data-id="${id}"><span>An agent waits</span></div>`;
    const two =
      `<h2 id="den-bell-h">Notifications</h2>` +
      `<section data-scope="allow">${allowRow("a1")}</section>` +
      `<section data-scope="agents">${other("n1")}</section>`;
    await repaint(p, two);
    await p.click("#bell");
    await p.evaluate(() => {
      (
        document.querySelector('[data-id="n1"]') as unknown as { __m: number }
      ).__m = 1;
    });
    await repaint(
      p,
      `<h2 id="den-bell-h">Notifications</h2><section data-scope="agents">${other("n1")}</section>`,
    );
    await expect(
      p.evaluate(
        () =>
          (
            document.querySelector('[data-id="n1"]') as unknown as {
              __m?: number;
            }
          )?.__m,
      ),
    ).resolves.toBe(1);
    expect(await p.locator('[data-scope="allow"]').count()).toBe(0);
    await p.context().close();
  });

  it("the focused button keeps focus across a repaint", async () => {
    if (skip()) return;
    const p = await page();
    await repaint(p, panel(allowRow("a1")));
    await p.click("#bell");
    await p.focus('[data-ap-row="a1"] [data-bell="deny"]');
    await repaint(p, panel(allowRow("a1")));
    await expect(
      p.evaluate(() => (document.activeElement as HTMLElement)?.dataset.bell),
    ).resolves.toBe("deny");
    await p.context().close();
  });
});
