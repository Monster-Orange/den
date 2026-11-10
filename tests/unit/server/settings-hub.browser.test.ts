/**
 * HUB-1.5: Settings › Agents › Hub. With no hub.url the row isn't there at
 * all; set, it shows the URL, connected or not, the team and this
 * install's label, and a problem in words when it can't connect. Never
 * the token (GET /api/hub doesn't have it to give).
 *
 * The demo distribution (helpers/agents-page-server.ts), with /api/hub
 * answered by the test. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

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

const skip = () => !browser;

async function page(hub: unknown, width = 1440): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
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
  p.on("pageerror", (e) => errors.push(e.message));
  await p.route("**/api/hub", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify(hub) }),
  );
  const answered = p.waitForResponse((r) => r.url().endsWith("/api/hub"));
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await answered;
  await p.waitForSelector(`[data-setting="agents.retention"], .set-row`);
  return p;
}

const row = (p: Page) => p.$('[data-setting="agents.hub"]');
const shown = (p: Page) =>
  p.$eval(
    '[data-setting="agents.hub"]',
    (el) => !(el as HTMLElement).closest("[hidden]"),
  );

describe("Settings › Hub (HUB-1.5)", () => {
  it("no hub.url: no Hub row on the page", async () => {
    if (skip()) return;
    const p = await page({ configured: false });
    const r = await row(p);
    if (r) expect(await shown(p)).toBe(false);
    await p.context().close();
  }, 60_000);

  it("connected: the URL, Connected, the team and this install", async () => {
    if (skip()) return;
    const p = await page({
      configured: true,
      url: "https://hub.example.test",
      connected: true,
      team: "Acme",
      label: "north-box",
    });
    await p.waitForSelector('[data-hub-state="connected"]');
    expect(await shown(p)).toBe(true);
    const text = await p.$eval("[data-hub]", (el) => el.textContent ?? "");
    expect(text).toContain("https://hub.example.test");
    expect(text).toContain("Connected");
    expect(text).toContain("Acme");
    expect(text).toContain("north-box");
    await p.context().close();
  }, 60_000);

  it("not connected: says why, and fits at 375", async () => {
    if (skip()) return;
    const p = await page(
      {
        configured: true,
        url: "https://hub.example.test",
        connected: false,
        problem:
          "hub.token could not be read from this install's secrets store",
      },
      375,
    );
    await p.waitForSelector('[data-hub-state="down"]');
    expect(await p.$eval("[data-hub-problem]", (el) => el.textContent)).toMatch(
      /could not be read/,
    );
    const over = await p.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
