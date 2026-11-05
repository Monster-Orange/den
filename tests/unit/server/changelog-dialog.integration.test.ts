/**
 * The "What's new" pop-up in a real browser: it always opens at the top
 * and collapsed (the scroll reset happens once the dialog is shown: made
 * while it is display:none it does not stick), and it is an accessible
 * modal dialog: labelled, focus moved into it on open, Tab kept inside,
 * and focus returned on close (to the version pill after a first-visit
 * auto-open).
 *
 * The real web server in a throwaway distribution, driven by Playwright's
 * headless Chromium.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { chromium, type Browser, type Page } from "playwright";
import {
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";

let tmp = "";
let srv: SlowGitServer;
let browser: Browser;
let page: Page;

const activeId = () => page.evaluate(() => document.activeElement?.id ?? "");
const focusInDialog = () =>
  page.evaluate(
    () =>
      !!document.activeElement?.closest("#cl-overlay .cl-box") &&
      document.activeElement !== document.body,
  );
const isOpen = () =>
  page.evaluate(
    () => !!document.getElementById("cl-overlay")?.classList.contains("open"),
  );
const bodyScrollTop = () =>
  page.evaluate(() => document.getElementById("cl-body")?.scrollTop ?? -1);

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-cl-dialog-"));
  const root = path.join(tmp, "den");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  srv = await startSlowGitServer({ tmp, root, slow: [], delayS: 0 });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 700 } });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await srv?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("What's new dialog", () => {
  it("first visit: opens as a labelled modal, focus inside, Tab trapped", async () => {
    await page.goto(`http://127.0.0.1:${srv.port}/`);
    await page.waitForFunction(
      () => !!document.getElementById("cl-overlay")?.classList.contains("open"),
      undefined,
      { timeout: 30_000 },
    );
    const box = page.locator("#cl-overlay .cl-box");
    expect(await box.getAttribute("role")).toBe("dialog");
    expect(await box.getAttribute("aria-modal")).toBe("true");
    const labelledBy = await box.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(
      await page.locator(`#${labelledBy}`).evaluate((el) => el.tagName),
    ).toBe("H3");
    // Earlier versions exist, so the toggle is there and takes focus.
    expect(await activeId()).toBe("cl-more");
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
      expect(await focusInDialog()).toBe(true);
    }
  }, 60_000);

  it("scrolled and expanded, then closed: focus returns to the pill", async () => {
    await page.click("#cl-more");
    expect(await page.textContent("#cl-more")).toBe("Show latest only");
    await page.evaluate(() => {
      const b = document.getElementById("cl-body");
      if (b) b.scrollTop = b.scrollHeight;
    });
    expect(await bodyScrollTop()).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    expect(await isOpen()).toBe(false);
    // The auto-open had nothing focused before it: back to the pill.
    expect(await activeId()).toBe("version-pill");
  }, 60_000);

  it("reopened: at the top, collapsed, focus inside; Got it returns focus", async () => {
    await page.click("#version-pill");
    expect(await isOpen()).toBe(true);
    expect(await bodyScrollTop()).toBe(0);
    expect(await page.textContent("#cl-more")).toMatch(
      /^Show all versions \(\d+ earlier\)$/,
    );
    expect(await activeId()).toBe("cl-more");
    await page.click("#cl-got-it-btn");
    expect(await isOpen()).toBe(false);
    expect(await activeId()).toBe("version-pill");
  }, 60_000);
});
