/**
 * den-ui 0.7.2 (issue 311): on a phone, the rail's drawer never slides on
 * page load. Before, `.den-rail` carried `transition: transform` from the
 * start, so in WebKit the rail showed over the page as it loaded and then
 * slid shut. Now the transition sits only under a class the kit adds when
 * the person first opens or closes the drawer.
 *
 * At 390×844, motion allowed: the rail's x is sampled on every frame from
 * the first one (an init script's requestAnimationFrame loop), for a page
 * whose shell came with the HTML and for one the kit mounts. Every sample
 * is fully off-screen. Then ☰ opens the drawer and Esc closes it: both
 * animate (an in-between x is seen). With reduced motion, neither does.
 *
 * On a bare page built from the kit's own files, in Chromium and WebKit.
 * DEN_PW_WS: Den's own Playwright server instead of a local browser.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { shellHtml } from "../../../packages/den-ui/src/shell-html.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
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

const STYLES = ["tokens", "fonts", "base", "shell", "report", "dialog"];

const MODEL = {
  lang: "en",
  product: {
    name: "Acme",
    version: "1.0.0",
    mark: { text: "A", label: "Acme" },
  },
  groups: [{ id: "work", label: "Work" }],
  nav: [
    {
      id: "home",
      label: "Home",
      href: "/",
      group: "work",
      icon: "home",
      current: true,
    },
    { id: "runs", label: "Runs", href: "/runs", group: "work", icon: "home" },
  ],
};

/** The page: `server` has the shell in its HTML (as Den serves it), else the kit mounts it. */
const page = (server: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${STYLES.map((s) => `<link rel="stylesheet" href="/kit/${s}.css">`).join("\n")}
<style>body { margin: 0; }</style>
</head>
<body class="den-has-shell"><div class="den-shell" id="den-shell">${server ? shellHtml(MODEL) : ""}</div>
<main id="den-content"><p>Some words on the page.</p></main>
<script type="module" src="/app.js?${server ? "hydrate" : "mount"}"></script>
</body></html>`;

const APP = `
import DenUI from "/kit/kit.js";
const model = ${JSON.stringify(MODEL)};
DenUI.configure({ lang: "en", product: { name: "Acme" } });
const root = document.getElementById("den-shell");
if (new URL(import.meta.url).search === "?hydrate") DenUI.hydrate(root, {});
else DenUI.mount(root, model);
window.ready = true;
`;

/** Every frame from the first: the rail's left edge and width, or null before it exists. */
function sampleFrames() {
  const w = window as unknown as {
    railX: Array<[number, number] | null>;
    sampling: boolean;
  };
  w.railX = [];
  w.sampling = true;
  const t0 = performance.now();
  const tick = () => {
    const r = document.getElementById("den-rail");
    if (r) {
      const b = r.getBoundingClientRect();
      w.railX.push([Math.round(b.x), Math.round(b.width)]);
    } else w.railX.push(null);
    if (w.sampling && performance.now() - t0 < 1500)
      requestAnimationFrame(tick);
    else w.sampling = false;
  };
  requestAnimationFrame(tick);
}

async function open(
  b: Browser,
  server: boolean,
  reducedMotion: "reduce" | "no-preference" = "no-preference",
  o: { phone?: boolean; landscape?: boolean } = {},
): Promise<Page> {
  const ctx = await b.newContext({
    viewport: o.landscape
      ? { width: 844, height: 390 }
      : { width: 390, height: 844 },
    reducedMotion,
    ...(o.phone
      ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
      : {}),
  });
  await ctx.addInitScript(sampleFrames);
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: page(server) });
    if (u.pathname === "/app.js")
      return r.fulfill({ contentType: "text/javascript", body: APP });
    const f = u.pathname.replace(/^\/kit\//, "");
    const file = path.join(SRC, f);
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: f.endsWith(".css")
          ? "text/css"
          : f.endsWith(".woff2")
            ? "font/woff2"
            : "text/javascript",
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(() => (window as { ready?: boolean }).ready === true);
  return p;
}

/** The samples of the page's first frames (waits for the 1.5 s window to end). */
async function loadSamples(p: Page) {
  // The sampler stops itself when its window ends.
  await p.waitForFunction(
    () => {
      const w = window as unknown as { railX: unknown[]; sampling: boolean };
      return w.railX.length > 0 && !w.sampling;
    },
    undefined,
    { timeout: 10_000 },
  );
  return p.evaluate(
    () =>
      (window as unknown as { railX: Array<[number, number] | null> }).railX,
  );
}

/**
 * The rail's x on every frame while `act` runs, until it holds still: no
 * animation on the rail, and the same x on the last 3 frames after `act`.
 */
async function xsDuring(p: Page, act: () => Promise<void>) {
  await p.evaluate(() => {
    const w = window as unknown as { xs: number[]; on: boolean };
    w.xs = [];
    w.on = true;
    const tick = () => {
      const r = document.getElementById("den-rail")!;
      w.xs.push(Math.round(r.getBoundingClientRect().x));
      if (w.on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  const after = await p.evaluate(
    () => (window as unknown as { xs: number[] }).xs.length,
  );
  await p.waitForFunction(
    (after) => {
      const w = window as unknown as { xs: number[] };
      const tail = w.xs.slice(after);
      const r = document.getElementById("den-rail")!;
      return (
        tail.length >= 3 &&
        r.getAnimations().length === 0 &&
        tail.slice(-3).every((x) => x === tail[tail.length - 1])
      );
    },
    after,
    { polling: "raf", timeout: 10_000 },
  );
  return p.evaluate(() => {
    const w = window as unknown as { xs: number[]; on: boolean };
    w.on = false;
    return w.xs;
  });
}

const offScreen = (s: [number, number] | null) =>
  s === null || s[0] + s[1] <= 0;

for (const engine of ["chromium", "webkit"]) {
  describe(`den-ui 0.7.2 the phone rail never slides on load (${engine})`, () => {
    for (const [server, o, label] of [
      [true, {}, "a shell in the page's HTML"],
      [false, {}, "a shell the kit mounts"],
      [true, { phone: true }, "a phone, a shell in the page's HTML"],
    ] as const) {
      it(`${label}: the rail is off-screen from the first frame, no in-between x`, async () => {
        const b = browsers[engine];
        if (!b) return;
        const p = await open(b, server, "no-preference", o);
        const xs = await loadSamples(p);
        const seen = xs.filter((s) => s !== null);
        expect(seen.length).toBeGreaterThan(0);
        // Every frame: the rail's right edge is at or left of the screen's.
        expect(xs.filter((s) => !offScreen(s))).toEqual([]);
        // And it never moved: one x from the first frame on.
        expect(new Set(seen.map((s) => s![0])).size).toBe(1);
        await p.context().close();
      });
    }

    // The same move as a load whose first style is wider than the phone
    // (the media query flips after the rail was drawn docked): a phone
    // turned from landscape to portrait. The rail goes straight from
    // docked to shut, no frame in between.
    it("the window narrows past 720 before anyone touched ☰: the rail goes straight to shut", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, true, "no-preference", { landscape: true });
      await loadSamples(p);
      const xs = await xsDuring(p, () =>
        p.setViewportSize({ width: 390, height: 844 }),
      );
      const w = await p.evaluate(() =>
        Math.round(
          document.getElementById("den-rail")!.getBoundingClientRect().width,
        ),
      );
      const shut = xs[xs.length - 1];
      expect(shut + w).toBeLessThanOrEqual(0);
      expect(xs.filter((x) => x !== 0 && x !== shut)).toEqual([]);
      await p.context().close();
    });

    it("opening and closing the drawer still animate", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, true);
      await loadSamples(p);
      const rail = await p.evaluate(() => {
        const b = document.getElementById("den-rail")!.getBoundingClientRect();
        return { x: Math.round(b.x), w: Math.round(b.width) };
      });
      const opening = await xsDuring(p, () =>
        p.locator("#den-menu-btn").click(),
      );
      expect(await p.evaluate(() => document.body.className)).toContain(
        "den-rail-open",
      );
      // It ends at 0, and passed through x's between shut and open.
      expect(opening[opening.length - 1]).toBe(0);
      expect(opening.some((x) => x > rail.x + 1 && x < -1)).toBe(true);
      const dur = await p.evaluate(
        () =>
          getComputedStyle(document.getElementById("den-rail")!)
            .transitionDuration,
      );
      expect(dur).not.toBe("0s");
      const closing = await xsDuring(p, () => p.keyboard.press("Escape"));
      expect(closing[closing.length - 1]).toBe(rail.x);
      expect(closing.some((x) => x > rail.x + 1 && x < -1)).toBe(true);
      // After a person's open and close, the transition is still there.
      expect(
        await p.evaluate(
          () =>
            getComputedStyle(document.getElementById("den-rail")!)
              .transitionDuration,
        ),
      ).not.toBe("0s");
      await p.context().close();
    });

    it("with reduced motion, opening and closing don't animate", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b, true, "reduce");
      await loadSamples(p);
      const shut = await p.evaluate(() =>
        Math.round(
          document.getElementById("den-rail")!.getBoundingClientRect().x,
        ),
      );
      const opening = await xsDuring(p, () =>
        p.locator("#den-menu-btn").click(),
      );
      expect(opening.filter((x) => x !== shut && x !== 0)).toEqual([]);
      expect(
        await p.evaluate(
          () =>
            getComputedStyle(document.getElementById("den-rail")!)
              .transitionDuration,
        ),
      ).toBe("0s");
      const closing = await xsDuring(p, () => p.keyboard.press("Escape"));
      expect(closing.filter((x) => x !== shut && x !== 0)).toEqual([]);
      await p.context().close();
    });
  });
}
