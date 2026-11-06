/**
 * The error frame in a real browser (R26, MD-2, 0.3.0-dev.38), against the
 * real server (helpers/error-frame-server.ts):
 *
 *   - /nope: the shell frame (top bar, rail), the 404 copy, a suggestion
 *     from the palette's matcher, the list of pages
 *   - a route forced to throw: the 500 page, its request id the one on the
 *     server's log line, Retry and Copy details, no stack
 *   - a failed action no page catches: a toast with the message, the
 *     request id, Retry and Copy details
 *   - the engine on disk bumped: the restart banner leads the page
 *   - the server stopped mid-session: "Den's server isn't responding —
 *     retrying" shows and the status chip reads unknown; the banner clears
 *     itself once the server is back
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
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
  s = await startFrameServer({ prefix: "den-frame-ui-" });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
  removeFrameTmp(s);
});

async function open(p: string): Promise<Page> {
  const page = await browser!.newPage();
  await page.goto(`${s!.base}${p}`);
  await page.waitForSelector(".den-top");
  return page;
}

const skip = () => !browser;

describe("the error pages", () => {
  it("/nope: the frame, the 404 copy and a suggestion", async () => {
    if (skip()) return;
    const page = await open("/nope");
    await page.waitForSelector("#den-error-page h1");
    expect(await page.locator(".den-rail").count()).toBe(1);
    expect(await page.locator("#den-status").count()).toBe(1);
    expect(await page.textContent("#den-error-page h1")).toBe("Page not found");
    expect(await page.textContent("#den-error-page .sub")).toContain("/nope");
    const mean = page.locator(".den-err-mean a");
    expect(await mean.count()).toBe(1);
    expect(await mean.getAttribute("href")).toMatch(/^\//);
    // Workspaces, ⌘K and the pages.
    expect(
      await page.locator('#den-error-page a[href="/local-dev"]').count(),
    ).toBeGreaterThan(0);
    expect(await page.locator("#den-err-search").count()).toBe(1);
    expect(await page.locator("ul.pages li").count()).toBeGreaterThan(5);
    await page.close();
  });

  it("a near-miss suggests the page it misses", async () => {
    if (skip()) return;
    const page = await open("/servics");
    await page.waitForSelector(".den-err-mean a");
    expect(await page.textContent(".den-err-mean a")).toBe("Services");
    await page.close();
  });

  it("a route that throws: the 500 page with the log's request id", async () => {
    if (skip()) return;
    const page = await open("/_den/throw");
    await page.waitForSelector("#den-err-id");
    expect(await page.textContent("#den-error-page h1")).toBe(
      "Something went wrong",
    );
    const id = (await page.textContent("#den-err-id"))!.trim();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(s!.log()).toContain(`failed (req ${id})`);
    expect(await page.locator("#den-err-retry").count()).toBe(1);
    expect(await page.locator("#den-err-copy").count()).toBe(1);
    expect(await page.content()).not.toContain("debug route threw");
    await page.close();
  });
});

describe("a failed action", () => {
  it("no page catches it: a toast with the message, request id, Retry and Copy", async () => {
    if (skip()) return;
    const page = await open("/settings");
    await page.evaluate(() => {
      // As a page's click handler would: no catch.
      void (
        window as unknown as {
          denShell: {
            api: (m: string, u: string, b: unknown) => Promise<unknown>;
          };
        }
      ).denShell.api("POST", "/api/scope", { scope: 42 });
    });
    const toast = page.locator(".den-toast-err");
    await toast.waitFor();
    expect(await toast.getAttribute("role")).toBe("alert");
    expect(await toast.locator(".den-te-id").textContent()).toMatch(
      /^Request [0-9a-f]{8}$/,
    );
    expect(await toast.locator('[data-te="retry"]').count()).toBe(1);
    expect(await toast.locator('[data-te="copy"]').count()).toBe(1);
    await page.close();
  });
});

describe("the stale engine and the unreachable server", () => {
  it("a newer engine on disk: the restart banner leads the page", async () => {
    if (skip()) return;
    s!.bumpEngine("9.9.9-test.2");
    await new Promise((r) => setTimeout(r, 3_300));
    const page = await open("/settings");
    const banner = page.locator('[data-banner="engine"]');
    await banner.waitFor();
    expect(await banner.textContent()).toContain(
      "Den was updated to 9.9.9-test.2. This server is still running",
    );
    expect(await banner.textContent()).toContain("den web restart");
    // It leads the content.
    expect(
      await page.evaluate(
        () => document.getElementById("den-content")!.firstElementChild!.id,
      ),
    ).toBe("den-banners");
    await page.close();
  }, 20_000);

  it("the server stops: the banner and an unknown chip; it clears on restart", async () => {
    if (skip()) return;
    const page = await open("/settings");
    await s!.stop();
    // Any call the page makes now fails at the network level.
    await page.evaluate(() => fetch("/api/settings").catch(() => null));
    const banner = page.locator('[data-banner="net"]');
    await banner.waitFor();
    expect(await banner.textContent()).toContain(
      "Den's server isn't responding — retrying",
    );
    expect(await page.textContent("#den-status")).toContain("Status unknown");
    await s!.start();
    await banner.waitFor({ state: "detached", timeout: 20_000 });
    expect(await page.textContent("#den-status")).not.toContain(
      "Status unknown",
    );
    await page.close();
  }, 60_000);
});
