/**
 * 0.4.45: the rail lights Terminal or Agents by the pane in front, not by
 * the address. /agents?terminal=1 opens a shell and then drops terminal=1
 * from the address (it is used once), so the rail fell back to Agents
 * while a shell was in front, and a reload kept it so. Now: a shell in
 * front → Terminal; an agent, or nothing → Agents. And Terminal sits
 * below the server agent in the rail.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY: nothing really runs. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

async function open(next: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, next));
  return p;
}

/** The rail item lit (aria-current="page"), once it settles on `want`. */
async function lit(p: Page, want: string): Promise<string> {
  try {
    await p.waitForSelector(
      `.den-ni[data-nav="${want}"][aria-current="page"]`,
      {
        timeout: 5000,
      },
    );
  } catch {
    /* report what is lit instead */
  }
  return p.$$eval('.den-ni[aria-current="page"]', (xs) =>
    xs.map((x) => (x as HTMLElement).dataset.nav ?? "").join(","),
  );
}

describe("the rail follows the pane in front", () => {
  it("a shell in front lights Terminal, after the address drops terminal=1 and after a reload", async () => {
    if (!browser) return;
    const p = await open("/agents?terminal=1&ws=north");
    await p.waitForSelector(
      '#agl button.agr[data-kind]:not([data-kind="agent"])',
    );
    await p.waitForFunction(() => !/terminal=1/.test(location.search));
    expect(await lit(p, "terminal")).toBe("terminal");
    await p.reload();
    await p.waitForSelector(
      '#agl button.agr[data-kind]:not([data-kind="agent"])',
    );
    expect(await lit(p, "terminal")).toBe("terminal");
    await p.context().close();
  }, 60_000);

  it("no pane in front lights Agents", async () => {
    if (!browser) return;
    const p = await open("/agents?ws=south&open=&layout=focus");
    await p.waitForSelector("#agl:not([aria-busy])");
    expect(await lit(p, "agents")).toBe("agents");
    await p.context().close();
  }, 60_000);

  it("Terminal sits below the server agent", async () => {
    if (!browser) return;
    const p = await open("/agents?ws=south");
    await p.waitForSelector('.den-ni[data-nav="terminal"]');
    const order = await p.$$eval(".den-ni[data-nav]", (xs) =>
      xs.map((x) => (x as HTMLElement).dataset.nav),
    );
    expect(order.indexOf("terminal")).toBe(order.indexOf("server-agent") + 1);
    await p.context().close();
  }, 60_000);
});
