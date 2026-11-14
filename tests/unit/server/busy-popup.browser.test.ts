/**
 * BUSY-1: the working pop-up (busy.js), the spec's tests against a stubbed
 * route so the timings are the test's: it opens only for a slow answer, has
 * no buttons while working, ignores Esc, says what failed, Try again resends
 * the same id, No answer after 60 s, and Check again asks how the id ended
 * without resending. {who} reads the name the button passes.
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

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
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
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
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
  const p = await ctx.newPage();
  if (clock) await p.clock.install();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
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

/** Start a busy action on a button of the page; returns at once. */
const start = (p: Page, who = "Den", stay = false) =>
  p.evaluate(
    ([w, url, st]) => {
      const b = document.createElement("button");
      b.id = "bz-btn";
      b.textContent = "Link ticked projects";
      document.body.append(b);
      type Fn = (...a: unknown[]) => Promise<unknown>;
      const shell = (
        window as unknown as { denShell: { busyAction: Fn; api: Fn } }
      ).denShell;
      (window as unknown as { bzDone: unknown }).bzDone = shell.busyAction({
        button: b,
        title: "Linking projects…",
        done: "Done: linked.",
        failed: "Couldn't link the projects.",
        who: w,
        stay: st,
        run: (headers: Record<string, string>) =>
          shell.api("POST", url, {}, { headers }),
      });
    },
    [who, PROBE, stay] as const,
  );

const dlg = (p: Page) => p.locator("dialog.bz-dlg");

describe("BUSY-1: the working pop-up", () => {
  it("a slow answer: opens by 400 ms, no buttons, Esc does nothing, then Success closes by itself", async () => {
    if (skip()) return;
    const p = await page();
    await stub(p, [[2000, 200]]);
    const t0 = Date.now();
    await start(p);
    await expect(p.locator("#bz-btn").isDisabled()).resolves.toBe(true);
    await expect(p.locator("#bz-btn").getAttribute("aria-busy")).resolves.toBe(
      "true",
    );
    await dlg(p).waitFor({ state: "visible", timeout: 2000 });
    expect(Date.now() - t0).toBeLessThan(400 + 250);
    await expect(dlg(p).locator("h2").textContent()).resolves.toContain(
      "Linking projects…",
    );
    await expect(dlg(p).textContent()).resolves.toContain("Waiting for Den…");
    expect(await dlg(p).locator("button").count()).toBe(0);
    await expect(dlg(p).getAttribute("aria-busy")).resolves.toBe("true");
    await p.keyboard.press("Escape");
    expect(await dlg(p).isVisible()).toBe(true);
    await dlg(p).locator("text=Done: linked.").waitFor({ timeout: 5000 });
    await dlg(p).waitFor({ state: "detached", timeout: 3000 });
    await expect(p.locator("#bz-btn").isDisabled()).resolves.toBe(false);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("bz-btn");
  }, 30_000);

  it("a fast answer (100 ms): no pop-up ever", async () => {
    if (skip()) return;
    const p = await page();
    await stub(p, [[100, 200]]);
    await p.evaluate(() => {
      (window as unknown as { seen: boolean }).seen = false;
      new MutationObserver(() => {
        if (document.querySelector("dialog.bz-dlg"))
          (window as unknown as { seen: boolean }).seen = true;
      }).observe(document.body, { childList: true });
    });
    await start(p);
    const data = await p.evaluate(
      () => (window as unknown as { bzDone: Promise<unknown> }).bzDone,
    );
    expect(data).toMatchObject({ ok: true });
    await p.waitForTimeout(400);
    expect(
      await p.evaluate(() => (window as unknown as { seen: boolean }).seen),
    ).toBe(false);
  }, 30_000);

  it("a 500: Failure says so; Try again resends the same id once", async () => {
    if (skip()) return;
    const p = await page();
    const st = await stub(p, [
      [0, 500],
      [0, 200],
    ]);
    await start(p, "Hub", true);
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
    await dlg(p).locator('[data-bz="done"]').waitFor({ timeout: 5000 });
    expect(st.ids).toHaveLength(2);
    expect(st.ids[0]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(st.ids[1]).toBe(st.ids[0]);
  }, 30_000);

  it("60 s with no answer: No answer; Check again asks how the id ended and never resends", async () => {
    if (skip()) return;
    const p = await page(1280, true);
    const st = await stub(p, [[600_000, 200]]);
    const asked: string[] = [];
    await p.route("**/api/requests/*", async (r) => {
      asked.push(r.request().url());
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, state: "done", status: 200 }),
      });
    });
    await start(p, "Hub");
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
    await dlg(p).locator('[data-bz="done"]').waitFor({ timeout: 5000 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(st.ids[0]);
    expect(st.ids).toHaveLength(1);
  }, 60_000);

  it("at 390 the Failure footer wraps inside the pop-up, Try again last on the right", async () => {
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
    expect(r.x).toBeGreaterThanOrEqual(c.x);
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  }, 30_000);
});
