/**
 * The rail's Hub link (0.4.28, beside HUB-1.7's Connect): above Settings,
 * only once this install is connected.
 *
 *   - connected: "Hub", in this tab (D51: a plain link; ⌘- and
 *     middle-click give a new one) to the company's page on
 *     Hub, the company in its tooltip, and a count of what waits on the
 *     person (whoami's unread); none at 0;
 *   - a token Hub rejects, or a role it forbids: greyed, to Settings › Hub,
 *     saying why (issue 326: Den passes `off`, the kit words it);
 *   - not configured, no token, Hub unreachable, or a company URL that is
 *     neither https nor this machine: no link;
 *   - collapsed: icon only, its name and count still read out; ↑/↓ reach it;
 *   - at 375 (the drawer) nothing scrolls sideways; no page errors.
 *
 * GET /api/hub?rail=1 is answered from the test (the shell's look; it never
 * takes Connect's one-time result: agent-routes' test checks that).
 * The demo distribution (helpers/agents-page-server.ts). Needs Playwright's
 * chromium (DEN_HUB_RAIL_BROWSER=webkit: WebKit); DEN_SKIP_BROWSER_TESTS=1
 * skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const engine =
  process.env.DEN_HUB_RAIL_BROWSER === "webkit" ? "webkit" : "chromium";

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
    const pw = await import("playwright");
    // DEN_HUB_RAIL_BROWSER=webkit (Safari's engine) runs the same tests
    // there. DEN_PW_WS=ws://localhost:<port>/ uses a browser behind a
    // Playwright run-server; its localhost is this machine's.
    const ws = process.env.DEN_PW_WS;
    browser = ws
      ? await pw[engine].connect(ws, { exposeNetwork: "<loopback>" })
      : await pw[engine].launch();
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
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
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
  await signIn(ctx, s!.stateDir, s!.base);
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
  it("D51 connected: Hub in this tab (a plain link) to the company's page, its name in the tooltip, the unread count", async () => {
    if (!browser) return;
    const { p, errors } = await open(CONNECTED);
    const a = link(p);
    await a.waitFor({ timeout: 10_000 });
    expect(await a.getAttribute("href")).toBe(
      "https://hub.example.test/c/acme-co",
    );
    expect(await a.getAttribute("target")).toBeNull();
    // Issue 307: Den passes data (the company, kind "hub", the count);
    // the kit words the tooltip and name and draws the HUB tag.
    expect(await a.getAttribute("title")).toBe("Acme Co · Hub");
    expect((await a.locator(".den-lbl").textContent())?.trim()).toBe("Acme Co");
    expect(
      await a
        .locator('[data-nav-role="kind"]')
        .evaluate((e) => (e as HTMLElement).innerText.trim()),
    ).toBe("HUB");
    expect(await a.locator(".den-bdg").textContent()).toBe("3");
    expect(await a.getAttribute("aria-label")).toBe("Acme Co · Hub, 3 waiting");
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
      ["rejected", "reconnect in Settings"],
      ["forbidden", "ask an admin for access"],
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
      // Issue 326: Den passes `off` (data); the kit says why, in its own
      // words, in the tooltip and the name.
      expect([
        await a.getAttribute("title"),
        await a.getAttribute("aria-label"),
      ]).toEqual([`Hub, ${why}`, `Hub, ${why}`]);
      expect(await a.getAttribute("data-nav-off")).not.toBeNull();
      expect(await a.getAttribute("data-nav-host-text")).toBeNull();
      expect(
        Number(await a.evaluate((e) => getComputedStyle(e).opacity)),
      ).toBeLessThan(1);
      expect(errors).toEqual([]);
      await p.context().close();
    }
  }, 60_000);

  it("its spot: the bottom of the rail, directly above Settings, with no header (as Hub's own rail)", async () => {
    if (!browser) return;
    for (const answer of [
      CONNECTED,
      {
        configured: true,
        url: "https://hub.example.test",
        connected: false,
        state: "unreachable",
      },
    ]) {
      const { p } = await open(answer);
      await link(p).waitFor({ timeout: 10_000 });
      expect(
        await link(p).evaluate((a) => [
          a.previousElementSibling?.className,
          (a.nextElementSibling as HTMLElement | null)?.dataset.nav,
        ]),
      ).toEqual(["den-rail-grow", "settings"]);
      await p.context().close();
    }
  }, 60_000);

  it("not configured: no Hub in the rail", async () => {
    if (!browser) return;
    const { p } = await open({ configured: false });
    await p.locator('.den-rail [data-nav="settings"]').waitFor();
    expect(await link(p).count()).toBe(0);
    await p.context().close();
  }, 60_000);

  it("D49: configured but not connected is still there, greyed, to Settings › Hub, saying why", async () => {
    if (!browser) return;
    const base = {
      configured: true,
      url: "https://hub.example.test",
      connected: false,
    };
    for (const [answer, why] of [
      [{ ...base, state: "no_token" }, "connect in Settings"],
      [{ ...base, state: "unreachable" }, "can't be reached right now"],
      [{ ...base, state: "bad_config" }, "check Settings"],
      [{ ...base, state: "something_new" }, "can't be reached right now"],
      // Connected, but no address Den will open (neither its company's nor Hub's).
      [
        {
          ...CONNECTED,
          url: "http://hub.example.test",
          teamUrl: "javascript:alert(1)",
        },
        "check Settings",
      ],
    ] as const) {
      const { p, errors } = await open(answer);
      const a = link(p);
      await a.waitFor({ timeout: 10_000 });
      expect([answer, await a.getAttribute("href")]).toEqual([
        answer,
        "/settings#agents.hub",
      ]);
      expect(await a.getAttribute("class")).toContain("den-off");
      // Issue 326: the greyed link says why again, in the kit's words.
      const named = (answer as { team?: string }).team
        ? `${(answer as { team?: string }).team} · Hub`
        : "Hub";
      expect([
        answer,
        await a.getAttribute("title"),
        await a.getAttribute("aria-label"),
      ]).toEqual([answer, `${named}, ${why}`, `${named}, ${why}`]);
      expect(errors).toEqual([]);
      await p.context().close();
    }
  }, 120_000);

  it("D51: a click opens Hub in this tab; ⌘/Ctrl-click and middle-click in a new one", async () => {
    if (!browser) return;
    const { p, errors } = await open(CONNECTED);
    const ctx = p.context();
    // Hub, answered from here: the page the link goes to.
    await ctx.route("https://hub.example.test/**", (r) =>
      r.fulfill({ contentType: "text/html", body: "<title>Hub</title>Hub" }),
    );
    const a = link(p);
    await a.waitFor({ timeout: 10_000 });
    for (const how of ["mod", "middle"] as const) {
      const opened = ctx.waitForEvent("page");
      if (how === "mod")
        // The browser's own platform (DEN_PW_WS: a Linux browser).
        await a.click({ modifiers: ["ControlOrMeta"] });
      else await a.click({ button: "middle" });
      const tab = await opened;
      // WebKit under Playwright leaves a tab opened by a modifier or
      // middle click blank when its address is routed (a bare probe does
      // the same): there, the new tab opening is the check.
      if (engine !== "webkit")
        await tab.waitForURL("https://hub.example.test/c/acme-co");
      await tab.close();
      expect(p.url()).toContain("/overview");
    }
    expect(ctx.pages()).toHaveLength(1);
    await a.click();
    await p.waitForURL("https://hub.example.test/c/acme-co");
    expect(ctx.pages()).toHaveLength(1);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it("D51: ⌘K lists Hub first; Enter opens it in this tab, ⌘/Ctrl-Enter in a new one", async () => {
    if (!browser) return;
    const { p, errors } = await open(CONNECTED);
    const ctx = p.context();
    await ctx.route("https://hub.example.test/**", (r) =>
      r.fulfill({ contentType: "text/html", body: "<title>Hub</title>Hub" }),
    );
    await link(p).waitFor({ timeout: 10_000 });
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    const palette = async () => {
      await p.keyboard.press(`${mod}+k`);
      await p.locator("#den-pal-list li[data-i]").first().waitFor();
    };
    await palette();
    const first = p.locator("#den-pal-list li[data-i]").first();
    expect(await first.locator(".den-pal-l").textContent()).toBe("Hub");
    expect(await first.locator(".den-sub").textContent()).toBe("Acme Co");
    expect(await first.getAttribute("data-off")).toBeNull();
    // Typed: found by its name.
    await p.keyboard.type("hub");
    expect(
      await p
        .locator("#den-pal-list li[data-i]")
        .first()
        .locator(".den-pal-l")
        .textContent(),
    ).toBe("Hub");
    const opened = ctx.waitForEvent("page");
    await p.keyboard.press(`${mod}+Enter`);
    const tab = await opened;
    await tab.waitForURL("https://hub.example.test/c/acme-co");
    await tab.close();
    expect(p.url()).toContain("/overview");
    await palette();
    await p.keyboard.press("Enter");
    await p.waitForURL("https://hub.example.test/c/acme-co");
    expect(ctx.pages()).toHaveLength(1);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it("D51: ⌘K's Hub is greyed with why when it can't be opened, and goes to Settings › Hub", async () => {
    if (!browser) return;
    const { p, errors } = await open({
      configured: true,
      url: "https://hub.example.test",
      connected: false,
      state: "unreachable",
    });
    await link(p).waitFor({ timeout: 10_000 });
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await p.keyboard.press(`${mod}+k`);
    const first = p.locator("#den-pal-list li[data-i]").first();
    await first.waitFor();
    expect(await first.locator(".den-pal-l").textContent()).toBe("Hub");
    expect(await first.getAttribute("data-off")).toBe("");
    expect(await first.locator(".den-sub").textContent()).toBe(
      "Den can't reach Hub right now. See Settings › Hub.",
    );
    await p.keyboard.press("Enter");
    await p.waitForURL(/\/settings#agents\.hub$/);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("D51: with no Hub set up, ⌘K has no Hub", async () => {
    if (!browser) return;
    const { p } = await open({ configured: false });
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await p.keyboard.press(`${mod}+k`);
    await p.locator("#den-pal-list li[data-i]").first().waitFor();
    expect(
      await p
        .locator("#den-pal-list li .den-pal-l", { hasText: /^Hub$/ })
        .count(),
    ).toBe(0);
    await p.context().close();
  }, 60_000);

  it("D49: connected without a company page Den will open: Hub's own address", async () => {
    if (!browser) return;
    for (const teamUrl of [
      undefined,
      "javascript:alert(1)",
      "http://hub.example.test/c/acme-co",
    ]) {
      const { p } = await open({ ...CONNECTED, teamUrl });
      const a = link(p);
      await a.waitFor({ timeout: 10_000 });
      expect([teamUrl, await a.getAttribute("href")]).toEqual([
        teamUrl,
        "https://hub.example.test/",
      ]);
      expect(await a.getAttribute("target")).toBeNull();
      await p.context().close();
    }
  }, 90_000);

  it("D49: an http Hub on a .localhost name opens", async () => {
    if (!browser) return;
    const { p } = await open({
      ...CONNECTED,
      url: "http://hub.localhost",
      teamUrl: "http://hub.localhost/acme-co",
    });
    const a = link(p);
    await a.waitFor({ timeout: 10_000 });
    expect(await a.getAttribute("href")).toBe("http://hub.localhost/acme-co");
    await p.context().close();
  }, 60_000);

  it("collapsed: the icon only, its name and count still read out; ↑/↓ reach it", async () => {
    if (!browser) return;
    const { p, errors } = await open(CONNECTED, { collapsed: true });
    const a = link(p);
    await a.waitFor({ timeout: 10_000 });
    const box = await a.locator(".den-lbl").boundingBox();
    expect(box === null || box.width <= 1).toBe(true);
    expect(await a.getAttribute("aria-label")).toBe("Acme Co · Hub, 3 waiting");
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
