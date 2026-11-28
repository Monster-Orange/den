import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

jest.setTimeout(60_000);

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

async function open(route: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    const st = document.createElement("style");
    st.textContent = "#cl-overlay{display:none!important}";
    document.addEventListener("DOMContentLoaded", () =>
      document.head.appendChild(st),
    );
  });
  await signInPage(p, s!.stateDir, s!.base, route);
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  return p;
}

const chosen = (p: Page, row: string) =>
  p.locator(`${row} [role="tab"][aria-selected="true"]`);
const focusedId = (p: Page) =>
  p.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id);
const tablistName = (p: Page, row: string) =>
  p.locator(`${row} [role="tablist"]`).getAttribute("aria-label");

describe("Den's tabs are the kit's (issue 1977)", () => {
  it("the graph's details: → moves, focus stays on the chosen tab, its panel shows", async () => {
    if (!browser) return;
    const p = await open("/graph?ws=north");
    await p.click('#den-content [role="group"][data-id]');
    const row = '[data-den-tabs="panel"]';
    await p.waitForSelector(row);
    expect(await tablistName(p, row)).toBeTruthy();
    const ids = await p
      .locator(`${row} [role="tab"]`)
      .evaluateAll((ts) => ts.map((t) => (t as HTMLElement).dataset.id));
    expect(ids.length).toBeGreaterThan(1);
    await chosen(p, row).focus();
    const from = await focusedId(p);
    await p.keyboard.press("ArrowRight");
    await p.waitForFunction(
      ([r, f]) =>
        (
          document.querySelector(
            `${r} [role="tab"][aria-selected="true"]`,
          ) as HTMLElement | null
        )?.dataset.id !== f,
      [row, from] as const,
    );
    const now = await chosen(p, row).getAttribute("data-id");
    expect(now).toBe(ids[(ids.indexOf(from) + 1) % ids.length]);
    expect(await focusedId(p)).toBe(now);
    expect(await p.locator(`#dg-pbody-${now}`).isVisible()).toBe(true);
    await p.keyboard.press("Home");
    await p.waitForFunction(
      ([r, f]) =>
        (
          document.querySelector(
            `${r} [role="tab"][aria-selected="true"]`,
          ) as HTMLElement | null
        )?.dataset.id === f,
      [row, ids[0]] as const,
    );
    expect(await focusedId(p)).toBe(ids[0]);
    await p.context().close();
  });

  it("My reports: → chooses the drafts tab and keeps focus on it", async () => {
    if (!browser) return;
    const p = await open("/agents");
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { myReports: () => Promise<unknown> } }
      ).denShell.myReports(),
    );
    const row = 'dialog[open] [data-den-tabs="panel"]';
    await p.waitForSelector(row);
    expect(await tablistName(p, row)).toBeTruthy();
    await p.locator(`${row} [role="tab"][data-id="mine"]`).focus();
    await p.keyboard.press("ArrowRight");
    await p.waitForSelector(
      `${row} [role="tab"][data-id="agents"][aria-selected="true"]`,
    );
    expect(await focusedId(p)).toBe("agents");
    expect(await p.locator("#fb-my-panel-agents").isVisible()).toBe(true);
    await p.context().close();
  });

  it("the server agent: → shows Coach and keeps it in the address", async () => {
    if (!browser) return;
    const p = await open("/server-agent");
    const row = '#sa-tabs [data-den-tabs="panel"]';
    await p.waitForSelector(row);
    expect(await tablistName(p, row)).toBeTruthy();
    await p.locator(`${row} [role="tab"][data-id="terminal"]`).focus();
    await p.keyboard.press("ArrowRight");
    await p.waitForSelector(
      `${row} [role="tab"][data-id="coach"][aria-selected="true"]`,
    );
    expect(await focusedId(p)).toBe("coach");
    expect(await p.locator("#sa-coach").isHidden()).toBe(false);
    expect(await p.locator("#sa-body").isHidden()).toBe(true);
    expect(new URL(p.url()).searchParams.get("tab")).toBe("coach");
    await p.context().close();
  });
});
