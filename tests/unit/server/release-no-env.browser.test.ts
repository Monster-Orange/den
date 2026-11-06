/**
 * The Release page with no deploy environment (environments: [local] only,
 * the default distribution): it asks /api/release/status only for an env
 * it has, never `env=undefined` (which answered 400 "Unknown env:
 * undefined" since 0.3.0-dev.42), and says there is nothing to check.
 *
 * The real server (helpers/error-frame-server.ts). Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser } from "playwright";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";

let s: FrameServer | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startFrameServer({ prefix: "den-rel-noenv-" });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
  removeFrameTmp(s);
});

describe("the Release page with environments: [local] only", () => {
  it("never requests status for env=undefined, and gets no 400", async () => {
    if (!browser) return;
    const page = await browser.newPage();
    const asked: string[] = [];
    const bad: string[] = [];
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.pathname === "/api/release/status") asked.push(u.search);
      if (u.pathname.startsWith("/api/") && r.status() === 400)
        bad.push(u.pathname + u.search);
    });
    await page.goto(`${s!.base}/release`);
    await page.waitForSelector(".den-top");
    await page.waitForTimeout(1_500);
    expect(asked.filter((q) => /env=(undefined|null|)(&|$)/.test(q))).toEqual(
      [],
    );
    expect(bad).toEqual([]);
    await page.close();
  }, 60_000);
});
