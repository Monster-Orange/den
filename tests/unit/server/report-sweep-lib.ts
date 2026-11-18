/**
 * Issue 81's rule, as a sweep: on every page in the nav registry
 * (denShell.pages(), so a page added there is swept with no change here)
 * and in every pop-up a person can open from the shell on it, a Report
 * entry is visible with no menu opened: the top bar's, and each pop-up's
 * own. Pop-ups here: the command palette, the status drawer, the bell,
 * the user menu (◐ ▾), each scope menu (org, project, env), and below
 * 720 px the rail's ☰ drawer (the top bar is inert behind it, so its
 * Report can't be reached). Menus count: "every dialog, drawer, sheet and
 * popover: its own visible Report button".
 *
 * In Chromium and WebKit, at 1440 and 390 px, in the languages a suite
 * names: report-sweep.browser.test.ts English (the smoke set, every pull
 * request), report-sweep-i18n.browser.test.ts Spanish and Japanese (the
 * browser shards, and any change to a page). DEN_PW_WS: Den's own
 * Playwright server; else (CI) the browsers Playwright installed. The
 * page side is report-sweep-page.js.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import type { AgentsPageServer } from "./helpers/agents-page-server.js";
import {
  clickScrim,
  missingReports,
  navPages,
  shellOpeners,
  shellUp,
  topReportShows,
  twoFrames,
} from "./report-sweep-page.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

type Engine = "chromium" | "webkit";
type Lang = "en" | "es" | "ja";
const ENGINES: Engine[] = ["chromium", "webkit"];
const WIDTHS = [1440, 390];

/** The sweep, in `langs`, on the server `start` gives. */
export function reportSweep(
  langs: readonly Lang[],
  start: () => Promise<AgentsPageServer>,
): void {
  jest.setTimeout(60_000);
  const browsers: Partial<Record<Engine, Browser>> = {};
  let s: AgentsPageServer | null = null;
  const errors: string[] = [];
  // Every page error fails the sweep. It never navigates a page away
  // (each route gets a page of its own), so WebKit's refused fetch on
  // leaving a page (helpers/webkit-leave.ts) can't happen here.

  beforeAll(async () => {
    try {
      const pw = await import("playwright");
      for (const e of ENGINES)
        browsers[e] = process.env.DEN_PW_WS
          ? await pw[e].connect(process.env.DEN_PW_WS, {
              exposeNetwork: "<loopback>",
            })
          : await pw[e].launch();
    } catch (err) {
      if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
      throw err;
    }
    s = await start();
  }, 90_000);

  afterAll(async () => {
    await s?.settings({ language: "en" }).catch(() => 0);
    await closeBrowserSuite({
      browsers: Object.values(browsers),
      servers: [s],
    });
  });

  const skip = () => !browsers.chromium || !browsers.webkit;

  /** Close whatever is open: Escape twice, then the drawer's scrim. */
  async function closeAll(p: Page) {
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    await p.evaluate(clickScrim);
  }

  /** Let the injector's frame and a repaint pass. */
  async function settle(p: Page) {
    await p.evaluate(twoFrames);
    await p.waitForTimeout(120);
  }

  async function sweepPage(p: Page, route: string, width: number) {
    const bad: string[] = [];
    await p.goto(s!.base + route);
    await p.waitForFunction(shellUp);
    await p.waitForSelector(".den-top [data-den-report]", { timeout: 10_000 });
    await p.addStyleTag({ content: "#cl-overlay{display:none!important}" });
    await settle(p);
    if (!(await p.evaluate(topReportShows)))
      bad.push(`${route} @${width}: no top-bar Report`);
    for (const m of await p.evaluate(missingReports))
      bad.push(`${route} @${width}: ${m}`);
    // The palette, by its key.
    await p.keyboard.press("Control+k");
    if (
      await p.waitForSelector(".den-pal", { timeout: 3_000 }).catch(() => null)
    ) {
      await settle(p);
      for (const m of await p.evaluate(missingReports))
        bad.push(`${route} @${width} palette: ${m}`);
    } else bad.push(`${route} @${width}: the palette didn't open`);
    await closeAll(p);
    const openers = (
      (await p.evaluate(shellOpeners)) as [string, string][]
    ).filter(([what]) => width < 720 || what !== "rail drawer");
    for (const [what, sel] of openers) {
      await settle(p);
      await p
        .click(sel)
        .catch(() => bad.push(`${route} @${width}: ${what} not clickable`));
      await settle(p);
      for (const m of await p.evaluate(missingReports))
        bad.push(`${route} @${width} ${what}: ${m}`);
      await closeAll(p);
    }
    return bad;
  }

  async function pagesOf(ctx: BrowserContext): Promise<string[]> {
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`the sign-in page: ${e.message}`));
    await p.goto(signInUrl(s!.stateDir, s!.base, "/"));
    await p.waitForFunction(shellUp);
    const paths = (await p.evaluate(navPages)) as string[];
    await p.close();
    return [...new Set(paths)];
  }

  describe("issue 81: a visible Report on every page and in every pop-up the shell opens", () => {
    const cases = ENGINES.flatMap((e) => langs.map((l) => [e, l] as const));
    it.each(cases)(
      "%s, %s: every nav page at 1440 and 390, and each pop-up from its shell",
      async (engine, lang) => {
        if (skip()) return;
        await s!.settings({ language: lang });
        const bad: string[] = [];
        for (const width of WIDTHS) {
          const ctx = await browsers[engine]!.newContext({
            viewport: { width, height: 900 },
            reducedMotion: "reduce",
          });
          try {
            const pages = await pagesOf(ctx);
            expect(pages.length).toBeGreaterThan(5);
            // A page of its own for each route, closed after it: the sweep
            // never navigates a page away, so no fetch is cut off mid-way.
            for (const r of pages) {
              const p = await ctx.newPage();
              p.on("pageerror", (e) =>
                errors.push(`${engine} ${lang} ${width} ${r}: ${e.message}`),
              );
              try {
                bad.push(...(await sweepPage(p, r, width)));
                // (A string: the page's DOM is not in the tests' type check.)
                if (
                  !(await p.evaluate(
                    `document.documentElement.lang === ${JSON.stringify(lang)}`,
                  ))
                )
                  bad.push(`${r} @${width}: not in ${lang}`);
              } finally {
                await p.close();
              }
            }
          } finally {
            await ctx.close();
          }
        }
        expect(bad).toEqual([]);
      },
      420_000,
    );

    it("no page errors", () => {
      expect(errors).toEqual([]);
    });
  });
}
