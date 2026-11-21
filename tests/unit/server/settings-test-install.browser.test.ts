/**
 * Issue 823: Settings › Access › Test install in the page.
 *  - Not a test install: the row names the missing condition and what to
 *    do (the launcher's flag as the server names it), with no button.
 *  - Set up: the state plainly, no Set up test person; a secondary Set up
 *    again asks first, in the kit's dialog with Report, saying it makes a
 *    new key and ends every current test-person sign-in. Cancel sends
 *    nothing; Set up again goes through the working pop-up.
 *
 * The test-install answers (src/shared/fixture-person.ts) are faked at the
 * page's network (GET and POST /api/web/fixture-person), so nothing is
 * written. Chromium and WebKit;
 * DEN_PW_WS connects to a Playwright server instead of launching. The demo
 * distribution (helpers/agents-page-server.ts). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { shortDots } from "./helpers/short-dots.js";
import { launchBrowser } from "../helpers/browser.js";

jest.setTimeout(60_000);

const ENGINES = ["chromium", "webkit"] as const;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

async function open(
  e: (typeof ENGINES)[number],
  read: Record<string, unknown>,
): Promise<{ p: Page; posts: number[] }> {
  const ctx = await browsers[e]!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  const posts: number[] = [];
  await p.route("**/api/web/fixture-person", async (r) => {
    if (r.request().method() !== "POST") return r.fulfill({ json: read });
    posts.push(Date.now());
    // Slow enough that the working pop-up opens (the kit's OPEN_MS).
    await new Promise((ok) => setTimeout(ok, 1500));
    await r.fulfill({ json: { ok: true, testInstall: true, ready: true } });
  });
  await p.goto(`${s!.base}/settings#access`);
  await p.locator("#set-test-install").waitFor({ timeout: 20_000 });
  return { p, posts };
}

describe.each(ENGINES)("issue 823 in %s: the Test install row", (e) => {
  it("not a test install: names the launcher's flag as the server sends it, no button", async () => {
    if (!browsers[e] || !s) return;
    const { p } = await open(e, {
      ok: true,
      testInstall: false,
      ready: false,
      why: "no_launch_flag",
      launchFlag: "ACME_TEST_INSTALL",
    });
    const row = p.locator("#set-test-install");
    expect(await row.getAttribute("data-why")).toBe("no_launch_flag");
    expect(await row.textContent()).toContain("ACME_TEST_INSTALL=1");
    expect(await p.locator("#set-test-person").count()).toBe(0);
    expect(await p.locator("#set-test-person-again").count()).toBe(0);
    await p.context().close();
  });

  it("set up: no Set up test person; Set up again asks first (with Report), then the working pop-up", async () => {
    if (!browsers[e] || !s) return;
    const { p, posts } = await open(e, {
      ok: true,
      testInstall: true,
      ready: true,
    });
    expect(await p.locator("#set-test-install").textContent()).toBe(
      "This is a test install. The test person is set up.",
    );
    expect(await p.locator("#set-test-person").count()).toBe(0);
    const again = p.locator("#set-test-person-again");
    expect(await again.textContent()).toBe("Set up again");

    // Cancel: nothing is sent.
    await again.click();
    const ask = p.locator(".dk-dlg[open]");
    await ask.waitFor({ timeout: 5000 });
    const says = (await ask.textContent()) ?? "";
    expect(says).toMatch(/new key/);
    expect(says).toMatch(/every current test-person sign-in ends/i);
    await ask.locator("[data-den-report]").first().waitFor({ timeout: 5000 });
    await ask.locator('[data-dk="cancel"]').click();
    await ask.waitFor({ state: "detached", timeout: 5000 });
    expect(posts.length).toBe(0);

    // Set up again: the working pop-up, then the row as before.
    await shortDots(p);
    await again.click();
    await p.locator(".dk-dlg[open]").waitFor({ timeout: 5000 });
    await p.locator('.dk-dlg[open] [data-dk="ok"]').click();
    const busy = p.locator("dialog.bz-dlg[open]");
    await busy.waitFor({ timeout: 5000 });
    expect(await busy.locator("h2").textContent()).toContain(
      "Setting up the test person",
    );
    await busy.waitFor({ state: "detached", timeout: 15_000 });
    expect(posts.length).toBe(1);
    expect(
      await p.locator("#set-test-install").getAttribute("data-ready"),
    ).toBe("yes");
    expect(await p.locator("#set-test-person").count()).toBe(0);
    await p.context().close();
  });
});
