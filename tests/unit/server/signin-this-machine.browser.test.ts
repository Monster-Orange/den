/**
 * Sign-in on this machine too (0.4.71), in a browser on the real server
 * (helpers/error-frame-server.ts): the one-time link `web up` opens signs
 * the browser in, the page then changes things, and a reload keeps the
 * session. A browser on this machine that never opened one reads every
 * page, says so in one line with a Sign in button, and changes nothing.
 *
 * No code, cookie or token is printed. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";
import { signInUrl } from "./helpers/den-auth.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

let s: FrameServer | null = null;
let browser: Browser | null = null;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startFrameServer({ prefix: "den-signin-here-" });
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
    after: () => removeFrameTmp(s),
  });
});

/** A write through the page's own shell: "ok", or the refusal's status. */
function write(p: Page): Promise<string> {
  return p.evaluate(() =>
    (
      window as unknown as {
        denShell: { api(m: string, u: string, b: unknown): Promise<unknown> };
      }
    ).denShell
      .api("POST", "/api/notifications/read", {})
      .then(
        () => "ok",
        (e: { status?: number }) => String(e?.status),
      ),
  );
}

const signedIn = (p: Page) =>
  p.evaluate(() =>
    fetch("/api/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { signedIn?: boolean }) => b.signedIn === true),
  );

describe("sign-in on this machine too", () => {
  it("the one-time link signs the browser in; the page works; a reload keeps the session", async () => {
    if (!browser) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(
      signInUrl(path.join(s!.tmp, "den-home"), s!.base, "/settings"),
    );
    await page.waitForURL(`${s!.base}/settings`);
    await page.waitForFunction(() => "denShell" in window);
    expect(await signedIn(page)).toBe(true);
    expect(await write(page)).toBe("ok");
    expect(await page.locator('[data-banner="signin"]').count()).toBe(0);
    await page.reload();
    await page.waitForFunction(() => "denShell" in window);
    expect(await signedIn(page)).toBe(true);
    expect(await write(page)).toBe("ok");
    await context.close();
  }, 60_000);

  it("never signed in: the page reads, says so in one line with Sign in, and a write is refused", async () => {
    if (!browser) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    expect((await page.goto(`${s!.base}/settings`))?.status()).toBe(200);
    await page.waitForFunction(() => "denShell" in window);
    const line = page.locator('[data-banner="signin"]');
    await line.waitFor({ timeout: 15_000 });
    expect(await line.textContent()).toContain("Sign in to make changes here.");
    expect(await signedIn(page)).toBe(false);
    expect(await write(page)).toBe("401");
    await line.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/signin\?next=%2Fsettings/);
    expect(await page.textContent("#den-signin-where")).toContain(
      "runs on this computer",
    );
    await context.close();
  }, 60_000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
