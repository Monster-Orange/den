/**
 * Issue 163: a link to a row (/settings#agents.keep_running, as the bell
 * gives one) lands on that row and keeps it in view while content above
 * it loads late. The persona list (Settings › Agents) is drawn after its
 * own request answers, above the row; it pushed the row below the fold
 * after the page had scrolled to it (WebKit), or before it ever did
 * (Chromium). The row is marked for a moment, and a scroll of your own
 * while the page settles is never undone.
 *
 * The real web server on the demo distribution (helpers/agents-page-
 * server.ts); the persona list's request is held ~1.5 s. Chromium and
 * WebKit at 1440x900. DEN_PW_WS uses Den's own Playwright server.
 * DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
const browsers: Partial<Record<Engine, Browser>> = {};
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];
const ROW = '[data-setting="agents.keep_running"]';
const HELD_MS = 1500;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

const skip = () => !browsers.chromium || !browsers.webkit;

/** /settings#agents.keep_running with the persona list held back. */
async function open(e: Engine): Promise<{ p: Page; landed: Promise<void> }> {
  const ctx = await browsers[e]!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  // Signed in first, in a tab of its own (signing in keeps the path, not
  // the #).
  const first = await ctx.newPage();
  await signInPage(first, s!.stateDir, s!.base, "/settings");
  await first.waitForSelector(ROW);
  // The link opens in a fresh tab of the same signed-in browser: a fresh
  // load, as from a bell link. Not via about:blank in the same tab: under
  // load, WebKit's process swap from about:blank failed the next goto with
  // "WebKit encountered an internal error".
  const p = await ctx.newPage();
  p.on("pageerror", (x) => errors.push(`${e}: ${x.message}`));
  let done!: () => void;
  const landed = new Promise<void>((r) => (done = r));
  await p.route(/\/api\/personas(\?|$)/, async (route) => {
    await new Promise((r) => setTimeout(r, HELD_MS));
    await route.continue();
    // The list draws on the answer; give it a frame or two.
    setTimeout(done, 400);
  });
  await first.close();
  await p.goto(`${s!.base}/settings#agents.keep_running`);
  return { p, landed };
}

const rowBox = (p: Page) =>
  p.$eval(ROW, (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height };
  });

describe("issue 163: a link to a Settings row stays on it while late content loads", () => {
  it.each(ENGINES)(
    "%s: the row is in view after the persona list lands, and marked",
    async (e) => {
      if (skip()) return;
      const { p, landed } = await open(e);
      await landed;
      await p.waitForSelector('[data-setting="agents.personas"] .plist');
      await p.waitForTimeout(300);
      const { top, height } = await rowBox(p);
      expect({ e, top, inView: top >= 0 && top < 900 - height }).toEqual({
        e,
        top,
        inView: true,
      });
      expect(
        await p.$eval(ROW, (el) => el.classList.contains("set-arrived")),
      ).toBe(true);
      await p.context().close();
    },
    60_000,
  );

  it.each(ENGINES)(
    "%s: a scroll of your own while it settles is not undone",
    async (e) => {
      if (skip()) return;
      const { p, landed } = await open(e);
      await p.waitForSelector(ROW);
      await p.waitForTimeout(300);
      // You scroll back to the top before the persona list lands.
      await p.mouse.move(900, 450);
      await p.mouse.wheel(0, -20000);
      await p.waitForTimeout(300);
      await landed;
      await p.waitForSelector('[data-setting="agents.personas"] .plist');
      await p.waitForTimeout(800);
      const top = await p.$eval("#den-content", (el) => el.scrollTop);
      expect({ e, top }).toEqual({ e, top: 0 });
      await p.context().close();
    },
    60_000,
  );

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
