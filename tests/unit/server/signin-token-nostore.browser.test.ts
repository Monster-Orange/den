/**
 * Issue 163 (gate, 0.4.63-dev.1): Settings › Agents › Keep agents running
 * after logout › Sign-in token, on an install with no secrets store
 * (secrets.provider none). Before any paste the field says there is no
 * secrets store and Save is off; nothing is sent, and no 500 is ever
 * shown. The demo distribution (helpers/agents-page-server.ts).
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

jest.setTimeout(60_000);

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({ userYml: "secrets:\n  provider: none\n" });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

describe("no secrets store: the sign-in token field says so", () => {
  it("before any paste: the no-store words, Save and the field off, and nothing is sent", async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const st = document.createElement("style");
        st.textContent = "#cl-overlay{display:none!important}";
        document.head.appendChild(st);
      });
    });
    const posts: number[] = [];
    p.on("response", (r) => {
      if (r.url().endsWith("/api/agents/signin-token")) posts.push(r.status());
    });
    await p.goto(signInUrl(s!.stateDir, s!.base, "/settings#agents"));
    await p.waitForSelector("[data-keep-token-input]");
    const note = p.locator("[data-keep-token-note]");
    await expect(note.isVisible()).resolves.toBe(true);
    expect(await note.textContent()).toMatch(/no secrets store/i);
    expect(await p.locator("[data-keep-token-save]").isDisabled()).toBe(true);
    expect(await p.locator("[data-keep-token-input]").isDisabled()).toBe(true);
    expect(JSON.stringify(await s!.settingsGet())).toMatch(
      /"agent_signin":\{[^}]*"no_store":true/,
    );
    expect(posts).toEqual([]);
    await ctx.close();
  });
});
