/**
 * den#144 GATE-SLOT: the Agents page's gate chip. It says who holds the
 * machine's test slot and how many wait; the holding agent's row says it;
 * a press opens the queue (with Report), and End early asks first, then
 * POSTs /api/gate-slots/end with the slot's id through the working
 * pop-up. The slots are routed in the page (the routes have their own
 * tests). Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";

let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:scout",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  sid = info.ref.id;
  s.seed({
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:scout",
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const end = new Date(Date.now() + 20 * 60_000);
const HOLDER = {
  id: "browser-aaaa000001",
  kind: "browser",
  who: "Acme · north · agent:scout",
  label: "e2e suite",
  granted: true,
  agent: true,
  actor: "agent:scout",
  grantedAt: new Date().toISOString(),
  expectedEnd: end.toISOString(),
  overrun: false,
};
const WAITER = {
  id: "cpu-bbbb000002",
  kind: "cpu",
  who: "Acme · other-repo · a person",
  label: "unit suite",
  granted: false,
  agent: false,
  askedAt: new Date().toISOString(),
  expectedStart: end.toISOString(),
};

describe("den#144: the gate chip on Agents", () => {
  it("says who holds the machine, marks the agent's row, and ends a slot early after asking", async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 860 },
    });
    // What's new opens on a new version's first visit, over the page.
    await ctx.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () => {
        const st = document.createElement("style");
        st.textContent = "#cl-overlay{display:none!important}";
        document.head.appendChild(st);
      });
    });
    const p = await ctx.newPage();
    let slots: unknown[] = [HOLDER, WAITER];
    const ended: unknown[] = [];
    await p.route("**/api/gate-slots", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          settings: { cpuSlots: 2, leaseMinutes: 30, overrunMarginMinutes: 15 },
          slots,
        }),
      }),
    );
    await p.route("**/api/gate-slots/end", async (route) => {
      ended.push(route.request().postDataJSON());
      slots = [HOLDER];
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, slots }),
      });
    });
    await p.goto(signInUrl(s.stateDir, s.base, `/agents`));
    const chip = p.locator("#ag-gate");
    await chip.waitFor({ state: "visible", timeout: 20_000 });
    const at = await p.evaluate(
      (iso) =>
        new Date(iso).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      end.toISOString(),
    );
    expect(await chip.textContent()).toBe(
      `Gate: browser tests · Acme · north · agent:scout · until ${at} · 1 waiting`,
    );
    // The holding agent's row says it.
    await p
      .locator(`#agl .agr[data-id="${sid}"] [data-gate-tag]`)
      .waitFor({ timeout: 10_000 });
    expect(
      await p
        .locator(`#agl .agr[data-id="${sid}"] [data-gate-tag]`)
        .textContent(),
    ).toBe("gate: browser tests");

    // The queue, with Report.
    await chip.click();
    const pop = p.locator('#ag-gate-pop[role="dialog"]');
    await pop.waitFor();
    expect(await pop.locator(".gate-li").count()).toBe(2);
    await pop.locator("[data-den-report]").waitFor({ timeout: 5_000 });
    const waiter = pop.locator(`.gate-li[data-gate-id="${WAITER.id}"]`);
    expect(await waiter.locator(".gate-when").textContent()).toBe(
      `Waits to run unit tests, from about ${at}`,
    );

    // End early asks first; Cancel asks nothing of Den.
    await waiter.locator("[data-gate-end]").click();
    const ask = waiter.locator('[role="group"][data-gate-confirm]');
    expect(await ask.textContent()).toContain(
      "End the slot for unit suite? Its run is not stopped",
    );
    await ask.locator("[data-gate-cancel]").click();
    expect(await ask.count()).toBe(0);
    expect(ended).toEqual([]);

    // End slot: one POST with the id, through the working pop-up (a
    // quick answer closes it by itself), and the queue repaints.
    await waiter.locator("[data-gate-end]").click();
    await waiter.locator("[data-gate-go]").click();
    await p.waitForFunction(
      () =>
        !/waiting/.test(document.querySelector("#ag-gate")?.textContent ?? ""),
    );
    expect(ended).toEqual([{ id: WAITER.id }]);
    await pop.locator(".gate-li").first().waitFor();
    expect(await pop.locator(".gate-li").count()).toBe(1);

    // Esc closes the queue; focus goes back to the chip.
    await pop.locator("[data-gate-end]").first().focus();
    await p.keyboard.press("Escape");
    expect(await pop.count()).toBe(0);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("ag-gate");
    await ctx.close();
  }, 60_000);

  it("no slot held or waited for: no chip", async () => {
    if (!browser) return;
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.route("**/api/gate-slots", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ settings: {}, slots: [] }),
      }),
    );
    await p.goto(signInUrl(s.stateDir, s.base, `/agents`));
    await p.locator(`#agl .agr[data-id="${sid}"]`).waitFor({ timeout: 20_000 });
    expect(await p.locator("#ag-gate").isHidden()).toBe(true);
    await ctx.close();
  }, 60_000);
});
