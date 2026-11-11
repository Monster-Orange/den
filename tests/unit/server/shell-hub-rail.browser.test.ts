/**
 * The rail's Hub link (0.4.28, beside HUB-1.7's Connect): above Settings,
 * only once this install is connected.
 *
 *   - connected: "Hub ↗", a new tab (rel noopener) to the company's page on
 *     Hub, the company in its tooltip, and a count of what waits on the
 *     person (whoami's unread); none at 0;
 *   - a token Hub rejects, or a role it forbids: greyed, to Settings › Hub,
 *     saying why;
 *   - not configured, no token, Hub unreachable, or a company URL that is
 *     neither https nor this machine: no link;
 *   - collapsed: icon only, its name and count still read out; ↑/↓ reach it;
 *   - at 375 (the drawer) nothing scrolls sideways; no page errors.
 *
 * GET /api/hub?rail=1 is answered from the test (the shell's look; it never
 * takes Connect's one-time result: agent-routes' test checks that).
 * The demo distribution (helpers/agents-page-server.ts). Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";

const CONNECTED = {
  configured: true,
  url: "https://hub.example.test",
  connected: true,
  state: "connected",
  team: "Acme Co",
  teamUrl: "https://hub.example.test/c/acme-co",
  unread: 3,
};

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

/** /settings with the rail's /api/hub look answered by `answer`. */
async function open(
  answer: unknown,
  opts: { width?: number; collapsed?: boolean } = {},
): Promise<{ p: Page; errors: string[] }> {
  const ctx = await browser!.newContext({
    viewport: { width: opts.width ?? 1280, height: 900 },
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
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.route("**/api/hub?rail=1", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(answer),
    }),
  );
  const looked = p.waitForResponse((r) => r.url().endsWith("/api/hub?rail=1"));
  await p.goto(`${s!.base}/overview`);
  await looked;
  if (opts.collapsed)
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { setCollapsed(b: boolean): void } }
      ).denShell.setCollapsed(true),
    );
  // The answer is drawn on the next render.
  await p.waitForTimeout(150);
  return { p, errors };
}

const link = (p: Page) => p.locator('.den-rail [data-nav="hub"]');

describe("the rail's Hub link", () => {
  it("connected: Hub ↗ in a new tab to the company's page, its name in the tooltip, the unread count", async () => {
    if (!browser) return;
    const { p, errors } = await open(CONNECTED);
    const a = link(p);
    await a.waitFor({ timeout: 10_000 });
    expect(await a.getAttribute("href")).toBe(
      "https://hub.example.test/c/acme-co",
    );
    expect(await a.getAttribute("target")).toBe("_blank");
    expect(await a.getAttribute("rel")).toContain("noopener");
    expect(await a.getAttribute("title")).toBe(
      "Acme Co on Hub (opens in a new tab)",
    );
    expect((await a.locator(".den-lbl").textContent())?.trim()).toBe("Hub ↗");
    expect(await a.locator(".den-bdg").textContent()).toBe("3");
    expect(await a.getAttribute("aria-label")).toBe(
      "Hub, Acme Co on Hub (opens in a new tab), 3 waiting on you",
    );
    // Above Settings, in the footer.
    const order = await p.$$eval(".den-rail .den-ni", (els) =>
      els.map((e) => e.getAttribute("data-nav")),
    );
    expect(order.indexOf("hub")).toBe(order.indexOf("settings") - 1);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("nothing waiting: no count", async () => {
    if (!browser) return;
    const { p } = await open({ ...CONNECTED, unread: 0 });
    await link(p).waitFor({ timeout: 10_000 });
    expect(await link(p).locator(".den-bdg").count()).toBe(0);
    expect(await link(p).getAttribute("aria-label")).not.toContain("waiting");
    await p.context().close();
  }, 60_000);

  it("a token Hub rejects, or a role it forbids: greyed, to Settings › Hub, saying why", async () => {
    if (!browser) return;
    for (const [state, why] of [
      ["rejected", "Reconnect in Settings › Hub"],
      ["forbidden", "Ask a Hub admin"],
    ]) {
      const { p, errors } = await open({
        configured: true,
        url: "https://hub.example.test",
        connected: false,
        state,
      });
      const a = link(p);
      await a.waitFor({ timeout: 10_000 });
      expect(await a.getAttribute("href")).toBe("/settings#agents.hub");
      expect(await a.getAttribute("target")).toBeNull();
      expect(await a.getAttribute("class")).toContain("den-off");
      expect(await a.getAttribute("title")).toContain(why);
      expect(
        Number(await a.evaluate((e) => getComputedStyle(e).opacity)),
      ).toBeLessThan(1);
      expect(errors).toEqual([]);
      await p.context().close();
    }
  }, 60_000);

  it("no link: not configured, no token, unreachable, or a company URL that isn't https", async () => {
    if (!browser) return;
    for (const answer of [
      { configured: false },
      {
        configured: true,
        url: "https://hub.example.test",
        connected: false,
        state: "no_token",
      },
      {
        configured: true,
        url: "https://hub.example.test",
        connected: false,
        state: "unreachable",
      },
      { ...CONNECTED, teamUrl: "javascript:alert(1)" },
      { ...CONNECTED, teamUrl: "http://hub.example.test/c/acme-co" },
      { ...CONNECTED, teamUrl: undefined },
    ]) {
      const { p } = await open(answer);
      await p.locator('.den-rail [data-nav="settings"]').waitFor();
      expect([answer, await link(p).count()]).toEqual([answer, 0]);
      await p.context().close();
    }
  }, 90_000);

  it("collapsed: the icon only, its name and count still read out; ↑/↓ reach it", async () => {
    if (!browser) return;
    const { p, errors } = await open(CONNECTED, { collapsed: true });
    const a = link(p);
    await a.waitFor({ timeout: 10_000 });
    const box = await a.locator(".den-lbl").boundingBox();
    expect(box === null || box.width <= 1).toBe(true);
    expect(await a.getAttribute("aria-label")).toContain("3 waiting on you");
    // From Settings, ↑ moves to Hub.
    await p.locator('.den-rail [data-nav="settings"]').focus();
    await p.keyboard.press("ArrowUp");
    expect(
      await p.evaluate(() => document.activeElement?.getAttribute("data-nav")),
    ).toBe("hub");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("at 375 (the drawer): there, and nothing scrolls sideways", async () => {
    if (!browser) return;
    const { p, errors } = await open(CONNECTED, { width: 375 });
    expect(await link(p).count()).toBe(1);
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);
});
