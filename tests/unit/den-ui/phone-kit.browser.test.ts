/**
 * den-ui, issue 302: the phone kit in a browser, with no product around
 * it, at 390x844 with touch, in Chromium and WebKit (an iPhone's engine).
 * A bare page loads tokens.css, base.css, shell.css and phone.css, a top
 * bar of the kit's buttons, a reading area and a foot with a field, and
 * starts phone.js's keyboard watcher.
 *
 *   - the keyboard: a text field focused and the visual viewport 336px
 *     shorter than the window (an iOS keyboard; a real one can't be
 *     emulated) sets data-kbd-up and --vv-h on the root; the top bar and
 *     anything marked data-kbd-hide step aside; a cut under 120px (the
 *     browser's own bars) or no field focused is not a keyboard;
 *   - a tap on the reading area (data-kbd-dismiss) puts the keyboard
 *     down, a tap on a button there does not;
 *   - the safe area: --safe-top / -bottom pad the top bar and the foot
 *     (faked here: a browser tab's insets are 0);
 *   - every top-bar button is at least 44px each way; nothing scrolls
 *     sideways.
 *
 * The visual viewport is a stand-in (window.visualViewport), set before
 * the page's scripts run.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const ENGINES = ["chromium", "webkit"] as const;
type Engine = (typeof ENGINES)[number];
const browsers: Partial<Record<Engine, Browser>> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES)
      browsers[e] = process.env.DEN_PW_WS
        ? await pw[e].connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await pw[e].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
});

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/phone.css"></head>
<body class="den-has-shell">
<header class="den-top" id="top"><button class="den-ib" id="menu" aria-label="Menu">☰</button>
<span></span><span class="den-end"><button class="den-ib" id="bell" aria-label="Bell">🔔</button>
<button class="den-rb" id="rep">Report</button></span></header>
<main id="den-content"><div id="read" data-kbd-dismiss style="height:400px">words
<button id="inread">A button</button></div>
<div id="extra" data-kbd-hide>Runs</div>
<form class="den-phone-foot" id="foot"><textarea id="box"></textarea><button id="send">Send</button></form>
</main>
<script type="module">
import { initKeyboardUp } from "/phone.js";
window.undo = initKeyboardUp();
window.ready = true;
</script></body></html>`;

/** Before any script: a visual viewport the test sets (vv(height)). */
function fakeViewport() {
  const vv = new EventTarget() as EventTarget & { height: number };
  let h = window.innerHeight;
  Object.defineProperty(vv, "height", { get: () => h });
  Object.defineProperty(vv, "width", { get: () => window.innerWidth });
  Object.defineProperty(vv, "offsetTop", { get: () => 0 });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    get: () => vv,
  });
  (window as unknown as { vv: (n: number) => void }).vv = (n: number) => {
    h = n;
    vv.dispatchEvent(new Event("resize"));
  };
}

async function open(engine: Engine): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(fakeViewport);
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
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
      {
        timeout: 10_000,
      },
    )
    .catch((e: Error) => {
      throw new Error(`page not ready: ${errors.join("; ") || e.message}`);
    });
  return p;
}

const up = (p: Page) =>
  p.evaluate(() => ({
    up: "kbdUp" in document.documentElement.dataset,
    vvh: document.documentElement.style.getPropertyValue("--vv-h"),
  }));
const cut = (p: Page, h: number) =>
  p.evaluate(
    (n) => (window as unknown as { vv: (n: number) => void }).vv(n),
    h,
  );
/** A frame for the watcher's settle (it reads on the next frame). */
const frame = (p: Page) =>
  p.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))),
  );

describe.each(ENGINES)("issue 302: the phone kit in %s", (engine) => {
  it("a field focused and the viewport cut by 336px: data-kbd-up, --vv-h, chrome steps aside", async () => {
    if (!browsers[engine]) return;
    const p = await open(engine);
    expect(await up(p)).toEqual({ up: false, vvh: "" });
    expect(await p.locator("#top").isVisible()).toBe(true);
    await p.locator("#box").tap();
    await cut(p, 508);
    await frame(p);
    expect(await up(p)).toEqual({ up: true, vvh: "508px" });
    expect(await p.locator("#top").isVisible()).toBe(false);
    expect(await p.locator("#extra").isVisible()).toBe(false);
    // The page's top no longer makes room for the hidden bar.
    const pad = await p.evaluate(
      () => getComputedStyle(document.body).paddingTop,
    );
    expect(pad).toBe("0px");
    // Back to the window's height: down again, the chrome is back.
    await cut(p, 844);
    await frame(p);
    expect(await up(p)).toEqual({ up: false, vvh: "" });
    expect(await p.locator("#top").isVisible()).toBe(true);
    expect(await p.locator("#extra").isVisible()).toBe(true);
    await p.context().close();
  }, 60_000);

  it("the browser's own bars (a cut under 120px), or no field focused: not a keyboard", async () => {
    if (!browsers[engine]) return;
    const p = await open(engine);
    await p.locator("#box").tap();
    await cut(p, 844 - 119);
    await frame(p);
    expect((await up(p)).up).toBe(false);
    await p.evaluate(() => (document.activeElement as HTMLElement).blur());
    await cut(p, 508);
    await frame(p);
    expect((await up(p)).up).toBe(false);
    await p.context().close();
  }, 60_000);

  it("a tap on the reading area puts the keyboard down; a tap on a button there does not", async () => {
    if (!browsers[engine]) return;
    const p = await open(engine);
    await p.locator("#box").tap();
    await cut(p, 508);
    await frame(p);
    await p.locator("#inread").tap();
    await frame(p);
    // The button took the tap as its own: the field may have lost focus
    // to it, but the watcher blurred nothing itself.
    await p.locator("#box").focus();
    await frame(p);
    expect((await up(p)).up).toBe(true);
    await p.locator("#read").tap({ position: { x: 300, y: 300 } });
    await frame(p);
    const active = await p.evaluate(() => document.activeElement?.id ?? "");
    expect(active).not.toBe("box");
    expect((await up(p)).up).toBe(false);
    await p.context().close();
  }, 60_000);

  it("the safe area pads the top bar and the foot; the keyboard up drops the foot's inset", async () => {
    if (!browsers[engine]) return;
    const p = await open(engine);
    const pads = () =>
      p.evaluate(() => ({
        top: getComputedStyle(document.getElementById("top")!).paddingTop,
        topH: document.getElementById("top")!.getBoundingClientRect().height,
        body: getComputedStyle(document.body).paddingTop,
        foot: getComputedStyle(document.getElementById("foot")!).paddingBottom,
      }));
    // A browser tab: no insets; the foot keeps its own 12px.
    expect(await pads()).toEqual({
      top: "0px",
      topH: 48,
      body: "48px",
      foot: "12px",
    });
    // An iPhone's (faked: a spec can't set env()).
    await p.evaluate(() => {
      const s = document.documentElement.style;
      s.setProperty("--safe-top", "47px");
      s.setProperty("--safe-bottom", "34px");
    });
    expect(await pads()).toEqual({
      top: "47px",
      topH: 95,
      body: "95px",
      foot: "34px",
    });
    await p.locator("#box").tap();
    await cut(p, 508);
    await frame(p);
    // The foot sits on the keyboard: no home indicator under it.
    expect((await pads()).foot).toBe("8px");
    await p.context().close();
  }, 60_000);

  it("every top-bar button is at least 44px each way, and nothing scrolls sideways", async () => {
    if (!browsers[engine]) return;
    const p = await open(engine);
    const small = await p.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".den-top button")]
        .map((b) => {
          const r = b.getBoundingClientRect();
          return { id: b.id, w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((b) => b.w < 44 || b.h < 44),
    );
    expect(small).toEqual([]);
    const over = await p.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);
});
