/**
 * Issue 746 follow-up (PR 747's review): the bell's Allow row has Review,
 * which opens the held write's details lines under it (the approval
 * dialog's own). A tap opens and closes it, at phone width and desktop
 * width, and Allow and Deny stay where they are. Screenshots of the opened
 * row go to DEN_SHOTS_DIR when it is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { denAuth } from "./helpers/den-auth.js";
import { launchBrowser } from "../helpers/browser.js";
import { GateStore } from "../../../src/shared/gates/store.js";

const ENGINE = path.resolve(__dirname, "../../..");
let browser: Browser | null = null;
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;
let leftBehind = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  // A slot another test in this worker left in its gate folder, held an
  // hour on a 1-minute estimate: this suite's server must never see it (it
  // would be an overrun row in the bell, under the Allow row).
  leftBehind = new GateStore({
    dir: process.env.DEN_GATE_DIR,
    now: () => Date.now() - 60 * 60_000,
  }).ask({
    kind: "cpu",
    who: "another test",
    label: "left behind",
    pid: process.pid,
    estimateMin: 1,
  }).id;
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-bar-")));
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    {
      timeoutMs: 60_000,
      // A test box's run names the app's address ahead (the gate's
      // --base-url): DEN_TEST_PORT fixes the port; else any free one.
      ...(process.env.DEN_TEST_PORT
        ? { pickPort: () => Promise.resolve(Number(process.env.DEN_TEST_PORT)) }
        : {}),
    },
  );
  server = started.server;
  port = started.port;
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      // The worker's later tests don't inherit the seeded slot.
      if (leftBehind)
        new GateStore({ dir: process.env.DEN_GATE_DIR }).release(leftBehind);
    },
  });
});

const skip = () => !browser;
const base = () => `http://localhost:${port}`;
let held = "";

/** A held write waiting for the person: an agent asks to add a test box. */
beforeAll(async () => {
  if (skip()) return;
  const r = await fetch(`${base()}/api/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", ...denAuth(stateDir) },
    body: JSON.stringify({
      action: "gate_box_set",
      args: {
        box: { name: "box1", ssh: "runner@box1.example", browser_slots: 2 },
      },
    }),
  });
  expect(r.status).toBe(202);
  held = ((await r.json()) as { id: string }).id;
}, 30_000);

/** The bell open at `width`, the Allow dialog put off with Later. */
async function bellAt(width: number): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    // A phone: taps, as on an iPhone.
    ...(width < 600 ? { hasTouch: true, isMobile: true } : {}),
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await signInPage(p, stateDir, base(), "/");
  const later = p.locator("#den-ap-later");
  await later.waitFor({ timeout: 20_000 });
  await later.click();
  await p.click("#den-bell");
  await p.locator(`[data-ap-row="${held}"]`).waitFor({ timeout: 15_000 });
  return p;
}

const row = (p: Page) => p.locator(`[data-ap-row="${held}"]`);
/**
 * Where `sel` is now, measured in the page in one step. The open bell
 * repaints on every refresh (its poll, focus), which replaces the row's
 * buttons; a locator's boundingBox finds the element, then measures it, and
 * a repaint between the two gives null.
 */
async function rect(p: Page, sel: string) {
  const r = await p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }, sel);
  if (!r) throw new Error(`${sel} is not on the page`);
  return r;
}
const inRow = (sel: string) => `[data-ap-row="${held}"] ${sel}`;
const box = (p: Page, bell: string) => rect(p, inRow(`[data-bell="${bell}"]`));

describe("the bell's Allow row: Review", () => {
  it("a slot in the worker's gate folder never reaches this server's bell", async () => {
    if (skip()) return;
    const p = await bellAt(1440);
    expect(await p.locator('[data-kind="gate_overrun"]').count()).toBe(0);
    await p.context().close();
  });

  for (const width of [390, 1440])
    it(`at ${width}: a tap opens the lines and another closes them; Allow and Deny stay put`, async () => {
      if (skip()) return;
      const p = await bellAt(width);
      const review = row(p).locator('[data-bell="review"]');
      const det = row(p).locator("[data-ap-det]");
      await expect(review.getAttribute("aria-expanded")).resolves.toBe("false");
      expect(await det.isVisible()).toBe(false);
      const before = {
        allow: await box(p, "allow"),
        deny: await box(p, "deny"),
      };
      // Den Design: a phone's finger needs 44 px to hit Review.
      if (width < 600)
        expect((await box(p, "review")).height).toBeGreaterThanOrEqual(44);

      const press = () => (width < 600 ? review.tap() : review.click());
      await press();
      await p.waitForFunction(
        (id) =>
          document
            .querySelector(`[data-ap-row="${id}"] [data-bell="review"]`)
            ?.getAttribute("aria-expanded") === "true",
        held,
      );
      expect(await det.isVisible()).toBe(true);
      const lines = await det.locator("[data-ap-line]").allTextContents();
      expect(lines.length).toBeGreaterThan(1);
      // Den Design: a 1px border sets the lines apart on an unhovered row.
      await expect(
        det.evaluate((el) => getComputedStyle(el).borderTopWidth),
      ).resolves.toBe("1px");
      expect(lines.some((l) => l.includes("box1"))).toBe(true);
      // The button keeps focus across the bell's repaint.
      await expect(
        p.evaluate(() => (document.activeElement as HTMLElement)?.dataset.bell),
      ).resolves.toBe("review");
      // Allow and Deny don't move: the same place and size, open or closed.
      for (const k of ["allow", "deny"] as const) {
        const now = await box(p, k);
        for (const d of ["x", "y", "width", "height"] as const)
          expect(Math.round(now[d])).toBe(Math.round(before[k][d]));
      }
      // Nothing runs off the panel's right edge.
      const pop = await rect(p, "#den-bell-pop");
      const d = await rect(p, inRow("[data-ap-det]"));
      expect(d.x + d.width).toBeLessThanOrEqual(pop.x + pop.width + 1);
      if (process.env.DEN_SHOTS_DIR) {
        fs.mkdirSync(process.env.DEN_SHOTS_DIR, { recursive: true });
        await p.locator("#den-bell-pop").screenshot({
          path: path.join(
            process.env.DEN_SHOTS_DIR,
            `bell-review-${width}.png`,
          ),
        });
      }

      await press();
      await p.waitForFunction(
        (id) =>
          document
            .querySelector(`[data-ap-row="${id}"] [data-bell="review"]`)
            ?.getAttribute("aria-expanded") === "false",
        held,
      );
      expect(await det.isVisible()).toBe(false);
      await p.context().close();
    }, 60_000);
});

/**
 * A refresh that comes back without the focused row (a slow or
 * partial answer) drops the keyboard to the page. When the row is drawn
 * again, focus goes back to the same button; a person who moved on
 * elsewhere keeps where they went.
 */
describe("the bell keeps the keyboard across a refresh that drops the row (issue 1332)", () => {
  /** Every answer asked for while `dropping` leaves out the Allow row; the poll's too. */
  async function answers(p: Page): Promise<{ dropping: boolean }> {
    const c = { dropping: false };
    await p.route(
      (u) => u.pathname === "/api/notifications",
      async (r) => {
        if (r.request().method() !== "GET") return r.continue();
        const drop = c.dropping;
        const res = await r.fetch();
        const b = (await res.json()) as { waiting?: unknown[] };
        await r.fulfill({
          response: res,
          json: drop ? { ...b, waiting: [] } : b,
        });
      },
    );
    return c;
  }
  /** A refresh now (the bell refreshes on the window's focus). */
  const refresh = (p: Page) =>
    p.evaluate(() => window.dispatchEvent(new Event("focus")));
  const focused = (p: Page) =>
    p.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a?.dataset?.bell ?? a?.tagName ?? "";
    });
  const keyboardNow = (p: Page) =>
    p.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      const start = (window as { reviewAtStart?: Element }).reviewAtStart;
      const review = document.querySelector(
        '[data-ap-row] [data-bell="review"]',
      );
      return JSON.stringify({
        active: a
          ? `${a.tagName}${JSON.stringify(a.dataset)}${a.id ? `#${a.id}` : ""}`
          : null,
        pageHasFocus: document.hasFocus(),
        panelOpen: document
          .querySelector("#den-bell")
          ?.getAttribute("aria-expanded"),
        reviewAtStartConnected: start?.isConnected ?? null,
        sameReviewAsAtStart: start ? start === review : null,
      });
    });
  async function reviewHasKeyboard(p: Page, ms: number, when: string) {
    try {
      await p.waitForFunction(
        () =>
          (document.activeElement as HTMLElement)?.dataset?.bell === "review",
        null,
        { timeout: ms },
      );
    } catch {
      throw new Error(
        `Review doesn't have the keyboard ${when}: ${await keyboardNow(p)}`,
      );
    }
  }
  async function focusReview(p: Page) {
    const review = row(p).locator('[data-bell="review"]');
    await review.evaluate((el) => {
      (window as { reviewAtStart?: Element }).reviewAtStart = el;
    });
    await review.focus();
    await reviewHasKeyboard(p, 5_000, "before the row drops");
  }
  async function dropTheRow(p: Page) {
    const c = await answers(p);
    c.dropping = true;
    await refresh(p);
    await row(p).waitFor({ state: "detached" });
    return () => {
      c.dropping = false;
      return refresh(p);
    };
  }

  it("Review keeps the keyboard when its row comes back", async () => {
    if (skip()) return;
    const p = await bellAt(1440);
    await focusReview(p);
    const bringBack = await dropTheRow(p);
    await bringBack();
    await row(p).waitFor();
    await reviewHasKeyboard(p, 5_000, "after the row comes back");
    expect(await focused(p)).toBe("review");
    await p.context().close();
  }, 60_000);

  it("the window losing and getting focus back meanwhile isn't moving on: Review still gets the keyboard", async () => {
    if (skip()) return;
    const p = await bellAt(1440);
    await focusReview(p);
    const bringBack = await dropTheRow(p);
    await p.evaluate(() => {
      document.body.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true }),
      );
      document.body.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await bringBack();
    await row(p).waitFor();
    await reviewHasKeyboard(p, 5_000, "after the row comes back");
    expect(await focused(p)).toBe("review");
    await p.context().close();
  }, 60_000);

  it("a person who moved focus elsewhere meanwhile keeps it", async () => {
    if (skip()) return;
    const p = await bellAt(1440);
    await focusReview(p);
    const bringBack = await dropTheRow(p);
    // The person tabs on to the bell's own button.
    await p.focus("#den-bell");
    await bringBack();
    await row(p).waitFor();
    expect(await focused(p)).toBe("BUTTON");
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("den-bell");
    await p.context().close();
  }, 60_000);

  it("an answer that lands after a newer one is never drawn", async () => {
    if (skip()) return;
    const p = await bellAt(1440);
    const back = await p.evaluate(async (id) => {
      const real = window.fetch.bind(window);
      let free = () => {};
      const late = new Promise<void>((r) => (free = r));
      let n = 0;
      window.fetch = (async (u: RequestInfo | URL, o?: RequestInit) => {
        const mine =
          new URL(String(u), location.href).pathname === "/api/notifications" &&
          !o?.method;
        const first = mine && ++n === 1;
        const r = await real(u, o);
        if (!mine) return r;
        const b = await r.json();
        if (first) await late;
        const json = first ? b : { ...b, waiting: [] };
        return { ok: true, json: async () => json } as Response;
      }) as typeof fetch;
      const sel = `[data-ap-row="${id}"]`;
      const gone = new Promise<void>((res) => {
        const mo = new MutationObserver(() => {
          if (!document.querySelector(sel)) (mo.disconnect(), res());
        });
        mo.observe(document.body, { subtree: true, childList: true });
      });
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      await gone;
      free();
      await new Promise<void>((r) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => r();
        ch.port2.postMessage(0);
      });
      return !!document.querySelector(sel);
    }, held);
    expect(back).toBe(false);
    await p.context().close();
  }, 60_000);
});
