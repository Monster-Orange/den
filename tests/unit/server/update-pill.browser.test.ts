/**
 * The shared update pill (den-ui update-pill.js) in Den, in a real browser,
 * Chromium and WebKit, on the real web server. /api/server-info is routed
 * so the engine on disk reads newer than the one the server runs (MD-2):
 * that is what offers the pill. Same intent as the shared pill's own e2e:
 *
 *   - see-through: the pill's background alpha is below 1 and the bar's
 *     colour shows through it;
 *   - no full-width strip: the bar beside the pill is pixel-identical with
 *     and without it;
 *   - Reload whole and unclipped at 100% and 200% zoom;
 *   - the pill sits within the bar's band;
 *   - unsaved text: Reload asks first, Cancel goes back;
 *   - Reload restarts Den's server in place, then reloads the page;
 *   - Not now hides it, and it stays hidden for that version (this tab);
 *   - es and ja words.
 *
 * DEN_PW_WS: Den's own Playwright server. DEN_SKIP_BROWSER_TESTS=1 skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let s: AgentsPageServer | null = null;
const browsers: Record<string, Browser | null> = {
  chromium: null,
  webkit: null,
};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const name of ["chromium", "webkit"] as const) {
      const kind = pw[name];
      browsers[name] = await launchBrowser(kind);
    }
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

// Closing two launched browsers and the server can pass 10 s on a busy
// CI runner (seen on one shard once WebKit ran there): the same allowance
// as the start above.
afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
}, 90_000);

interface Stub {
  /** The version on disk the server reports (stale while set). */
  onDisk: string | null;
  restarts: number;
}

/** A page on /agents (or `path`), with server-info routed through `stub`. */
async function open(
  name: string,
  o: {
    path?: string;
    width?: number;
    height?: number;
    scale?: number;
    stub?: Stub;
    ctx?: BrowserContext;
  } = {},
): Promise<{ p: Page; ctx: BrowserContext; stub: Stub }> {
  const b = browsers[name]!;
  const ctx =
    o.ctx ??
    (await b.newContext({
      viewport: { width: o.width ?? 1280, height: o.height ?? 800 },
      deviceScaleFactor: o.scale ?? 1,
      colorScheme: "light",
      reducedMotion: "reduce",
    }));
  // What's new opens on a brand-new Den; it isn't what's under test.
  if (!o.ctx)
    await ctx.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const st = document.createElement("style");
        st.textContent = "#cl-overlay{display:none!important}";
        document.head.appendChild(st);
      });
    });
  const stub = o.stub ?? { onDisk: "9.9.0", restarts: 0 };
  await ctx.route("**/api/server-info", async (route) => {
    const res = await route.fetch();
    const j = (await res.json()) as Record<string, unknown>;
    if (stub.restarts > 0) {
      // A new server: a new pid and start time.
      j.pid = Number(j.pid) + 100_000 * stub.restarts;
      j.startedAt = new Date(Date.now() - 1000).toISOString();
    }
    j.engineStale = stub.onDisk != null;
    j.onDisk = { version: stub.onDisk };
    await route.fulfill({ response: res, json: j });
  });
  await ctx.route("**/api/web/restart", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    stub.restarts += 1;
    stub.onDisk = null;
    await route.fulfill({ json: { ok: true } });
  });
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, o.path ?? "/agents"));
  await p.waitForFunction(() => "denShell" in window, undefined, {
    timeout: 20_000,
  });
  return { p, ctx, stub };
}

/**
 * The page polls server-info, so a route handler can be mid-fetch as a
 * test ends. Unroute first: errors from a handler still running are then
 * dropped, as Playwright advises, instead of failing the test with
 * "Response has been disposed".
 */
async function closeCtx(ctx: BrowserContext): Promise<void> {
  await ctx.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
}

const PILL = ".den-upd .upd-pill";

async function pillShows(p: Page): Promise<void> {
  await p.waitForSelector(PILL, { state: "visible", timeout: 20_000 });
  // The words settle with the screen reader's status, filled just after.
  await p.waitForFunction(
    (sel) => (document.querySelector(sel)?.textContent ?? "") !== "",
    ".den-upd .upd-sr",
  );
}

/** Two frames painted since the last change, so a screenshot shows it. */
async function painted(p: Page): Promise<void> {
  await p.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
}

/** The bar's colour is `colour` and everything in it hidden, as computed. */
async function barPainted(p: Page, colour: string): Promise<void> {
  await p.waitForFunction((c) => {
    const bar = document.querySelector(".den-top")!;
    return (
      getComputedStyle(bar).backgroundColor === c &&
      [...bar.querySelectorAll("*")].every(
        (e) => getComputedStyle(e).visibility === "hidden",
      )
    );
  }, colour);
  await painted(p);
}

type Rect = { left: number; top: number; right: number; bottom: number };
async function rect(p: Page, sel: string): Promise<Rect> {
  return p.evaluate((q) => {
    const r = document.querySelector(q)!.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }, sel);
}

/** One pixel of the page as painted, [r, g, b]. */
async function pixel(p: Page, x: number, y: number): Promise<number[]> {
  const png = await p.screenshot({
    clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 },
    scale: "css",
  });
  return p.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0, 1, 1);
    return Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, png.toString("base64"));
}

/** The bar one flat colour, its contents hidden. */
async function paintBar(p: Page, colour: string): Promise<void> {
  await p.evaluate((c) => {
    const bar = document.querySelector<HTMLElement>(".den-top")!;
    bar.style.setProperty("background", c, "important");
    for (const el of bar.querySelectorAll<HTMLElement>("*"))
      el.style.setProperty("visibility", "hidden", "important");
  }, colour);
}

for (const name of ["chromium", "webkit"]) {
  describe(`update pill (${name})`, () => {
    it("see-through: alpha below 1 and the bar's colour shows through", async () => {
      if (!browsers[name]) return;
      const { p, ctx } = await open(name);
      try {
        await pillShows(p);
        const bg = await p.$eval(
          PILL,
          (el) => getComputedStyle(el).backgroundColor,
        );
        const m =
          /\/\s*([\d.]+)\s*\)$/.exec(bg) ??
          /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(bg);
        expect(m).not.toBeNull();
        expect(Number(m![1])).toBeLessThan(1);
        // Paint the bar a strong green, its contents and the pill's own
        // words hidden: the pill's fill takes on the green.
        await paintBar(p, "rgb(0, 160, 0)");
        await p.$$eval(`${PILL} > *`, (els) =>
          els.forEach((e) => ((e as HTMLElement).style.visibility = "hidden")),
        );
        await barPainted(p, "rgb(0, 160, 0)");
        const r = await rect(p, PILL);
        const [red, green, blue] = await pixel(
          p,
          (r.left + r.right) / 2,
          (r.top + r.bottom) / 2,
        );
        expect(green - red).toBeGreaterThan(60);
        expect(green - blue).toBeGreaterThan(60);
        // And another bar colour changes it.
        const inside = {
          x: Math.round((r.left + r.right) / 2) - 20,
          y: Math.round((r.top + r.bottom) / 2) - 4,
          width: 40,
          height: 8,
        };
        const greenShot = await p.screenshot({ clip: inside });
        await paintBar(p, "rgb(0, 0, 255)");
        await barPainted(p, "rgb(0, 0, 255)");
        expect(greenShot.equals(await p.screenshot({ clip: inside }))).toBe(
          false,
        );
      } finally {
        await closeCtx(ctx);
      }
    }, 60_000);

    it("no full-width strip: the bar beside the pill is pixel-identical with and without it", async () => {
      if (!browsers[name]) return;
      const { p, ctx } = await open(name);
      try {
        await pillShows(p);
        const r = await rect(p, PILL);
        const bar = await rect(p, ".den-top");
        const vw = await p.evaluate(() => window.innerWidth);
        // Clear of the pill's shadow (0 10px 28px): 48px either side.
        const clips = [
          { x: 0, y: 0, width: Math.floor(r.left - 48), height: bar.bottom },
          {
            x: Math.ceil(r.right + 48),
            y: 0,
            width: vw - Math.ceil(r.right + 48),
            height: bar.bottom,
          },
        ];
        for (const c of clips) expect(c.width).toBeGreaterThan(100);
        // The bar's own words hidden: text antialiasing may change while a
        // blurred layer is on the page; a strip would paint the bar itself.
        await p.$$eval(".den-top *", (els) =>
          els.forEach((e) =>
            (e as HTMLElement).style.setProperty(
              "visibility",
              "hidden",
              "important",
            ),
          ),
        );
        await p.waitForFunction(() =>
          [...document.querySelectorAll(".den-top *")].every(
            (e) => getComputedStyle(e).visibility === "hidden",
          ),
        );
        await painted(p);
        const shot = () =>
          Promise.all(clips.map((clip) => p.screenshot({ clip })));
        const withPill = await shot();
        await p.$eval(".den-upd", (el) => ((el as HTMLElement).hidden = true));
        await p.locator(PILL).waitFor({ state: "hidden" });
        await painted(p);
        const without = await shot();
        for (let i = 0; i < clips.length; i++)
          expect(withPill[i].equals(without[i])).toBe(true);
        // And the box itself paints nothing, blurs nothing, takes no clicks.
        const box = await p.$eval(".den-upd", (el) => {
          const cs = getComputedStyle(el);
          return {
            bg: cs.backgroundColor,
            blur:
              cs.backdropFilter ||
              (cs as unknown as { webkitBackdropFilter?: string })
                .webkitBackdropFilter ||
              "none",
            pe: cs.pointerEvents,
          };
        });
        expect(box.bg).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/);
        expect(box.blur).toBe("none");
        expect(box.pe).toBe("none");
      } finally {
        await closeCtx(ctx);
      }
    }, 60_000);

    for (const zoom of [
      { label: "100%", width: 1280, height: 800, scale: 1 },
      { label: "200%", width: 640, height: 400, scale: 2 },
    ])
      it(`Reload is whole and unclipped at ${zoom.label}`, async () => {
        if (!browsers[name]) return;
        const { p, ctx } = await open(name, zoom);
        try {
          await pillShows(p);
          const go = await rect(p, ".den-upd .upd-go");
          const pill = await rect(p, PILL);
          expect(go.left).toBeGreaterThanOrEqual(0);
          expect(go.right).toBeLessThanOrEqual(zoom.width);
          expect(go.top).toBeGreaterThanOrEqual(pill.top);
          expect(go.bottom).toBeLessThanOrEqual(pill.bottom);
          expect(go.left).toBeGreaterThanOrEqual(pill.left);
          expect(go.right).toBeLessThanOrEqual(pill.right);
          const fit = await p.$eval(".den-upd .upd-go", (el) => ({
            sw: el.scrollWidth,
            cw: el.clientWidth,
            text: (el as HTMLElement).innerText,
            hit:
              document.elementFromPoint(
                el.getBoundingClientRect().left + el.clientWidth / 2,
                el.getBoundingClientRect().top + el.clientHeight / 2,
              ) === el,
          }));
          expect(fit.text).toBe("Reload");
          expect(fit.sw).toBeLessThanOrEqual(fit.cw);
          expect(fit.hit).toBe(true);
        } finally {
          await closeCtx(ctx);
        }
      }, 60_000);

    it("the pill sits within the bar's band, centred on it", async () => {
      if (!browsers[name]) return;
      const { p, ctx } = await open(name);
      try {
        await pillShows(p);
        const pill = await rect(p, PILL);
        const bar = await rect(p, ".den-top");
        expect(pill.top).toBeGreaterThanOrEqual(bar.top - 2);
        expect(pill.bottom).toBeLessThanOrEqual(bar.bottom + 2);
        expect(
          Math.abs((pill.top + pill.bottom) / 2 - (bar.top + bar.bottom) / 2),
        ).toBeLessThanOrEqual(1);
        // The old dashed banner is gone.
        expect(await p.$('[data-banner="engine"]')).toBeNull();
      } finally {
        await closeCtx(ctx);
      }
    }, 60_000);

    it("unsaved text: Reload asks first, then Cancel goes back", async () => {
      if (!browsers[name]) return;
      const { p, ctx, stub } = await open(name);
      try {
        await pillShows(p);
        await p.evaluate(() => {
          const f = document.createElement("form");
          f.innerHTML = '<textarea id="probe-ta"></textarea>';
          document.getElementById("den-content")!.append(f);
        });
        await p.fill("#probe-ta", "half a thought");
        await p.click(".den-upd .upd-go");
        expect(await p.textContent(".den-upd .upd-msg")).toBe(
          "You have unsaved text on this page. Reload anyway?",
        );
        expect(await p.textContent(".den-upd .upd-dismiss")).toBe("Cancel");
        expect(stub.restarts).toBe(0);
        await p.click(".den-upd .upd-dismiss");
        expect(await p.textContent(".den-upd .upd-msg")).toBe(
          "A new version of Den is available.",
        );
        expect(
          await p.getAttribute(".den-upd .upd-dismiss", "aria-label"),
        ).toBe("Not now");
        expect(await p.isVisible(PILL)).toBe(true);
        expect(stub.restarts).toBe(0);
        expect(await p.inputValue("#probe-ta")).toBe("half a thought");
      } finally {
        await closeCtx(ctx);
      }
    }, 60_000);

    it("Reload restarts Den's server in place, then reloads the page", async () => {
      if (!browsers[name]) return;
      const { p, ctx, stub } = await open(name);
      try {
        await pillShows(p);
        await p.evaluate(() => {
          (window as unknown as { __before: number }).__before = 1;
        });
        await p.click(".den-upd .upd-go");
        await p.waitForFunction(
          () => !(window as unknown as { __before?: number }).__before,
          undefined,
          { timeout: 30_000 },
        );
        expect(stub.restarts).toBe(1);
        await p.waitForFunction(() => "denShell" in window);
        // Kept: this proves the pill does NOT come back once the new page
        // has had time to ask server-info; there is no state to wait for.
        await p.waitForTimeout(1500);
        expect(await p.$(PILL)).toBeNull();
      } finally {
        await closeCtx(ctx);
      }
    }, 60_000);

    it("Not now hides it, and it stays hidden for that version", async () => {
      if (!browsers[name]) return;
      const { p, ctx, stub } = await open(name);
      try {
        await pillShows(p);
        await p.click(".den-upd .upd-dismiss");
        expect(await p.$(PILL)).toBeNull();
        // Another page, the same tab: still hidden.
        await p.goto(`${s!.base}/services`);
        await p.waitForFunction(() => "denShell" in window);
        // Kept: this proves the pill does NOT show again on this page once
        // it has had time to ask server-info; there is no state to wait for.
        await p.waitForTimeout(2000);
        expect(await p.$(PILL)).toBeNull();
        // A newer version: it shows again.
        stub.onDisk = "9.9.1";
        await p.reload();
        await pillShows(p);
      } finally {
        await closeCtx(ctx);
      }
    }, 60_000);

    for (const [lang, words] of [
      [
        "es",
        {
          msg: "Hay una nueva versión de Den.",
          go: "Recargar",
          dismiss: "Ahora no",
          ask: "Tienes texto sin guardar en esta página. ¿Recargar igualmente?",
          cancel: "Cancelar",
        },
      ],
      [
        "ja",
        {
          msg: "Den の新しいバージョンがあります。",
          go: "再読み込み",
          dismiss: "後で",
          ask: "このページに保存していないテキストがあります。それでも再読み込みしますか?",
          cancel: "キャンセル",
        },
      ],
    ] as const)
      it(`${lang} words`, async () => {
        if (!browsers[name]) return;
        await s!.settings({ language: lang });
        const { p, ctx } = await open(name);
        try {
          await pillShows(p);
          expect(await p.textContent(".den-upd .upd-msg")).toBe(words.msg);
          expect(await p.textContent(".den-upd .upd-go")).toBe(words.go);
          expect(
            await p.getAttribute(".den-upd .upd-dismiss", "aria-label"),
          ).toBe(words.dismiss);
          await p.evaluate(() => {
            const f = document.createElement("form");
            f.innerHTML = '<input type="text" id="probe-in">';
            document.getElementById("den-content")!.append(f);
          });
          await p.fill("#probe-in", "x");
          await p.click(".den-upd .upd-go");
          expect(await p.textContent(".den-upd .upd-msg")).toBe(words.ask);
          expect(await p.textContent(".den-upd .upd-dismiss")).toBe(
            words.cancel,
          );
        } finally {
          await closeCtx(ctx);
          await s!.settings({ language: "en" });
        }
      }, 60_000);
  });
}
