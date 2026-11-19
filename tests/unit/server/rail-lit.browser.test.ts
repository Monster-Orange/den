/**
 * 0.4.45: the rail lights Terminal or Agents by the pane in front, not by
 * the address. /agents?terminal=1 opens a shell and then drops terminal=1
 * from the address (it is used once), so the rail fell back to Agents
 * while a shell was in front, and a reload kept it so. Now: a shell in
 * front → Terminal; an agent, or nothing → Agents. And Terminal sits
 * below the server agent in the rail.
 *
 * Issue 482: Terminals is a page of its own (/terminals), so each page
 * lights its own item, never both: Terminals on /terminals, Agents on
 * /agents, whatever runs.
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
import { closeBrowserSuite } from "../../browser-teardown.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = process.env.DEN_PW_WS
      ? await chromium.connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
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
  it("Terminals lights Terminal, after the address drops terminal=1 and after a reload", async () => {
    if (!browser) return;
    // Issue 482: the old link lands on /terminals.
    const p = await open("/agents?terminal=1&ws=north");
    await p.waitForURL(/\/terminals/);
    await p.waitForSelector("#agl .tmr button.agr[data-id]");
    await p.waitForFunction(() => !/terminal=1/.test(location.search));
    expect(await lit(p, "terminal")).toBe("terminal");
    await p.reload();
    await p.waitForSelector("#agl .tmr button.agr[data-id]");
    expect(await lit(p, "terminal")).toBe("terminal");
    await p.context().close();
  }, 60_000);

  it("issue 482: Agents lights Agents, even with a shell running", async () => {
    if (!browser) return;
    // north runs a shell (the test above); Agents never lists it.
    const p = await open("/agents?ws=north&layout=focus");
    await p.waitForSelector("#agl:not([aria-busy])");
    expect(await p.locator('#agl [data-kind="session"]').count()).toBe(0);
    expect(await lit(p, "agents")).toBe("agents");
    await p.context().close();
  }, 60_000);

  it("no pane in front lights Agents", async () => {
    if (!browser) return;
    const p = await open("/agents?ws=south&open=&layout=focus");
    await p.waitForSelector("#agl:not([aria-busy])");
    expect(await lit(p, "agents")).toBe("agents");
    await p.context().close();
  }, 60_000);

  it("0.4.45: Agents, then Terminal, then Services; the server agent is off the rail", async () => {
    if (!browser) return;
    const p = await open("/agents?ws=south");
    await p.waitForSelector('.den-ni[data-nav="terminal"]');
    const order = await p.$$eval(".den-ni[data-nav]", (xs) =>
      xs.map((x) => (x as HTMLElement).dataset.nav),
    );
    const at = (id: string) => order.indexOf(id);
    expect(at("server-agent")).toBe(-1);
    expect(at("terminal")).toBe(at("agents") + 1);
    expect(at("services")).toBe(at("terminal") + 1);
    await p.context().close();
  }, 60_000);
});
