/**
 * Issue 144 GATE-SLOT: the Agents page's gate chip. It says who holds the
 * machine's test slot, until when, and how many wait; the holding agent's
 * row says it; a press opens the queue (a dialog, with Report), and End
 * early asks first (the kit's dialog), then POSTs /api/gate-slots/end with
 * the slot's id through the working pop-up (its request id). The slots
 * are answered in the page (the routes have their own tests): nothing
 * runs, nothing is ended. Invented names only. DEN_PW_WS uses Den's own
 * Playwright server; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";
import { seeWhatsNew } from "./helpers/whats-new-seen.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let sid = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
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
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
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

async function page(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: "reduce",
  });
  await seeWhatsNew(ctx, s!.base);
  return ctx.newPage();
}

describe("issue 144: the gate chip on Agents", () => {
  it("says who holds the machine, marks the agent's row, and ends a slot early after asking", async () => {
    if (!browser) return;
    const p = await page();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    let slots: unknown[] = [HOLDER, WAITER];
    const ended: { body: unknown; requestId?: string }[] = [];
    await p.route("**/api/gate-slots", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          settings: { cpuSlots: 2, overrunMarginMinutes: 15 },
          slots,
        }),
      }),
    );
    await p.route("**/api/gate-slots/end", async (route) => {
      ended.push({
        body: route.request().postDataJSON(),
        requestId: route.request().headers()["x-den-request-id"],
      });
      slots = [HOLDER];
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, slots }),
      });
    });
    await signInPage(p, s!.stateDir, s!.base, `/agents`);
    const chip = p.locator("#ag-gate");
    await chip.waitFor({ state: "visible", timeout: 20_000 });
    // The kit's time in the page (issue 668): the same text the chip draws.
    // A string, so the test's transform never rewrites the page's import().
    const at = await p.evaluate<string>(
      `import("/kit/time.js").then((m) => m.formatTime(${JSON.stringify(
        end.toISOString(),
      )}, { style: "time" }))`,
    );
    expect(await chip.textContent()).toBe(
      `Gate: browser tests · Acme · north · agent:scout · until ${at} · 1 waiting`,
    );
    // The holding agent's row says it.
    const tag = p.locator(`#agl .agr[data-id="${sid}"] [data-gate-tag]`);
    await tag.waitFor({ timeout: 10_000 });
    expect(await tag.textContent()).toBe("gate: browser tests");

    // What's new, on a first visit, lies over the page: closed.
    await p.evaluate(() =>
      (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
    );

    // The queue, with Report.
    await chip.click();
    const pop = p.locator('#ag-gate-pop[role="dialog"]');
    await pop.waitFor();
    expect(await pop.locator(".gate-li").count()).toBe(2);
    // Issue 898: a picker's 320px cap is not this pop-over's: it keeps
    // its own 420px.
    expect(
      await pop.evaluate((el) => Math.round(el.getBoundingClientRect().width)),
    ).toBe(420);
    await pop.locator("[data-den-report]").waitFor({ timeout: 5_000 });
    const waiter = pop.locator(`.gate-li[data-gate-id="${WAITER.id}"]`);
    expect(await waiter.locator(".gate-when").textContent()).toBe(
      `Waits to run unit tests, from about ${at}`,
    );

    // End early asks first; Cancel asks nothing of Den.
    await waiter.locator("[data-gate-end]").click();
    const ask = p.locator(".dk-dlg[open]");
    await ask.waitFor();
    expect(await ask.textContent()).toContain(
      "End the slot for unit suite? Its run is not stopped",
    );
    await ask.locator('[data-dk="cancel"]').click();
    await ask.waitFor({ state: "detached" }).catch(() => {});
    expect(await p.locator(".dk-dlg[open]").count()).toBe(0);
    expect(ended).toEqual([]);

    // End slot: one POST with the id, through the working pop-up (its
    // request id), and the queue repaints.
    await waiter.locator("[data-gate-end]").click();
    await p.locator('.dk-dlg[open] [data-dk="ok"]').click();
    await p.waitForFunction(
      () =>
        !/waiting/.test(document.querySelector("#ag-gate")?.textContent ?? ""),
    );
    expect(ended.map((e) => e.body)).toEqual([{ id: WAITER.id }]);
    expect(ended[0]!.requestId).toBeTruthy();
    const queue = p.locator("#ag-gate-pop .gate-li");
    await p.waitForFunction(
      () => document.querySelectorAll("#ag-gate-pop .gate-li").length === 1,
    );
    expect(await queue.count()).toBe(1);

    // Esc closes the queue; focus goes back to the chip.
    await p.locator("#ag-gate-pop [data-gate-end]").first().focus();
    await p.keyboard.press("Escape");
    expect(await p.locator("#ag-gate-pop").count()).toBe(0);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("ag-gate");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("issue 1263: the queue lists the throwaway containers removed after their run, as text, only when any", async () => {
    if (!browser) return;
    const p = await page();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    let removed: unknown[] = [
      {
        at: new Date().toISOString(),
        id: "s1",
        label: "<b>x</b>",
        count: 2,
        images: ["postgres:16"],
      },
    ];
    await p.route("**/api/gate-slots", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          settings: { cpuSlots: 2, overrunMarginMinutes: 15 },
          slots: [HOLDER],
          removed,
        }),
      }),
    );
    await signInPage(p, s!.stateDir, s!.base, `/agents`);
    const chip = p.locator("#ag-gate");
    await chip.waitFor({ state: "visible", timeout: 20_000 });
    await p
      .locator(`#agl [data-id="${sid}"] [data-gate-tag]`)
      .waitFor({ timeout: 10_000 });
    await p.evaluate(() =>
      (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
    );
    await chip.click();
    const pop = p.locator('#ag-gate-pop[role="dialog"]');
    await pop.waitFor();
    await expect(
      pop
        .getByRole("heading", {
          name: "Throwaway containers removed after their run",
        })
        .count(),
    ).resolves.toBe(1);
    const row = pop.locator("[data-gate-removed] li");
    expect(await row.count()).toBe(1);
    expect(await row.textContent()).toMatch(
      / · 2 containers of <b>x<\/b> \(postgres:16\)$/,
    );
    expect(await row.locator("b").count()).toBe(0);

    removed = [];
    await p.keyboard.press("Escape");
    await p.reload();
    await chip.waitFor({ state: "visible", timeout: 20_000 });
    await p
      .locator(`#agl [data-id="${sid}"] [data-gate-tag]`)
      .waitFor({ timeout: 10_000 });
    await p.evaluate(() =>
      (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
    );
    await chip.click();
    await pop.waitFor();
    expect(await pop.locator("[data-gate-id]").count()).toBe(1);
    expect(
      await pop
        .getByRole("heading", {
          name: "Throwaway containers removed after their run",
        })
        .count(),
    ).toBe(0);
    expect(await pop.locator("[data-gate-removed]").count()).toBe(0);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("no slot held or waited for: no chip", async () => {
    if (!browser) return;
    const p = await page();
    await p.route("**/api/gate-slots", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ settings: {}, slots: [] }),
      }),
    );
    await signInPage(p, s!.stateDir, s!.base, `/agents`);
    await p.locator(`#agl .agr[data-id="${sid}"]`).waitFor({ timeout: 20_000 });
    expect(await p.locator("#ag-gate").isHidden()).toBe(true);
    await p.context().close();
  }, 60_000);
});
