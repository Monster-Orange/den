/**
 * Issue 393: Settings › Browser sign-in never gives a command to run. Not
 * signed in, the row says so and has a Sign in button; the button opens
 * Den's own sign-in page (GitHub, or a code another device approves), even
 * on loopback where nothing asks (`/signin?again=1`), with a way back to
 * Settings. Signed in, it has Sign out and no Sign in.
 *
 * Chromium and WebKit; DEN_PW_WS connects to a Playwright server instead
 * of launching. The demo distribution (helpers/agents-page-server.ts).
 * Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
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

async function open(e: (typeof ENGINES)[number]): Promise<Page> {
  const ctx = await browsers[e]!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
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
  return ctx.newPage();
}

describe.each(ENGINES)("issue 393 in %s: Browser sign-in", (e) => {
  it("not signed in: the row has a Sign in button, and it opens the sign-in page", async () => {
    if (!browsers[e] || !s) return;
    const p = await open(e);
    // Loopback: nothing asks for a sign-in, so this browser has none.
    await p.goto(`${s.base}/settings#cli`);
    const btn = p.locator("#set-signin");
    await btn.waitFor({ timeout: 20_000 });
    const row = btn.locator("xpath=..");
    const says = (await row.textContent()) ?? "";
    expect(says).toContain("Not signed in");
    expect(says).not.toMatch(/\brun\b|web login/i);
    expect(await btn.textContent()).toBe("Sign in");
    expect(await p.locator("#set-signout").count()).toBe(0);

    await btn.click();
    await p.waitForURL(/\/signin\?again=1&next=/, { timeout: 15_000 });
    expect(new URL(p.url()).searchParams.get("next")).toBe("/settings#cli");
    // Den's own sign-in page: GitHub, or a code another device approves.
    await p.waitForSelector("#den-signin", { timeout: 15_000 });
    await p.context().close();
  });

  it("signed in: Sign out, and no Sign in", async () => {
    if (!browsers[e] || !s) return;
    const p = await open(e);
    await p.goto(signInUrl(s.stateDir, s.base, "/settings#cli"));
    await p.locator("#set-signout").waitFor({ timeout: 20_000 });
    expect(await p.locator("#set-signin").count()).toBe(0);
    await p.context().close();
  });
});
