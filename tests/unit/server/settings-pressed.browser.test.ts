/**
 * Settings: a segmented control's pressed button moves the moment its
 * value saves, with no reload (0.4.13). "Agents tab layout" and "Open
 * file links in" saved, but the page merged only a fixed list of the
 * reply's keys, so the old button stayed pressed until a reload.
 *
 * The demo distribution (helpers/agents-page-server.ts). Needs
 * Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
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
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function page(url: string): Promise<Page> {
  const ctx = await browser!.newContext({
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
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(url);
  return p;
}

const pressed = (p: Page, row: string) =>
  p.$$eval(`[data-setting="${row}"] .seg button[aria-pressed="true"]`, (bs) =>
    bs.map((b) => (b as HTMLElement).dataset.v),
  );

describe("Settings: the pressed button follows the save (0.4.13)", () => {
  it.each([
    ["agents.layout", "agents_layout", "focus", "tile"],
    ["editor.open", "editor_open", "none", "zed"],
  ])(
    "%s: a click moves aria-pressed at once, no reload",
    async (row, key, before, after) => {
      if (skip()) return;
      await s!.settings({ [key]: null });
      const p = await page(signInUrl(s!.stateDir, s!.base, "/settings"));
      await p.waitForSelector(`[data-setting="${row}"] .seg button`);
      expect(await pressed(p, row)).toEqual([before]);
      let navigated = false;
      p.on("framenavigated", (f) => {
        if (f === p.mainFrame()) navigated = true;
      });
      await p.click(`[data-setting="${row}"] .seg button[data-v="${after}"]`);
      await p.waitForSelector(`[data-setting="${row}"] .set-saved.ok`);
      expect(await pressed(p, row)).toEqual([after]);
      expect(navigated).toBe(false);
      await s!.settings({ [key]: null });
      await p.context().close();
    },
    60_000,
  );

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
