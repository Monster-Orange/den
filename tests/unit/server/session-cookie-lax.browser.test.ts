/**
 * 0.4.45-dev.3: a browser signed in before the cookie became SameSite=Lax
 * still holds it as Strict, so a link from another site (a Hub sidebar)
 * arrives signed out until it signs in again. Den re-issues the session
 * cookie as Lax on the next signed-in request: the same session (the same
 * value), and its CSRF token keeps working.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

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
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

describe("the session cookie moves to Lax", () => {
  it("a Strict cookie already present comes back as Lax after one request, the same session", async () => {
    if (!browser) return;
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
    const session = (await ctx.cookies()).find((c) =>
      c.name.startsWith("den_session_"),
    )!;
    expect(session).toBeTruthy();
    // As a dev.2 browser holds it: the same value, SameSite=Strict.
    await ctx.clearCookies();
    await ctx.addCookies([{ ...session, sameSite: "Strict" }]);
    expect(
      (await ctx.cookies()).find((c) => c.name === session.name)?.sameSite,
    ).toBe("Strict");
    await p.goto(`${s!.base}/settings`);
    await p.waitForFunction(
      () => !!(window as { denShell?: unknown }).denShell,
    );
    const after = (await ctx.cookies()).find((c) => c.name === session.name)!;
    expect(after.sameSite).toBe("Lax");
    expect(after.value).toBe(session.value);
    expect(after.httpOnly).toBe(true);
    // Still signed in, and a write (its CSRF) still works.
    const r = await p.evaluate(async () => {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return res.status;
    });
    expect(r).toBeLessThan(400);
  }, 60_000);
});
