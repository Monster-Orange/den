import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { seeWhatsNew } from "./helpers/whats-new-seen.js";
import { launchBrowser } from "../helpers/browser.js";
import { ISSUE_WRITE_DEFAULT_ROLES } from "../../../src/shared/issue-write.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser || !s;
const ROW = '[data-setting="agents.issue_writes"]';
const BOX = `${ROW} input[data-den-check]`;

async function context(width = 1280): Promise<BrowserContext> {
  const ctx = await browser!.newContext({
    viewport: { width, height: width > 500 ? 900 : 844 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  await seeWhatsNew(ctx, s!.base);
  return ctx;
}

async function open(ctx: BrowserContext): Promise<Page> {
  const p = await ctx.newPage();
  await p.goto(`${s!.base}/settings?q=github%20issues`);
  await p.waitForSelector(`${ROW} fieldset`, { timeout: 20_000 });
  await p.locator(ROW).scrollIntoViewIfNeeded();
  return p;
}

const ticked = (p: Page) =>
  p
    .locator(`${BOX}:checked`)
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const values = (p: Page) =>
  p
    .locator(BOX)
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const stored = async (p: Page) =>
  (
    (await (await p.request.get(`${s!.base}/api/settings`)).json()) as {
      agent_issue_writes?: { roles?: string[] };
    }
  ).agent_issue_writes?.roles;
const saved = (p: Page) =>
  p.waitForSelector(`${ROW} [role="status"][data-state="saved"]`, {
    timeout: 8_000,
  });

describe("who writes GitHub issues, on the Settings page", () => {
  it("has a named box per job, with the jobs in effect ticked", async () => {
    if (skip()) return;
    const ctx = await context();
    const p = await open(ctx);
    const vals = await values(p);
    expect(vals.length).toBeGreaterThan(0);
    expect(await ticked(p)).toEqual(
      vals.filter((v) => ISSUE_WRITE_DEFAULT_ROLES.includes(v)),
    );
    for (const v of vals) {
      const name = await p
        .locator(`${BOX}[value="${v}"]`)
        .evaluate(
          (b) =>
            document.getElementById(b.getAttribute("aria-labelledby") ?? "")
              ?.textContent ?? "",
        );
      expect(name.trim()).not.toBe("");
      expect(name).not.toBe(v);
    }
    await ctx.close();
  });

  it("shows no job id, setting key or command line", async () => {
    if (skip()) return;
    const ctx = await context();
    const p = await open(ctx);
    const text = await p.locator(ROW).innerText();
    expect(text).not.toMatch(/agents\.issue_writes|__DEN_/);
    for (const v of await values(p))
      expect([v, new RegExp(`\\b${v}\\b`).test(text)]).toEqual([v, false]);
    await ctx.close();
  });

  it("a tick saves the list, keeps saved roles with no box, and survives a reload", async () => {
    if (skip()) return;
    const ctx = await context();
    const p = await open(ctx);
    const vals = await values(p);
    const hidden = ISSUE_WRITE_DEFAULT_ROLES.filter((r) => !vals.includes(r));
    expect(hidden.length).toBeGreaterThan(0);
    const off = vals.find((v) => !ISSUE_WRITE_DEFAULT_ROLES.includes(v))!;
    await p.locator(`${BOX}[value="${off}"]`).click();
    await saved(p);
    const roles = await stored(p);
    expect(roles).toEqual(expect.arrayContaining([off, ...hidden]));
    await p.reload();
    await p.waitForSelector(`${ROW} fieldset`);
    expect(await ticked(p)).toContain(off);
    await ctx.close();
  });

  it("Tab moves box to box and Space ticks and saves", async () => {
    if (skip()) return;
    const ctx = await context();
    const p = await open(ctx);
    const vals = await values(p);
    await p.locator(`${BOX}[value="${vals[0]}"]`).focus();
    await p.keyboard.press("Tab");
    expect(
      await p.evaluate(
        () => (document.activeElement as HTMLInputElement).value,
      ),
    ).toBe(vals[1]);
    const was = await p.locator(`${BOX}[value="${vals[1]}"]`).isChecked();
    await p.keyboard.press("Space");
    await saved(p);
    expect((await stored(p))?.includes(vals[1])).toBe(!was);
    await ctx.close();
  });

  it("a refused save puts the box back and says so on the row", async () => {
    if (skip()) return;
    const ctx = await context();
    const p = await open(ctx);
    const before = await stored(p);
    await p.route("**/api/settings", (r) =>
      r.request().method() === "POST"
        ? r.fulfill({
            status: 422,
            contentType: "application/json",
            body: JSON.stringify({ ok: false, error: "x", code: "bad_value" }),
          })
        : r.continue(),
    );
    const [v] = await values(p);
    const was = await p.locator(`${BOX}[value="${v}"]`).isChecked();
    await p.locator(`${BOX}[value="${v}"]`).click();
    await p.waitForSelector(`${ROW} [role="status"][data-state="error"]`, {
      timeout: 8_000,
    });
    expect(await p.locator(`${BOX}[value="${v}"]`).isChecked()).toBe(was);
    await p.unroute("**/api/settings");
    expect(await stored(p)).toEqual(before);
    await ctx.close();
  });

  it("at 390 every row is a 44px target, with no sideways scroll", async () => {
    if (skip()) return;
    const ctx = await context(390);
    const p = await open(ctx);
    const heights = await p
      .locator(`${ROW} fieldset label`)
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    expect(
      await p.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await ctx.close();
  });
});
