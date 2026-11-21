/**
 * BUSY-1: the working pop-up (UK-2: the kit's busy.js, through Den's
 * actions in busy-den.js), the spec's tests against a stubbed
 * route so the timings are the test's: it opens only for a slow answer, has
 * no buttons while working, ignores Esc, says what failed, Try again resends
 * the same id, No answer after 60 s, and Check again asks how the id ended
 * without resending. {who} is the action's (Hub, for link).
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { pageImport } from "./helpers/page-import.js";
import { shortDots } from "./helpers/short-dots.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
const errors: string[] = [];

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
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
});

const skip = () => !browser;
const PROBE = "/api/busy-probe";

interface Stub {
  ids: string[];
  /** Each answer in turn: [delay ms, status]. The last repeats. */
  plan: [number, number][];
}

async function page(width = 1280, clock = false): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
  });
  // What's new off, as in the other Settings tests: since issue 793 it
  // waits for an open pop-up (this one) to close and then opens, taking
  // the keyboard these tests check.
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  if (clock) await p.clock.install();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  // Issue 699: these tests are about the pop-up; its wait after a held
  // button's dots is set to the old 300 ms here.
  await shortDots(p);
  return p;
}

async function stub(p: Page, plan: [number, number][]): Promise<Stub> {
  const st: Stub = { ids: [], plan };
  await p.route(`**${PROBE}`, async (r) => {
    st.ids.push(r.request().headers()["x-den-request-id"] ?? "");
    const [ms, status] = plan[Math.min(st.ids.length - 1, plan.length - 1)]!;
    if (ms) await new Promise((res) => setTimeout(res, ms));
    await r.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(
        status < 400
          ? { ok: true, n: st.ids.length }
          : { ok: false, error: "it broke" },
      ),
    });
  });
  return st;
}

/**
 * Start Den's "link" action (UK-2: the kit's pop-up, Den's words; Hub is
 * who it waits for) on a button of the page; returns at once.
 */
const start = (p: Page) =>
  p.evaluate((url) => {
    const b = document.createElement("button");
    b.id = "bz-btn";
    b.textContent = "Link ticked projects";
    document.body.append(b);
    type Fn = (...a: unknown[]) => Promise<unknown>;
    const shell = (
      window as unknown as { denShell: { busyAction: Fn; api: Fn } }
    ).denShell;
    // On the page's clock (a loaded runner's round trips aren't the
    // page's): when the action started, and when its pop-up first showed.
    const w = window as unknown as { bzT0: number; bzShownAt: number | null };
    w.bzShownAt = null;
    new MutationObserver((_r, mo) => {
      if (document.querySelector("dialog.bz-dlg[open]")) {
        w.bzShownAt = performance.now();
        mo.disconnect();
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    w.bzT0 = performance.now();
    // A probe timer of the kit's wait, started now: a loaded runner fires
    // both late, so the pop-up is judged against it, never a wider wait.
    const wp = window as unknown as { bzProbeAt: number | null };
    wp.bzProbeAt = null;
    setTimeout(() => (wp.bzProbeAt = performance.now()), 300);
    (window as unknown as { bzDone: unknown }).bzDone = shell.busyAction(
      "link",
      (headers: Record<string, string>) =>
        shell.api("POST", url, {}, { headers }),
      { button: b, success: () => "Done: linked." },
    );
  }, PROBE);

const dlg = (p: Page) => p.locator("dialog.bz-dlg");

describe("BUSY-1: the working pop-up", () => {
  it("a slow answer: opens at the kit's wait, no buttons, Esc does nothing, then Success closes at once with a toast", async () => {
    if (skip()) return;
    // The page's clock is the test's (den#179): a loaded runner fires the
    // page's timers late, so any wall-clock bound is a flake.
    const p = await page(1280, true);
    await stub(p, [[2000, 200]]);
    // The kit loaded first: its load time is the page's, not its wait.
    // A string: compiled, an import() in a function becomes a helper the page
    // hasn't got.
    await p.evaluate(`${pageImport("/busy-den.js")}.then(() => true)`);
    // Paused before the action starts: the kit's wait (300 ms) runs only as
    // the test moves the page's clock. Not at 299 ms; at 300 ms, open.
    await p.clock.pauseAt((await p.evaluate(() => Date.now())) + 1000);
    await start(p);
    await expect(p.locator("#bz-btn").isDisabled()).resolves.toBe(true);
    await expect(p.locator("#bz-btn").getAttribute("aria-busy")).resolves.toBe(
      "true",
    );
    await p.clock.runFor(299);
    expect(await p.locator("dialog.bz-dlg[open]").count()).toBe(0);
    await p.clock.runFor(1);
    await dlg(p).waitFor({ state: "visible", timeout: 2000 });
    // From here time flows: the answer (2 s) comes, Success closes it.
    await p.clock.resume();
    await expect(dlg(p).locator("h2").textContent()).resolves.toContain(
      "Linking projects…",
    );
    await expect(dlg(p).textContent()).resolves.toContain("Waiting for Hub…");
    expect(await dlg(p).locator("button").count()).toBe(0);
    await expect(dlg(p).getAttribute("aria-busy")).resolves.toBe("true");
    await p.keyboard.press("Escape");
    expect(await dlg(p).isVisible()).toBe(true);
    // Success (Ward, UK-2): the pop-up closes at once and the toast says
    // it, as for a fast answer; the success line never waits in it.
    await p
      .locator(".den-toast", { hasText: "Done: linked." })
      .waitFor({ timeout: 5000 });
    expect(await p.locator("dialog.bz-dlg[open]").count()).toBe(0);
    await expect(p.locator("#bz-btn").isDisabled()).resolves.toBe(false);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("bz-btn");
  }, 30_000);

  it("a fast answer (100 ms): no pop-up ever", async () => {
    if (skip()) return;
    // den#143: on the page's clock, never the wall's. The answer comes at
    // 100 ms of the page's time, however long a loaded runner takes to
    // carry it (a 100 ms answer on the wall clock arrived after the kit's
    // 300 ms wait in full runs, and the pop-up showed).
    const p = await page(1280, true);
    let answer: () => void = () => {};
    const held = new Promise<void>((r) => (answer = r));
    await p.route(`**${PROBE}`, async (r) => {
      await held;
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, n: 1 }),
      });
    });
    await p.evaluate(`${pageImport("/busy-den.js")}.then(() => true)`);
    await p.evaluate(() => {
      (window as unknown as { seen: boolean }).seen = false;
      new MutationObserver(() => {
        if (document.querySelector("dialog.bz-dlg"))
          (window as unknown as { seen: boolean }).seen = true;
      }).observe(document.body, { childList: true });
    });
    await p.clock.pauseAt((await p.evaluate(() => Date.now())) + 1000);
    await start(p);
    await p.clock.runFor(100);
    const seen = () =>
      p.evaluate(() => (window as unknown as { seen: boolean }).seen);
    expect(await seen()).toBe(false);
    answer();
    const data = await p.evaluate(
      () => (window as unknown as { bzDone: Promise<unknown> }).bzDone,
    );
    expect(data).toMatchObject({ ok: true });
    // Well past the kit's wait (300 ms): it was answered, so nothing shows.
    await p.clock.runFor(1000);
    expect(await seen()).toBe(false);
  }, 30_000);

  // UK-2 (UI-KIT-SPEC, request ids): an error answer was stored under its
  // id (the ledger replays it), so Try again sends a new id, once.
  it("a 500: Failure says so; Try again sends once more, under a new id", async () => {
    if (skip()) return;
    const p = await page();
    const st = await stub(p, [
      [0, 500],
      [0, 200],
    ]);
    await start(p);
    await dlg(p).locator('[data-bz="retry"]').waitFor({ timeout: 5000 });
    await expect(dlg(p).textContent()).resolves.toContain(
      "Hub answered with an error (500).",
    );
    // Report first (when there is a form), Close, Try again last.
    const acts = await dlg(p)
      .locator(".bz-ft button")
      .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.bz));
    expect(acts.slice(-2)).toEqual(["close", "retry"]);
    expect(
      await p.evaluate(() => document.activeElement?.getAttribute("data-bz")),
    ).toBe("retry");
    await dlg(p).locator('[data-bz="retry"]').click();
    // Success closes the pop-up itself (never a Done); the toast says so.
    await p
      .locator("dialog.bz-dlg[open]")
      .waitFor({ state: "detached", timeout: 5000 });
    expect(await p.locator(".den-toast").count()).toBeGreaterThan(0);
    expect(st.ids).toHaveLength(2);
    expect(st.ids[0]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(st.ids[1]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(st.ids[1]).not.toBe(st.ids[0]);
  }, 30_000);

  it("60 s with no answer: No answer; Check again asks how the id ended and never resends", async () => {
    if (skip()) return;
    const p = await page(1280, true);
    const st = await stub(p, [[600_000, 200]]);
    const asked: string[] = [];
    // UK-2 Settled 1 and 11: /requests/<id>, done with the answer.
    await p.route("**/requests/*", async (r) => {
      asked.push(r.request().url());
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "x",
          state: "done",
          result: { ok: true },
          finishedAt: new Date().toISOString(),
        }),
      });
    });
    await start(p);
    await p.clock.runFor(500);
    await dlg(p).waitFor({ state: "visible" });
    await p.clock.runFor(12_000);
    await expect(dlg(p).textContent()).resolves.toMatch(
      /Still working \(1[0-9] s\)/,
    );
    await p.clock.runFor(50_000);
    await dlg(p).locator('[data-bz="check"]').waitFor();
    await expect(dlg(p).textContent()).resolves.toContain(
      "No answer from Hub yet.",
    );
    await dlg(p).locator('[data-bz="check"]').click();
    await p.clock.runFor(1000);
    // done: the pop-up closes itself and the toast says so.
    await p
      .locator("dialog.bz-dlg[open]")
      .waitFor({ state: "detached", timeout: 5000 });
    expect(await p.locator(".den-toast").count()).toBeGreaterThan(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(st.ids[0]);
    expect(st.ids).toHaveLength(1);
  }, 60_000);

  // UK-2: at 390 the kit puts the primary alone on the last row, full
  // width (busy-kit.browser holds the kit to it); Den's pop-up is the kit's.
  it("at 390 the Failure footer wraps inside the pop-up, Try again alone on the last row", async () => {
    if (skip()) return;
    const p = await page(390);
    await stub(p, [[0, 500]]);
    await start(p);
    const retry = dlg(p).locator('[data-bz="retry"]');
    await retry.waitFor({ timeout: 5000 });
    const box = (await dlg(p).boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(390 - 32 + 1);
    const r = (await retry.boundingBox())!;
    const c = (await dlg(p).locator('[data-bz="close"]').boundingBox())!;
    expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width);
    expect(r.x).toBeGreaterThanOrEqual(box.x);
    expect(r.y).toBeGreaterThanOrEqual(c.y + c.height);
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  }, 30_000);
});
