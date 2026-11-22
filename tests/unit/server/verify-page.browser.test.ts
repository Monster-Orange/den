/**
 * Issue 209: the Verify page in a real browser, on the real web server, in
 * Chromium and WebKit (Den's Playwright runner when DEN_PW_WS is set).
 *
 *   T4  from the answer, the first failing case's report opens in three
 *       clicks or fewer (here: See why, then Open report)
 *   T9  at 390 px in en, es and ja, light and dark: no sideways scroll
 *       (scrollWidth ≤ 390) and every button or link-button ≥ 32 px tall
 *   441 an imported environment ("bed"): a check's row opens the why view
 *       at its clauses; at 1440 and 390 px in en, es and ja nothing
 *       scrolls sideways, every row is 32 px or more, and a runner's
 *       markup stays text; axe finds nothing on the card or the why view
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

/** Issue 441: the same project, with an outside runner's tag on "bed". */
const HOSTILE = '<img src=x onerror="window.__pwned=1">';
const WITH_BED = {
  ...OVERVIEW,
  envOrder: [...OVERVIEW.envOrder, "bed"],
  envs: [
    {
      env: "bed",
      answer: "failed",
      imported: true,
      counts: {
        passed: 1,
        failed: 1,
        error: 0,
        blocked: 1,
        notrun: 0,
        total: 3,
      },
      run: {
        runId: "v1.2.3-dev.5",
        tag: "v1.2.3-dev.5",
        startedAt: "2026-11-15T14:06:00Z",
        endedAt: at,
        verdict: "failed",
        scope: "imported",
        startedBy: { kind: "runner" },
        commit: "4e1b9a2c",
        checks: 3,
      },
      failures: [],
      blocked: [],
      clauses: {
        passed: 2,
        failed: 1,
        error: 0,
        needsPerson: 1,
        cantRun: 1,
        total: 5,
      },
      clauseFailures: [
        {
          check: "gate/327",
          clause: "the bell row names the prompt",
          result: "failed",
          note: `webkit: page row not found ${HOSTILE}`,
        },
      ],
      needsPerson: [
        {
          check: "gate/327",
          clause: "answering the prompt clears the wait",
          result: "needs-person",
          note: "answering a permission prompt is a person's act",
        },
      ],
      cantRun: [
        {
          check: "gate/406",
          clause:
            "the person signs in on a second device with a rather long clause that has to wrap",
          result: "cant-run",
          note: "needs second device",
        },
      ],
      gateChecks: [
        {
          module: "gate/327",
          state: "failed",
          clauses: [
            {
              clause: "the bell row names the prompt",
              result: "failed",
              note: `webkit: page row not found ${HOSTILE}`,
              ms: 94000,
            },
            { clause: "stopping clears it", result: "passed", ms: 1346 },
            {
              clause: "answering the prompt clears the wait",
              result: "needs-person",
              note: "answering a permission prompt is a person's act",
            },
          ],
        },
        {
          module: "gate/330",
          state: "passed",
          clauses: [{ clause: "the row opens", result: "passed", ms: 12 }],
        },
        {
          module: "gate/406",
          state: "blocked",
          clauses: [
            {
              clause:
                "the person signs in on a second device with a rather long clause that has to wrap",
              result: "cant-run",
              note: "needs second device",
            },
          ],
        },
      ],
    },
    ...OVERVIEW.envs,
  ],
};

const AXE = require.resolve("axe-core/axe.min.js");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

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
  opts: {
    width: number;
    scheme: "light" | "dark";
    url?: string;
    overview?: unknown;
  },
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
      body: JSON.stringify(opts.overview ?? OVERVIEW),
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

  it("441: a check's row opens the why view at its clauses; Back keeps the answer", async () => {
    if (!browsers.has(engine)) return;
    await s!.settings({ language: "en" });
    const p = await open(engine, {
      width: 1440,
      scheme: "light",
      overview: WITH_BED,
    });
    try {
      // The tag, bold in the answer; the words are the catalog's (unit tests).
      expect(await p.textContent('[data-env="bed"] [data-part="say"] b')).toBe(
        "v1.2.3-dev.5",
      );
      expect(
        await p.getAttribute('[data-env="bed"] [data-badge]', "data-badge"),
      ).toBe("failed");
      await p.click('[data-env="bed"] a[data-check="gate/406"]');
      await p.waitForSelector("#gate-406");
      const u = new URL(p.url());
      expect([u.searchParams.get("why"), u.hash]).toEqual(["bed", "#gate-406"]);
      // The check it named has the focus, in view.
      const at = await p.evaluate(() => {
        const el = document.getElementById("gate-406")!;
        const r = el.getBoundingClientRect();
        return {
          focused: document.activeElement === el,
          inView: r.top >= 0 && r.top < window.innerHeight,
        };
      });
      expect(at).toEqual({ focused: true, inView: true });
      const rows = await p.$$eval("#gate-327 tr[data-result]", (els) =>
        els.map((e) => (e as HTMLElement).dataset.result),
      );
      expect(rows).toEqual(["failed", "passed", "needs-person"]);
      await p.goBack();
      await p.waitForSelector('[data-env="bed"] a[data-check]');
      // A runner's markup is text: no image, nothing ran.
      expect(
        await p.evaluate(() => ({
          imgs: document.querySelectorAll("#verify-body img").length,
          pwned: (window as unknown as { __pwned?: number }).__pwned ?? 0,
        })),
      ).toEqual({ imgs: 0, pwned: 0 });
    } finally {
      await p.context().close();
    }
  }, 90_000);

  it.each(["en", "es", "ja"])(
    "441: in %s at 1440 and 390 px, the bed's card and why view never scroll sideways, rows are 32 px or more",
    async (lang) => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: lang });
      const word = { en: "Failed", es: "Falló", ja: "失敗" }[lang]!;
      try {
        for (const width of [1440, 390])
          for (const url of ["/verify", "/verify?why=bed"]) {
            const p = await open(engine, {
              width,
              scheme: width < 400 ? "dark" : "light",
              url,
              overview: WITH_BED,
            });
            try {
              const m = await p.evaluate(() => {
                const main = document.querySelector(
                  "#den-content",
                ) as HTMLElement;
                const small = Array.from(
                  document.querySelectorAll(
                    '#verify-body a[data-check], #verify-body [data-part="back"] a, #verify-body a[href][role="button"]',
                  ),
                )
                  .map((el) => ({ el, r: el.getBoundingClientRect() }))
                  .filter(({ r }) => r.width > 0 && r.height < 32)
                  .map(
                    ({ el, r }) =>
                      `${(el.textContent ?? "").trim().slice(0, 20)} ${Math.round(r.height)}`,
                  );
                return {
                  doc: document.documentElement.scrollWidth,
                  over: main.scrollWidth - main.clientWidth,
                  small,
                  badge:
                    document.querySelector("#verify-body [data-badge]")
                      ?.textContent ?? "",
                  imgs: document.querySelectorAll("#verify-body img").length,
                };
              });
              expect([lang, width, url, m.doc <= width, m.over <= 0]).toEqual([
                lang,
                width,
                url,
                true,
                true,
              ]);
              expect([lang, width, url, m.small]).toEqual([
                lang,
                width,
                url,
                [],
              ]);
              expect(m.badge).toContain(word);
              expect(m.imgs).toBe(0);
            } finally {
              await p.context().close();
            }
          }
      } finally {
        await s!.settings({ language: "en" });
      }
    },
    180_000,
  );

  it("441: axe finds nothing on the bed's card or its why view, light and dark, 1440 and 390 px", async () => {
    if (!browsers.has(engine)) return;
    await s!.settings({ language: "en" });
    const found: string[] = [];
    for (const width of [1440, 390])
      for (const scheme of ["light", "dark"] as const)
        for (const url of ["/verify", "/verify?why=bed"]) {
          const p = await open(engine, {
            width,
            scheme,
            url,
            overview: WITH_BED,
          });
          try {
            // The scan is of the bed's own views: they must be drawn.
            await p.waitForSelector("#verify-body [data-imported]", {
              timeout: 5_000,
            });
            await p.addScriptTag({ path: AXE });
            const r = await p.evaluate(async (tags) => {
              const el = document.querySelector("#verify-body")!;
              const axe = (
                window as unknown as {
                  axe: {
                    run(
                      c: Element,
                      o: unknown,
                    ): Promise<{
                      passes: unknown[];
                      violations: {
                        id: string;
                        nodes: { target: unknown[] }[];
                      }[];
                    }>;
                  };
                }
              ).axe;
              const out = await axe.run(el, {
                runOnly: { type: "tag", values: tags },
              });
              return {
                passes: out.passes.length,
                violations: out.violations.map(
                  (v) => `${v.id}: ${JSON.stringify(v.nodes[0]?.target)}`,
                ),
              };
            }, TAGS);
            expect(r.passes).toBeGreaterThan(5);
            for (const v of r.violations)
              found.push(`${width} ${scheme} ${url} ${v}`);
          } finally {
            await p.context().close();
          }
        }
    expect(found).toEqual([]);
  }, 180_000);
});
