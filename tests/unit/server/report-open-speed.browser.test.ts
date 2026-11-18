/**
 * Issue 469: Report an issue opens at once. The form, its fields and Send
 * work before the screenshot is drawn; the screenshot fills in after, with
 * "Taking a screenshot…" meanwhile (en, es, ja); a send before it is ready
 * waits for it and still includes it; the theme's mark is fetched once per
 * page, never per open.
 *
 * The budget (open → the Title field focused and typing) is
 * DEN_REPORT_OPEN_BUDGET_MS, 1000 ms unless set. Each open's time goes to
 * $FB_STEPS when set (the lane's timings under load).
 *
 * Every /api/report call is answered by the test (never the real `gh`).
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import type { Browser, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

jest.setTimeout(30_000);

/** Open → usable, in ms: a test constant, permissive, set per machine. */
const BUDGET_MS = Number(process.env.DEN_REPORT_OPEN_BUDGET_MS) || 1000;

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
const errors: string[] = [];

beforeAll(async () => {
  try {
    // DEN_HELPERS_BROWSER=webkit runs it there; DEN_PW_WS connects to a
    // Linux browser (the Playwright image), as on CI.
    const pw = await import("playwright");
    const engine =
      process.env.DEN_HELPERS_BROWSER === "webkit" ? "webkit" : "chromium";
    browser = process.env.DEN_PW_WS
      ? await pw[engine].connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await pw[engine].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

function note(label: string, ms: number) {
  const f = process.env.FB_STEPS;
  if (!f) return;
  const engine = process.env.DEN_HELPERS_BROWSER || "chromium";
  fs.appendFileSync(f, `${engine}\t${label}\t${Math.round(ms)}\n`);
}

/** The settings page in `lang`, every /api/report call answered here. */
async function page(
  sent: unknown[],
  lang: "en" | "es" | "ja" = "en",
): Promise<Page> {
  expect(await s!.settings({ language: lang })).toBe(200);
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const json = (r: Route, body: unknown) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  await p.route("**/api/report**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/report")
      return json(r, {
        ok: true,
        enabled: true,
        repos: [{ repo: "acme-eng/engine" }],
        github: { signedIn: true, deviceFlow: true },
        maxPerHour: 5,
        sentThisHour: 0,
      });
    if (u.pathname === "/api/report/diagnostics")
      return json(r, { ok: true, sections: { Den: "acme 9.9.9" } });
    if (u.pathname === "/api/report/preview")
      return json(r, {
        ok: true,
        title: "Pane drops",
        body: "It drops.",
        repo: "acme-eng/engine",
      });
    if (u.pathname === "/api/report/send") {
      sent.push(r.request().postDataJSON?.() ?? null);
      return json(r, {
        ok: true,
        url: "https://github.com/acme-eng/engine/issues/42",
        repo: "acme-eng/engine",
        added: false,
      });
    }
    return r.fulfill({ status: 404, body: "{}" });
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  expect(await p.evaluate(() => document.documentElement.lang)).toBe(lang);
  return p;
}

const dlg = (p: Page) => p.locator("dialog.fb-dlg");

/**
 * Report opened as the top bar's button does, timed in the page: until the
 * Title field is focused in the open form and takes a keystroke. A frame
 * runs only when the page is free, so a blocked page counts as waiting.
 */
async function timedOpen(p: Page): Promise<number> {
  return p.evaluate(
    () =>
      new Promise<number>((ok, no) => {
        const t0 = performance.now();
        // The longest the page was busy, until the shot is in the form.
        const w = window as unknown as { denGap: number; denShotAt: number };
        w.denGap = 0;
        w.denShotAt = 0;
        let last = t0;
        const gap = setInterval(() => {
          const now = performance.now();
          w.denGap = Math.max(w.denGap, now - last);
          last = now;
          if (document.querySelector("dialog.fb-dlg canvas[data-shot]")) {
            w.denShotAt = now - t0;
            clearInterval(gap);
          }
        }, 10);
        const stop = setTimeout(() => no(new Error("never usable")), 20_000);
        const tick = () => {
          const el = document.activeElement as HTMLInputElement | null;
          if (el?.matches?.('dialog.fb-dlg[open] [data-f="title"]')) {
            el.value = "x";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            clearTimeout(stop);
            return ok(performance.now() - t0);
          }
          requestAnimationFrame(tick);
        };
        void (
          window as unknown as { denShell: { report: () => unknown } }
        ).denShell.report();
        requestAnimationFrame(tick);
      }),
  );
}

describe("issue 469: Report opens at once, the screenshot after", () => {
  it("open → the form usable within the budget, first and second open on a page; the shot fills in", async () => {
    if (skip()) return;
    const p = await page([]);
    const first = await timedOpen(p);
    note("open1", first);
    // The screenshot arrives in the form that is already open.
    await dlg(p).locator("canvas[data-shot]").waitFor({ timeout: 20_000 });
    expect(await dlg(p).locator('[data-f="title"]').inputValue()).toBe("x");
    const after = await p.evaluate(() => {
      const w = window as unknown as {
        denGap: number;
        denShotAt: number;
        htmlToImage?: unknown;
      };
      return { gap: w.denGap, shotAt: w.denShotAt, lib: !!w.htmlToImage };
    });
    note("shot1", after.shotAt);
    note("busiest1", after.gap);
    // The lean copy took it: html-to-image was never needed.
    expect(after.lib).toBe(false);
    await p.keyboard.press("Escape");
    await dlg(p).locator('[data-act="discard"]').click();
    await dlg(p).waitFor({ state: "detached" });
    const second = await timedOpen(p);
    note("open2", second);
    await dlg(p).locator("canvas[data-shot]").waitFor({ timeout: 20_000 });
    expect({ first, second, budget: BUDGET_MS }).toEqual({
      first: expect.any(Number),
      second: expect.any(Number),
      budget: BUDGET_MS,
    });
    expect(first).toBeLessThan(BUDGET_MS);
    expect(second).toBeLessThan(BUDGET_MS);
    await p.context().close();
  });

  it("the theme's mark is fetched at most once per page, never per open", async () => {
    if (skip()) return;
    const p = await page([]);
    let marks = 0;
    p.on("request", (q) => {
      if (/\/theme\/[^/]+\/.*\.svg|\/kit\/marks\//.test(q.url())) marks++;
    });
    for (let i = 0; i < 3; i++) {
      await timedOpen(p);
      await dlg(p).locator("canvas[data-shot]").waitFor({ timeout: 20_000 });
      await p.keyboard.press("Escape");
      await dlg(p).locator('[data-act="discard"]').click();
      await dlg(p).waitFor({ state: "detached" });
    }
    expect(marks).toBeLessThanOrEqual(1);
    await p.context().close();
  });

  for (const [lang, taking, waiting] of [
    ["en", "Taking a screenshot…", "Waiting for the screenshot…"],
    ["es", "Haciendo la captura…", "Esperando la captura…"],
    [
      "ja",
      "スクリーンショットを撮っています…",
      "スクリーンショットを待っています…",
    ],
  ] as const) {
    it(`${lang}: while the shot is drawn the form works; Send waits for it, says so, and the shot still goes`, async () => {
      if (skip()) return;
      const sent: unknown[] = [];
      const p = await page(sent, lang);
      // A slow screenshot: the theme's mark (the shot inlines it) held
      // back until the test lets go.
      let release = () => {};
      const held = new Promise<void>((ok) => (release = ok));
      const hold = async (r: Route) => {
        await held;
        await r.continue();
      };
      await p.route("**/theme/**", hold);
      await p.route("**/vendor/html-to-image.js*", hold);
      await timedOpen(p);
      await dlg(p).getByText(taking).waitFor();
      await dlg(p).locator('[data-f="title"]').fill("Pane drops");
      await dlg(p).locator('[data-act="next"]').click();
      await dlg(p).locator('[data-act="review"]').click();
      await dlg(p).getByText(taking).waitFor();
      const download = p.waitForEvent("download");
      await dlg(p).locator('[data-act="send"]').click();
      await dlg(p).getByText(waiting).waitFor();
      expect(sent).toHaveLength(0);
      release();
      const saved = await download;
      expect(saved.suggestedFilename()).toBe("report-screenshot.png");
      expect(sent).toHaveLength(1);
      await p.context().close();
    });
  }

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
