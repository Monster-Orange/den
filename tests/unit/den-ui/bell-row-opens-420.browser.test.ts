/**
 * Issue 420: the kit's bell row (bellRowHtml) opened only from its text
 * link; a click on its time, its dot or the space around did nothing. Den's
 * own bell opens on a click anywhere on the row (den#93). Now the kit's
 * hydrateBell does the same, except on the row's own controls (a button
 * stays a button).
 *
 * The kit's own hydrateBell, from its source, on a page of its own, in
 * Chromium and WebKit, at 1280 and 390 (touch).
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
<link rel="stylesheet" href="/shell.css">
<style>
  .den-bell-pop { position: fixed; top: 60px; right: 8px; width: 340px; }
</style></head>
<body><button id="bell" type="button" title="Notifications">Bell</button>
<script type="module">
import { hydrateBell } from "/shell-client.js";
window.opens = [];
window.presses = [];
// What a host does with its rows' links: here, it only notes them.
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a) return;
  e.preventDefault();
  window.opens.push(a.getAttribute("href"));
});
const items = [
  { id: "n1", text: "An agent finished its run", href: "#open-n1", time: "2 min" },
  { id: "n2", text: "A note with no link", time: "5 min" },
];
window.bell = hydrateBell(document.getElementById("bell"), {
  lang: "en",
  items: () => items,
  // A host's own row with a control, in place of the kit's rows.
  panel: () => window.ownRows ? { body:
    '<div class="den-bell-row" data-id="n3"><a href="#open-n3">Waiting for you</a>' +
    '<button type="button" data-bell="dismiss">Dismiss</button><time>1 min</time></div>' } : null,
});
window.reads = [];
window.bell.el.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) window.presses.push(b.dataset.bell);
  // A host's mark-read on open, on the panel, as Den's bell does it: on a
  // click whose target is the row's link.
  const a = e.target.closest("a[href]");
  if (a) window.reads.push(a.closest("[data-id]").dataset.id);
});
window.ready = true;
</script></body></html>`;

async function page(
  engine: (typeof ENGINES)[number],
  phone: boolean,
): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: phone
      ? { width: 390, height: 844 }
      : { width: 1280, height: 800 },
    ...(phone ? { hasTouch: true, isMobile: true } : {}),
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

const opens = (p: Page) =>
  p.evaluate(() => (window as unknown as { opens: string[] }).opens);
const reads = (p: Page) =>
  p.evaluate(() => (window as unknown as { reads: string[] }).reads);
const presses = (p: Page) =>
  p.evaluate(() => (window as unknown as { presses: string[] }).presses);

/** A click (or a tap, on touch) at a point of the element, not its middle. */
async function hit(
  p: Page,
  sel: string,
  phone: boolean,
  where: "left" | "right" | "middle" = "middle",
) {
  const box = (await p.locator(sel).boundingBox())!;
  const x =
    where === "left"
      ? box.x + 3
      : where === "right"
        ? box.x + box.width - 3
        : box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (phone) await p.touchscreen.tap(x, y);
  else await p.mouse.click(x, y);
}

for (const engine of ENGINES)
  for (const phone of [false, true])
    describe(`420 kit bell row, ${engine} at ${phone ? 390 : 1280}`, () => {
      const skip = () => !browsers[engine];

      it("a click on the row's time opens it, once, as its link does", async () => {
        if (skip()) return;
        const p = await page(engine, phone);
        await p.click("#bell");
        await hit(p, '.den-bell-row[data-id="n1"] time', phone);
        expect(await opens(p)).toEqual(["#open-n1"]);
        await p.context().close();
      });

      it("a click on the row's edge, beside its text, opens it", async () => {
        if (skip()) return;
        const p = await page(engine, phone);
        await p.click("#bell");
        // The row's own padding: neither its link nor its time.
        await hit(p, '.den-bell-row[data-id="n1"]', phone, "left");
        expect(await opens(p)).toEqual(["#open-n1"]);
        await p.context().close();
      });

      it("a click on the link itself opens it once, not twice", async () => {
        if (skip()) return;
        const p = await page(engine, phone);
        await p.click("#bell");
        await hit(p, '.den-bell-row[data-id="n1"] a', phone);
        expect(await opens(p)).toEqual(["#open-n1"]);
        await p.context().close();
      });

      it("the host's mark-read on open runs once, from the link, the time or the edge", async () => {
        if (skip()) return;
        const p = await page(engine, phone);
        await p.click("#bell");
        await hit(p, '.den-bell-row[data-id="n1"]', phone, "left");
        expect(await reads(p)).toEqual(["n1"]);
        await hit(p, '.den-bell-row[data-id="n1"] time', phone);
        expect(await reads(p)).toEqual(["n1", "n1"]);
        await hit(p, '.den-bell-row[data-id="n1"] a', phone);
        expect(await reads(p)).toEqual(["n1", "n1", "n1"]);
        expect(await opens(p)).toEqual(["#open-n1", "#open-n1", "#open-n1"]);
        await p.context().close();
      });

      it("a row with no link does nothing", async () => {
        if (skip()) return;
        const p = await page(engine, phone);
        await p.click("#bell");
        await hit(p, '.den-bell-row[data-id="n2"] time', phone);
        expect(await opens(p)).toEqual([]);
        await p.context().close();
      });

      it("the row's own control stays a control: it does not open the row", async () => {
        if (skip()) return;
        const p = await page(engine, phone);
        await p.evaluate(() => {
          (window as unknown as { ownRows: boolean }).ownRows = true;
        });
        await p.click("#bell");
        await hit(p, '.den-bell-row[data-id="n3"] button', phone);
        expect(await presses(p)).toEqual(["dismiss"]);
        expect(await opens(p)).toEqual([]);
        await hit(p, '.den-bell-row[data-id="n3"] time', phone);
        expect(await opens(p)).toEqual(["#open-n3"]);
        await p.context().close();
      });

      it("a row that opens shows the pointer", async () => {
        if (skip() || phone) return;
        const p = await page(engine, phone);
        await p.click("#bell");
        const cur = (sel: string) =>
          p.$eval(sel, (el) => getComputedStyle(el).cursor);
        // As Den's bell (issue 187): every part of the row, not only its link.
        for (const part of ["", " a", " time"])
          expect(await cur(`.den-bell-row[data-id="n1"]${part}`)).toBe(
            "pointer",
          );
        expect(await cur('.den-bell-row[data-id="n2"]')).not.toBe("pointer");
        await p.context().close();
      });

      it("Enter on the row's link opens it once, as in Den's bell", async () => {
        if (skip() || phone) return;
        const p = await page(engine, phone);
        await p.click("#bell");
        await p.focus('.den-bell-row[data-id="n1"] a');
        await p.keyboard.press("Enter");
        expect(await opens(p)).toEqual(["#open-n1"]);
        await p.context().close();
      });
    });
