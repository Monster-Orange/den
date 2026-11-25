/**
 * Issue 283: nothing under the Runs bar. The shell mock (den-shell.html)
 * draws the page as a full-height grid whose last row is the dock, so the
 * Runs bar's bottom edge is the window's bottom edge. With the top bar
 * fixed and the body padded by its height (den-ui 0.6.3), pages showed an
 * empty band about 48 px tall under it. Measured, not eyeballed: on every
 * page, in Chromium and WebKit, at 1280 and 390 px, once the page has
 * settled and again after a person's wheel scroll, the gap between the
 * dock's bottom and the window's is 0. (It didn't reproduce on 0.4.89 or
 * on the release it was found in; this guard pins the mock's 0 px.)
 *
 * The distribution is the demo's (examples/distribution); nothing runs.
 * Needs Playwright's chromium and webkit; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
const BROWSERS = ["chromium", "webkit"] as const;
const WIDTHS = [1280, 390] as const;
const PAGES = [
  "/",
  "/services",
  "/agents",
  "/environments",
  "/verify",
  "/logs",
  "/settings",
] as const;
/** Where the wheel turns: the main area (the rail is 233 px wide at 1280,
 *  a drawer below 720). */
const WHEEL_AT = { x: (w: number) => (w > 720 ? 760 : w / 2), y: 400 };
const browsers: Partial<Record<(typeof BROWSERS)[number], Browser>> = {};
let tmp = "";
let port = 0;
let server: ChildProcess | undefined;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const b of BROWSERS) browsers[b] = await launchBrowser(pw[b]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-283-")));
  const root = path.join(tmp, "dist");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        ACME_HOME: path.join(tmp, "home", ".acme"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        ACME_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
  );
  server = started.server;
  port = started.port;
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: server ? [server] : [],
    after: () => fs.rmSync(tmp, { recursive: true, force: true }),
  });
});

/** The px between the dock's bottom and the window's: settled, then wheeled. */
async function bandUnderDock(
  b: Browser,
  url: string,
  width: number,
): Promise<{
  settled: number;
  wheeled: number;
  /** #den-content's scrollTop and the window's scrollY, before and after. */
  scroll: { before: [number, number]; after: [number, number] };
}> {
  const ctx = await b.newContext({ viewport: { width, height: 800 } });
  try {
    await signIn(
      ctx,
      path.join(tmp, "home", ".acme"),
      `http://localhost:${port}`,
    );
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${port}${url}`);
    await p.waitForSelector("#den-dock");
    await p.waitForLoadState("networkidle");
    const band = () =>
      p.evaluate(() => {
        const r = document.getElementById("den-dock")!.getBoundingClientRect();
        return Math.round((window.innerHeight - r.bottom) * 10) / 10;
      });
    const scrolls = () =>
      p.evaluate((): [number, number] => [
        Math.round(document.getElementById("den-content")!.scrollTop),
        Math.round(window.scrollY),
      ]);
    const settled = await band();
    const before = await scrolls();
    // Over the page's main area, below the top bar and right of the rail.
    await p.mouse.move(WHEEL_AT.x(width), WHEEL_AT.y);
    for (let i = 0; i < 6; i++) await p.mouse.wheel(0, 2000);
    // Settled: two equal readings of both scroll positions in a row
    // (WebKit's smooth scroll can still be moving after a frame or two).
    await p.waitForFunction(
      () => {
        const w = window as unknown as { __scroll283?: string };
        const now = `${document.getElementById("den-content")!.scrollTop}|${window.scrollY}`;
        const same = w.__scroll283 === now;
        w.__scroll283 = now;
        return same;
      },
      undefined,
      { polling: 150 },
    );
    return {
      settled,
      wheeled: await band(),
      scroll: { before, after: await scrolls() },
    };
  } finally {
    await ctx.close();
  }
}

describe("issue 283: the Runs bar sits at the window's bottom edge", () => {
  for (const b of BROWSERS)
    for (const w of WIDTHS)
      it(`${b} at ${w} px: no band under the Runs bar on any page`, async () => {
        const browser = browsers[b];
        if (!browser) return;
        const seen: Record<string, number> = {};
        for (const url of PAGES) {
          const m = await bandUnderDock(browser, url, w);
          const worst =
            Math.abs(m.settled) >= Math.abs(m.wheeled) ? m.settled : m.wheeled;
          seen[url] = Math.abs(worst) <= 0.5 ? 0 : worst;
          // The wheel case isn't vacuous: on a long page the wheel scrolls
          // the main area, and never the window.
          if (url === "/settings") {
            expect(m.scroll.after[0]).toBeGreaterThan(m.scroll.before[0]);
            expect(m.scroll.after[1]).toBe(0);
          }
        }
        expect(seen).toEqual(Object.fromEntries(PAGES.map((u) => [u, 0])));
      }, 180_000);
});
