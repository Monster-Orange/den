/**
 * The kit's action toast (shell.js toastAction, e.g. Undo): it stays while
 * the pointer or focus is on it, so an Undo is never pulled from under a
 * hand. When they leave, a full plain time (3 s) starts: the den-ui
 * toast's rule (the Agents page's Undo uses it too).
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

async function page(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 800 },
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
      8000,
    ),
  );
  // The kit puts a toast into its region a moment later (ANNOUNCE_MS),
  // so a screen reader hears it.
  await p.clock.runFor(100);
  await p.locator("[data-toast-msg]").waitFor();
  return p;
}

const toasts = (p: Page) => p.locator("[data-toast-msg]").count();

describe("the kit's action toast", () => {
  it("closes after its time when nobody touches it", async () => {
    if (!browser) return;
    const p = await page();
    await p.clock.runFor(7_000);
    expect(await toasts(p)).toBe(1);
    await p.clock.runFor(1_500);
    expect(await toasts(p)).toBe(0);
    await p.context().close();
  });

  it("the pointer on it holds it; it closes 3 s after the pointer leaves", async () => {
    if (!browser) return;
    const p = await page();
    await p.locator("[data-toast-words]").hover();
    await p.clock.runFor(15_000);
    expect(await toasts(p)).toBe(1);
    await p.mouse.move(0, 0);
    await p.clock.runFor(2_000);
    expect(await toasts(p)).toBe(1);
    await p.clock.runFor(1_500);
    expect(await toasts(p)).toBe(0);
    await p.context().close();
  });

  it("focus on its button holds it; it closes 3 s after focus leaves", async () => {
    if (!browser) return;
    const p = await page();
    await p.locator("[data-toast-undo]").focus();
    await p.clock.runFor(15_000);
    expect(await toasts(p)).toBe(1);
    await p.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await p.clock.runFor(2_000);
    expect(await toasts(p)).toBe(1);
    await p.clock.runFor(1_500);
    expect(await toasts(p)).toBe(0);
    await p.context().close();
  });
});
