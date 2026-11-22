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

const ENGINE = path.resolve(__dirname, "../../..");
let browser: Browser | null = null;
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
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
    { timeoutMs: 60_000 },
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
const box = async (p: Page, bell: string) =>
  (await row(p).locator(`[data-bell="${bell}"]`).boundingBox())!;

describe("the bell's Allow row: Review", () => {
  for (const width of [390, 1440])
    it(`at ${width}: a tap opens the lines and another closes them; Allow and Deny stay put`, async () => {
      if (skip()) return;
      const p = await bellAt(width);
      const review = row(p).locator('[data-bell="review"]');
      const det = row(p).locator(".den-bell-det");
      await expect(review.getAttribute("aria-expanded")).resolves.toBe("false");
      expect(await det.isVisible()).toBe(false);
      const before = {
        allow: await box(p, "allow"),
        deny: await box(p, "deny"),
      };

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
      const lines = await det.locator(".den-bell-detl").allTextContents();
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.some((l) => l.includes("box1"))).toBe(true);
      // The button keeps focus across the bell's repaint.
      await expect(
        p.evaluate(() => (document.activeElement as HTMLElement)?.dataset.bell),
      ).resolves.toBe("review");
      // Allow and Deny: the same x and size; open, they may move down with
      // the row's text only if the row wraps (phone), never sideways.
      for (const k of ["allow", "deny"] as const) {
        const now = await box(p, k);
        expect(Math.round(now.x)).toBe(Math.round(before[k].x));
        expect(Math.round(now.width)).toBe(Math.round(before[k].width));
      }
      // Nothing runs off the panel's right edge.
      const pop = (await p.locator("#den-bell-pop").boundingBox())!;
      const d = (await det.boundingBox())!;
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
