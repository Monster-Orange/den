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
 *   - the engine on disk bumped: the shared update pill offers the new
 *     version over the top bar (no banner in the page)
 *   - the server stopped mid-session: "Den's server isn't responding —
 *     retrying" shows and the status chip reads unknown; the banner clears
 *     itself once the server is back
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

let s: FrameServer | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startFrameServer({ prefix: "den-frame-ui-" });
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
    after: () => removeFrameTmp(s),
  });
});

async function open(p: string): Promise<Page> {
  const context = await browser!.newContext();
  await signIn(context, path.join(s!.tmp, "den-home"), s!.base);
  const page = await context.newPage();
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
    await page.context().close();
  });

  it("a 400 (/attest with no return of this Den's own) says why, not 'Something went wrong' (den#145)", async () => {
    if (skip()) return;
    const page = await open("/attest");
    await page.waitForSelector("#den-error-page h1");
    expect(await page.textContent("#den-error-page h1")).toBe(
      "Request refused",
    );
    expect(await page.textContent("#den-error-page .lead")).toContain(
      "isn't one of this Den's own",
    );
    await page.context().close();
  });

  it("a near-miss suggests the page it misses", async () => {
    if (skip()) return;
    const page = await open("/servics");
    await page.waitForSelector(".den-err-mean a");
    expect(await page.textContent(".den-err-mean a")).toBe("Services");
    await page.context().close();
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
    await page.context().close();
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
    const toast = page.locator('[data-den-toast] [data-kind="error"]');
    await toast.waitFor();
    expect(
      await page.locator('[data-den-toast="alert"]').getAttribute("role"),
    ).toBe("alert");
    expect(await toast.locator("[data-toast-detail]").textContent()).toMatch(
      /^Request [0-9a-f]{8}$/,
    );
    expect(await toast.getByRole("button", { name: "Retry" }).count()).toBe(1);
    expect(
      await toast.getByRole("button", { name: "Copy details" }).count(),
    ).toBe(1);
    expect(await toast.getByRole("button", { name: "Close" }).count()).toBe(1);
    await page.context().close();
  });
});

describe("the stale engine and the unreachable server", () => {
  it("a newer engine on disk: the update pill offers it over the bar", async () => {
    if (skip()) return;
    s!.bumpEngine("9.9.9-test.2");
    await new Promise((r) => setTimeout(r, 3_300));
    const page = await open("/settings");
    const pill = page.locator(".den-upd .upd-pill");
    await pill.waitFor();
    expect(await page.locator(".den-upd .upd-msg").textContent()).toBe(
      "A new version of Den is available.",
    );
    expect(await page.locator(".den-upd .upd-go").textContent()).toBe("Reload");
    expect(await page.locator('[data-banner="engine"]').count()).toBe(0);
    await page.context().close();
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
    await page.context().close();
  }, 60_000);
});
