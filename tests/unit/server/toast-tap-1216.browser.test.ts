/**
 * Issue 1216: a toast's action buttons (Undo, Retry, Copy: `.den-tbtn`)
 * are hit by a 44×44 area on a touch phone, as the kit's buttons are
 * (button.css's coarse-pointer ::after), and their look stays the same.
 * At 390 px with touch: a point 21 px from the Undo button's middle, in
 * each direction, still lands on it; its drawn box is unchanged.
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

type Kit = {
  denShell?: {
    toastAction: (m: string, l: string, f: () => void, ms: number) => void;
  };
};

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({ fresh: true });
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

async function toastAt(width: number, touch: boolean): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 844 },
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.clock.install();
  await signInPage(p, s!.stateDir, s!.base, "/settings");
  await p.waitForFunction(
    () => !!(window as unknown as Kit).denShell?.toastAction,
  );
  await p.evaluate(() =>
    (window as unknown as Kit).denShell!.toastAction(
      "Dismissed.",
      "Undo",
      () => {},
      60_000,
    ),
  );
  await p.locator("[data-toast-btn]").waitFor();
  return p;
}

/** The button's drawn box, and whether points `d` px out still hit it. */
function probe(p: Page, d: number) {
  return p.evaluate((dd) => {
    const b = document.querySelector("[data-toast-btn]") as HTMLElement;
    const r = b.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = [
      [cx - dd, cy],
      [cx + dd, cy],
      [cx, cy - dd],
      [cx, cy + dd],
    ].map(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return !!el && (el === b || b.contains(el));
    });
    return { w: r.width, h: r.height, hits };
  }, d);
}

describe("issue 1216: a toast's action is a 44×44 tap on a phone", () => {
  it("at 390 with touch: 21 px from Undo's middle, every way, is Undo", async () => {
    if (!browser) return;
    const p = await toastAt(390, true);
    const r = await probe(p, 21);
    expect(r.hits).toEqual([true, true, true, true]);
    await p.context().close();
  });

  it("its look doesn't change: the same drawn box with and without touch", async () => {
    if (!browser) return;
    const touch = await toastAt(390, true);
    const mouse = await toastAt(390, false);
    const [a, b] = await Promise.all([probe(touch, 0), probe(mouse, 0)]);
    expect([a.w, a.h]).toEqual([b.w, b.h]);
    await Promise.all([touch.context().close(), mouse.context().close()]);
  });
});
