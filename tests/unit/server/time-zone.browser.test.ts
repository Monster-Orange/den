/**
 * issue 206: date-times on Den's pages are in the person's own zone, never
 * UTC. In Chromium and WebKit (Safari's engine), a browser in Los Angeles:
 *
 *   - the Agents page's stopped row and the bell show a known UTC stamp
 *     as the Los Angeles date, with datetime= the ISO stamp and a title
 *     naming the zone;
 *   - Settings › Time zone set to Asia/Tokyo redraws them in Tokyo's,
 *     with no reload; the next page's first paint is in Tokyo's too;
 *   - no main page's text holds an ISO-8601 stamp, an ISO date or "UTC"
 *     (seeded data).
 *
 * The demo distribution (agents-page-server), invented names only.
 * DEN_PW_WS: Den's own Playwright server.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserType, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

// Three days ago at 05:30 UTC: the evening before in Los Angeles, the
// afternoon of that day in Tokyo, so the date shown names the zone.
const day = new Date();
day.setUTCHours(5, 30, 0, 0);
const AT = new Date(day.getTime() - 3 * 86_400_000).toISOString();
const dateIn = (zone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    month: "short",
    day: "numeric",
    ...(new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
    }).format(new Date(AT)) ===
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
    }).format(new Date())
      ? {}
      : { year: "numeric" }),
  }).format(new Date(AT));
const LA = dateIn("America/Los_Angeles");
const TOKYO = dateIn("Asia/Tokyo");

let s: AgentsPageServer | null = null;
let latest = "";
const browsers: Partial<Record<"chromium" | "webkit", Browser>> = {};
const errors: string[] = [];

async function connect(type: BrowserType): Promise<Browser> {
  return launchBrowser(type);
}

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    browsers.chromium = await connect(pw.chromium);
    // WebKit (Safari's engine) everywhere: CI installs it too (issue 220),
    // so a missing WebKit fails here rather than skipping.
    browsers.webkit = await connect(pw.webkit);
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
  s.seed({
    id: "tzbot",
    persona: "reviewer",
    workspace: "north",
    stoppedAt: AT,
  });
  new NotificationStore(s.stateDir, () => new Date(AT)).add({
    kind: "waiting",
    subject: "agent:tzbell",
    scope: "workspace/north",
    text: "Tzbell is waiting for you",
  });
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

async function open(
  b: Browser,
  route: string,
  zone = "America/Los_Angeles",
): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    timezoneId: zone,
    locale: "en-US",
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
  p.on("pageerror", (e) => errors.push(e.message));
  await signInPage(p, s!.stateDir, s!.base, route);
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  return p;
}

/** The bell's row for the seeded item, its panel open. */
async function bellTime(p: Page) {
  if (await p.isHidden("#den-bell-pop")) await p.click("#den-bell");
  await p.waitForSelector("#den-bell-pop:not([hidden])");
  const t = p
    .locator("#den-bell-pop .den-bell-row")
    .filter({ hasText: "Tzbell" })
    .first()
    .locator("time");
  await t.waitFor();
  return t;
}

for (const name of ["chromium", "webkit"] as const) {
  describe(`issue 206 in ${name}: the person's own zone`, () => {
    it("Agents page and bell: the Los Angeles date; Settings › Tokyo redraws in place", async () => {
      const b = browsers[name];
      if (!b) return;
      expect(LA).not.toBe(TOKYO);
      const p = await open(b, "/agents?ws=north");
      await p.waitForSelector("#agl:not([aria-busy]) .agr", {
        state: "attached",
        timeout: 20_000,
      });
      const when = p.locator('#agl .agst[data-agent="tzbot"] .when time');
      await when.waitFor({ state: "attached" });
      expect(await when.getAttribute("datetime")).toBe(AT);
      expect((await when.textContent())?.trim()).toBe(LA);
      expect(await when.getAttribute("title")).toMatch(/Pacific/);

      const bell = await bellTime(p);
      expect(await bell.getAttribute("datetime")).toBe(AT);
      expect((await bell.textContent())?.trim()).toBe(LA);
      expect(await bell.getAttribute("title")).toMatch(/Pacific/);

      // Settings › Time zone: Tokyo. No reload: the marker survives.
      await signInPage(p, s!.stateDir, s!.base, "/settings#appearance");
      await p.waitForFunction(
        () => !!(window as { denShell?: unknown }).denShell,
      );
      const pick = p.locator('[id^="setting-time"] select');
      await pick.waitFor();
      expect(await pick.inputValue()).toBe("");
      expect(await pick.locator("option").first().textContent()).toContain(
        "America/Los_Angeles",
      );
      const bell2 = await bellTime(p);
      expect((await bell2.textContent())?.trim()).toBe(LA);
      await p.evaluate(() => {
        (window as { tzMark?: number }).tzMark = 1;
      });
      try {
        await pick.selectOption("Asia/Tokyo");
        await p.waitForFunction(
          () => document.documentElement.dataset.denTz === "Asia/Tokyo",
        );
        await p.waitForFunction(
          (want) =>
            [...document.querySelectorAll("#den-bell-pop .den-bell-row")]
              .find((r) => r.textContent?.includes("Tzbell"))
              ?.querySelector("time")
              ?.getAttribute("title")
              ?.includes("Japan") === true &&
            [...document.querySelectorAll("#den-bell-pop .den-bell-row")]
              .find((r) => r.textContent?.includes("Tzbell"))
              ?.querySelector("time")
              ?.textContent?.trim() === want,
          TOKYO,
          { timeout: 10_000 },
        );
        expect(
          await p.evaluate(() => (window as { tzMark?: number }).tzMark),
        ).toBe(1);
        expect((await s!.settingsGet()).time_zone).toBe("Asia/Tokyo");

        // The next page's first paint: <html data-den-tz> from the server.
        const q = await open(b, "/agents?ws=north");
        expect(
          await q.evaluate(() =>
            document.documentElement.getAttribute("data-den-tz"),
          ),
        ).toBe("Asia/Tokyo");
        const w2 = q.locator('#agl .agst[data-agent="tzbot"] .when time');
        await w2.waitFor({ state: "attached", timeout: 20_000 });
        expect((await w2.textContent())?.trim()).toBe(TOKYO);
        expect(await w2.getAttribute("title")).toMatch(/Japan/);
        await q.context().close();
      } finally {
        await s!.settings({ time_zone: null });
      }
      await p.context().close();
    }, 120_000);
  });
}

describe("issue 206: no page shows a UTC stamp", () => {
  const PAGES = [
    "/",
    "/agents?ws=north",
    "/services",
    "/environments",
    "/release",
    "/logs",
    "/settings",
    "/server-agent",
    "/edge",
  ];
  it("main pages, seeded: no ISO-8601 stamp or UTC in the text", async () => {
    const b = browsers.chromium;
    if (!b) return;
    const found: string[] = [];
    for (const route of PAGES) {
      const p = await open(b, route);
      await p.waitForLoadState("networkidle").catch(() => undefined);
      // The bell's panel too: its times are on every page.
      await bellTime(p).catch(() => undefined);
      const text = await p.evaluate(() => {
        const out: string[] = [];
        const walk = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          // A <select>'s options are zone names to pick from, not stamps.
          if (n.parentElement?.closest("select, script, style, template"))
            continue;
          out.push(n.textContent ?? "");
        }
        return out.join("\n");
      });
      // An ISO stamp (or its bare UTC date: the bell's old fallback) is
      // for machines; a person reads "Nov 5, 9:30 PM".
      for (const m of text.matchAll(
        /\b\d{4}-\d\d-\d\d(?:T\d\d:\d\d)?\b|\bUTC\b/g,
      ))
        found.push(
          `${route}: …${text.slice(Math.max(0, m.index! - 40), m.index! + 40)}…`,
        );
      await p.context().close();
    }
    expect(found).toEqual([]);
  }, 300_000);
});
