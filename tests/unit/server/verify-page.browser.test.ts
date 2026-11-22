/**
 * Issue 209: the Verify page in a real browser, on the real web server, in
 * Chromium and WebKit (Den's Playwright runner when DEN_PW_WS is set).
 *
 *   T4  from the answer, the first failing case's report opens in three
 *       clicks or fewer (here: See why, then Open report)
 *   T9  at 390 px in en, es and ja, light and dark: no sideways scroll
 *       (scrollWidth ≤ 390) and every button or link-button ≥ 32 px tall
 *
 * The overview and the report are fixed answers (page.route), so the page
 * is tested on its own; the routes have their own tests. Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { launchBrowser } from "../helpers/browser.js";

type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
const browsers = new Map<Engine, Browser>();
let s: AgentsPageServer | null = null;

const at = "2026-11-15T14:10:00Z";
const OVERVIEW = {
  ok: true,
  project: "north",
  modules: 3,
  envOrder: ["local", "staging", "production"],
  envs: [
    {
      env: "staging",
      answer: "failed",
      counts: {
        passed: 1,
        failed: 1,
        error: 0,
        blocked: 1,
        notrun: 0,
        total: 3,
      },
      run: {
        runId: "r-stage",
        endedAt: at,
        verdict: "failed",
        scope: "all",
        startedBy: { kind: "agent", name: "release-helper" },
        allowedBy: { kind: "person" },
        commit: "e4f5a6b9",
        checks: 3,
      },
      failures: [
        {
          module: "api/orders",
          state: "failed",
          message: "POST /orders returned 500",
          runId: "r-stage",
          report: true,
        },
      ],
      blocked: [{ module: "web/checkout-with-a-long-name", blockedBy: "api" }],
    },
    {
      env: "production",
      answer: "nothing",
      nothing: "none-here",
      counts: {
        passed: 0,
        failed: 0,
        error: 0,
        blocked: 0,
        notrun: 0,
        total: 0,
      },
      failures: [],
      blocked: [],
    },
    {
      env: "local",
      answer: "ready",
      counts: {
        passed: 3,
        failed: 0,
        error: 0,
        blocked: 0,
        notrun: 0,
        total: 3,
      },
      failures: [],
      blocked: [],
    },
  ],
  checks: [
    {
      module: "api/orders",
      layer: "api",
      kind: "integration",
      dependsOn: [],
      states: { local: "passed", staging: "failed", production: "off" },
    },
    {
      module: "web/checkout-with-a-long-name",
      layer: "web",
      kind: "synthetic",
      dependsOn: ["api"],
      states: { local: "passed", staging: "blocked", production: "off" },
    },
  ],
  activity: [
    {
      runId: "r-stage",
      env: "staging",
      verdict: "failed",
      startedAt: at,
      endedAt: at,
      startedBy: { kind: "agent", name: "release-helper" },
      allowedBy: { kind: "person" },
      checks: 3,
    },
  ],
};

beforeAll(async () => {
  const pw = await import("playwright");
  for (const engine of ENGINES) {
    try {
      // DEN_PW_WS: Den's own Playwright server instead of a local browser.
      browsers.set(engine, await launchBrowser(pw[engine]));
    } catch (err) {
      if (process.env.DEN_SKIP_BROWSER_TESTS === "1") continue;
      throw err;
    }
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: browsers.values(), servers: [s] });
});

async function open(
  engine: Engine,
  opts: { width: number; scheme: "light" | "dark"; url?: string },
): Promise<Page> {
  const ctx = await browsers.get(engine)!.newContext({
    viewport: { width: opts.width, height: 900 },
    colorScheme: opts.scheme,
  });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  // On the context, not the page: the report opens in a new tab.
  await ctx.route(/\/api\/verify\/overview/, (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(OVERVIEW),
    }),
  );
  await ctx.route(/\/api\/verify\/runs\/r-stage\/report/, (r) =>
    r.fulfill({
      contentType: "text/plain; charset=utf-8",
      body: "creating an order\nPOST /orders returned 500\n",
    }),
  );
  await signInPage(p, s!.stateDir, s!.base, opts.url ?? "/verify");
  await p.waitForSelector('#verify-body[aria-busy="false"]');
  return p;
}

describe.each(ENGINES)("issue 209: the Verify page in %s", (engine) => {
  it("T4: answer → See why → Open report: the report in three clicks or fewer", async () => {
    if (!browsers.has(engine)) return;
    await s!.settings({ language: "en" });
    const p = await open(engine, { width: 1440, scheme: "light" });
    try {
      const cards = await p.$$eval("#verify-body .vf-ans", (els) =>
        els.map((e) => (e as HTMLElement).dataset.env),
      );
      expect(cards).toEqual(["staging", "production", "local"]);
      let clicks = 0;
      await p.click('a[data-why="staging"]');
      clicks++;
      await p.waitForSelector(".vf-why-card");
      expect(new URL(p.url()).searchParams.get("why")).toBe("staging");
      expect(await p.textContent(".vf-why-card")).toContain(
        "POST /orders returned 500",
      );
      const [report] = await Promise.all([
        p.context().waitForEvent("page"),
        p.click(".vf-report"),
      ]);
      clicks++;
      await report.waitForLoadState();
      expect(await report.textContent("body")).toContain(
        "POST /orders returned 500",
      );
      expect(clicks).toBeLessThanOrEqual(3);
      // Back keeps the answer, worst first.
      await p.goBack();
      await p.waitForSelector('a[data-why="staging"]');
    } finally {
      await p.context().close();
    }
  }, 90_000);

  it.each(["en", "es", "ja"])(
    "T9: at 390 px in %s, light and dark, nothing scrolls sideways and every button is 32 px or more",
    async (lang) => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: lang });
      try {
        for (const scheme of ["light", "dark"] as const)
          for (const url of ["/verify", "/verify?why=staging"]) {
            const p = await open(engine, { width: 390, scheme, url });
            try {
              const m = await p.evaluate(() => {
                const main = document.querySelector("#den-content")!;
                // Every button on the page, the shell's too: a tap
                // target is 32 px or more each way.
                const small = Array.from(
                  document.querySelectorAll(
                    'button, [role="button"], a.den-btn, summary, .vf-back a',
                  ),
                )
                  .map((el) => ({ el, r: el.getBoundingClientRect() }))
                  .filter(
                    ({ el, r }) =>
                      r.width > 0 &&
                      r.height > 0 &&
                      getComputedStyle(el).visibility !== "hidden" &&
                      (r.height < 32 || r.width < 32),
                  )
                  .map(
                    ({ el, r }) =>
                      `${el.tagName.toLowerCase()}#${el.id}.${(el as HTMLElement).className} "${(el.textContent ?? "").trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
                  );
                return {
                  doc: document.documentElement.scrollWidth,
                  main: (main as HTMLElement).scrollWidth,
                  mainW: (main as HTMLElement).clientWidth,
                  small,
                  mode: document.documentElement.dataset.mode,
                };
              });
              expect([lang, scheme, url, m.doc <= 390]).toEqual([
                lang,
                scheme,
                url,
                true,
              ]);
              expect([lang, scheme, url, m.main <= m.mainW]).toEqual([
                lang,
                scheme,
                url,
                true,
              ]);
              expect([lang, scheme, url, m.small]).toEqual([
                lang,
                scheme,
                url,
                [],
              ]);
              expect(m.mode).toBe(scheme);
            } finally {
              await p.context().close();
            }
          }
      } finally {
        await s!.settings({ language: "en" });
      }
    },
    120_000,
  );
});
