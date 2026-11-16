/**
 * Issue 211: the All environments tab (the board) in a real browser, on the
 * real web server, in Chromium and WebKit (DEN_PW_WS when set).
 *
 *   T10  the tab survives a reload through ?tab=board; a cell opens its
 *        panel with focus moved into it, and closing it (Close or Esc)
 *        returns focus to the cell
 *   T9   at 390 px in en, es and ja, light and dark, with and without the
 *        panel: no sideways scroll, every button 32 px or more; the panel
 *        is a full-screen sheet
 *
 * The overview is a fixed answer (context route); the route has its own
 * tests. Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
const browsers = new Map<Engine, Browser>();
let s: AgentsPageServer | null = null;

const at = "2026-11-15T14:10:00Z";
const counts = {
  passed: 0,
  failed: 0,
  error: 0,
  blocked: 0,
  notrun: 0,
  total: 0,
};
const check = (
  module: string,
  layer: string,
  states: Record<string, string>,
  over: Record<string, unknown> = {},
) => ({
  module,
  layer,
  kind: "integration",
  mark: "declared-read-only",
  dependsOn: [],
  states,
  recent: {
    local: ["passed", "passed"],
    staging: ["passed", "failed"],
    production: [],
  },
  from: {},
  ...over,
});
const OVERVIEW = {
  ok: true,
  project: "north",
  modules: 4,
  envOrder: ["local", "staging", "production"],
  envs: [
    {
      env: "staging",
      answer: "failed",
      counts,
      run: {
        runId: "r-s",
        endedAt: at,
        verdict: "failed",
        scope: "all",
        checks: 3,
      },
      failures: [],
      blocked: [],
    },
    { env: "production", answer: "notrun", counts, failures: [], blocked: [] },
    {
      env: "local",
      answer: "ready",
      counts,
      run: {
        runId: "r-l",
        endedAt: at,
        verdict: "passed",
        scope: "all",
        checks: 4,
      },
      failures: [],
      blocked: [],
    },
  ],
  checks: [
    check(
      "web/checkout-with-a-much-longer-name",
      "web",
      { local: "passed", staging: "blocked", production: "off" },
      { dependsOn: ["api"], kind: "synthetic" },
    ),
    check("api/orders", "api", {
      local: "passed",
      staging: "failed",
      production: "off",
    }),
    check("api/users", "api", {
      local: "passed",
      staging: "passed",
      production: "off",
    }),
    check(
      "code/deps",
      "code",
      { local: "passed", staging: "passed", production: "none" },
      {
        kind: "security",
        mark: "reads-code-only",
        from: {
          local: { commit: "a1b2c3d", runId: "r-l" },
          staging: { commit: "9f8e7d6", runId: "r-old" },
        },
      },
    ),
  ],
  activity: [],
};

beforeAll(async () => {
  const pw = await import("playwright");
  for (const engine of ENGINES) {
    try {
      browsers.set(
        engine,
        process.env.DEN_PW_WS
          ? await pw[engine].connect(process.env.DEN_PW_WS, {
              exposeNetwork: "<loopback>",
            })
          : await pw[engine].launch(),
      );
    } catch (err) {
      if (process.env.DEN_SKIP_BROWSER_TESTS === "1") continue;
      throw err;
    }
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  for (const b of browsers.values()) await b.close();
  await s?.stop();
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
  await ctx.route(/\/api\/verify\/overview/, (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(OVERVIEW),
    }),
  );
  await p.goto(
    signInUrl(s!.stateDir, s!.base, opts.url ?? "/verify?tab=board"),
  );
  await p.waitForSelector('#verify-body[aria-busy="false"]');
  // Close "What's new" for real: hidden but open, its own Esc handler
  // would take the key (and focus) from the page.
  await p.evaluate(() =>
    (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
  );
  return p;
}

const focused = (p: Page) =>
  p.evaluate(
    () =>
      document.activeElement?.getAttribute("data-vf-cell") ??
      document.activeElement?.id ??
      document.activeElement?.tagName,
  );

describe.each(ENGINES)("issue 211: the board in %s", (engine) => {
  it("T10: ?tab=board survives a reload; a cell opens its panel with focus moved, and closing returns it", async () => {
    if (!browsers.has(engine)) return;
    await s!.settings({ language: "en" });
    const p = await open(engine, {
      width: 1440,
      scheme: "light",
      url: "/verify",
    });
    try {
      // From the answer, the tab: kept in the URL.
      await p.click('[data-vf-tab="board"]');
      await p.waitForSelector(".vf-board");
      expect(new URL(p.url()).searchParams.get("tab")).toBe("board");
      await p.reload();
      await p.waitForSelector('#verify-body[aria-busy="false"]');
      await p.evaluate(() =>
        (
          window as unknown as { closeChangelog?: () => void }
        ).closeChangelog?.(),
      );
      expect(
        await p.getAttribute('[data-vf-tab="board"]', "aria-pressed"),
      ).toBe("true");
      expect(await p.isVisible(".vf-board")).toBe(true);

      // A cell: the panel beside the grid, focus in it.
      await p.click('[data-vf-cell="staging|api"]');
      await p.waitForSelector(".vf-panel");
      expect(await focused(p)).toBe("vf-panel-h");
      expect(await p.textContent(".vf-panel")).toContain("api/orders");
      const [board, panel] = await Promise.all([
        p.$eval(".vf-board", (e) => e.getBoundingClientRect().right),
        p.$eval(".vf-panel", (e) => e.getBoundingClientRect().left),
      ]);
      expect(panel).toBeGreaterThanOrEqual(board);
      // Esc closes it; focus goes back to the cell. ("What's new" may open
      // late; closed for real first, so its Esc handler stays out of it.)
      await p.waitForFunction(() => {
        (
          window as unknown as { closeChangelog?: () => void }
        ).closeChangelog?.();
        return !document
          .getElementById("cl-overlay")
          ?.classList.contains("open");
      });
      await p.focus("#vf-panel-h");
      await p.keyboard.press("Escape");
      await p.waitForSelector(".vf-panel", { state: "detached" });
      expect(await focused(p)).toBe("staging|api");

      // Close does the same.
      await p.click('[data-vf-cell="local|code"]');
      await p.waitForSelector(".vf-panel");
      await p.click("[data-vf-close]");
      await p.waitForSelector(".vf-panel", { state: "detached" });
      expect(await focused(p)).toBe("local|code");

      // Back to the answer, and Back returns to the board.
      await p.click('[data-vf-tab="answer"]');
      await p.waitForSelector(".vf-ans");
      expect(new URL(p.url()).searchParams.get("tab")).toBeNull();
      await p.goBack();
      await p.waitForSelector(".vf-board");
    } finally {
      await p.context().close();
    }
  }, 90_000);

  it.each(["en", "es", "ja"])(
    "T9: at 390 px in %s, light and dark, the board and its sheet scroll no sideways and buttons are 32 px or more",
    async (lang) => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: lang });
      try {
        for (const scheme of ["light", "dark"] as const) {
          const p = await open(engine, { width: 390, scheme });
          try {
            const measure = () =>
              p.evaluate(() => {
                const main = document.querySelector("#den-content")!;
                const small = Array.from(
                  main.querySelectorAll("button, a.den-btn"),
                )
                  .map((el) => el.getBoundingClientRect())
                  .filter((r) => r.width > 0 && r.height < 32).length;
                return {
                  doc: document.documentElement.scrollWidth,
                  main: (main as HTMLElement).scrollWidth,
                  mainW: (main as HTMLElement).clientWidth,
                  small,
                };
              });
            for (const step of ["board", "sheet"]) {
              if (step === "sheet") {
                await p.click('[data-vf-cell="staging|web"]');
                await p.waitForSelector(".vf-panel");
                expect(await focused(p)).toBe("vf-panel-h");
                const r = await p.$eval(".vf-panel", (e) => {
                  const b = e.getBoundingClientRect();
                  return { l: b.left, w: b.width };
                });
                expect([lang, scheme, r.l, r.w]).toEqual([
                  lang,
                  scheme,
                  0,
                  390,
                ]);
              }
              const m = await measure();
              expect([
                lang,
                scheme,
                step,
                m.doc <= 390,
                m.main <= m.mainW,
                m.small,
              ]).toEqual([lang, scheme, step, true, true, 0]);
            }
            await p.click("[data-vf-close]");
            expect(await focused(p)).toBe("staging|web");
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
