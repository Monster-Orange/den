/**
 * Issue 214: Schedules (S11) in a real browser, on the real web server, in
 * Chromium and WebKit (Den's Playwright runner when DEN_PW_WS is set).
 *
 *   way in   the answer's Schedules link opens ?schedules=1, one row each
 *   Allow    a paused row's Allow this schedule opens its plan card; Allow
 *            sends the schedule's id once, and the row comes back allowed;
 *            Decline closes the card and nothing is sent
 *   narrow   at 390 px in en, es and ja, light and dark: nothing scrolls
 *            sideways and every button is 32 px or more
 *   axe      finds nothing on the list or the open card, 1440 and 390 px
 *
 * The page is src/ui/server/public/verify-page.js. The overview and the
 * schedules are fixed answers (page.route); the routes
 * (src/ui/server/verify-schedule-routes.ts)
 * have their own tests. Invented names.
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

const now = "2026-11-21T20:00:00.000Z";
const DAY = 86_400_000;
const iso = (ms: number) => new Date(Date.parse(now) + ms).toISOString();

const OVERVIEW = {
  ok: true,
  project: "north",
  modules: 2,
  envOrder: ["local", "staging"],
  envs: [],
  checks: [],
  activity: [],
};

const PAUSED = {
  id: "devices-9c0d1e2f",
  name: "Devices, twice a week, with a long name to wrap",
  env: "staging",
  cron: "0 22 * * 2,5",
  words: { kind: "weekly", time: "22:00", days: [2, 5] },
  window: "20:00-06:00",
  modules: [
    { id: "shop:web/checkout", name: "web/checkout", mark: "enforced" },
    {
      id: "shop:web/devices-on-every-size",
      name: "web/devices-on-every-size",
      mark: "declared-by-service",
    },
  ],
  shared: true,
  codeOnly: false,
  needsAllow: true,
  readOnly: false,
  state: "plan-changed",
  runs: false,
  allow: {
    by: { kind: "person" },
    at: iso(-25 * DAY),
    expiresAt: iso(5 * DAY),
  },
  next: iso(DAY),
  last: null,
  skipped: [{ due: iso(-DAY), reason: "plan-changed" }],
  change: {
    added: ["shop:web/checkout"],
    removed: [],
    changed: [],
    writes: ["shop:web/checkout"],
  },
};
const CODE = {
  id: "code-scans-5e6f7a8b",
  name: "Weekly deep scans",
  env: "local",
  cron: "0 3 * * 1",
  words: { kind: "weekly", time: "03:00", days: [1] },
  modules: [
    { id: "shop:code/deps", name: "code/deps", mark: "reads-code-only" },
  ],
  shared: false,
  codeOnly: true,
  needsAllow: false,
  readOnly: false,
  state: "no-allow-needed",
  runs: true,
  allow: null,
  next: iso(2 * DAY),
  last: { runId: "r1", verdict: "passed", at: iso(-DAY) },
  skipped: [],
};
const list = (rows: unknown[]) => ({
  ok: true,
  project: "north",
  now,
  zone: "America/Los_Angeles",
  settings: { allowExpiryMs: 30 * DAY, expiryWarningMs: 3 * DAY },
  schedules: rows,
});

const AXE = require.resolve("axe-core/axe.min.js");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

beforeAll(async () => {
  const pw = await import("playwright");
  for (const engine of ENGINES) {
    try {
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

interface Opened {
  p: Page;
  posts: { path: string; body: unknown }[];
}

async function open(
  engine: Engine,
  opts: { width: number; scheme: "light" | "dark"; url?: string },
): Promise<Opened> {
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
  const posts: Opened["posts"] = [];
  let allowed = false;
  await ctx.route(/\/api\/verify\/overview/, (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(OVERVIEW),
    }),
  );
  await ctx.route(/\/api\/verify\/schedules(\/\w+)?(\?.*)?$/, (r) => {
    const u = new URL(r.request().url());
    if (r.request().method() === "POST") {
      posts.push({ path: u.pathname, body: r.request().postDataJSON() });
      if (u.pathname.endsWith("/allow")) allowed = true;
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }
    const paused = allowed
      ? { ...PAUSED, state: "allowed", runs: true, change: undefined }
      : PAUSED;
    return r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(list([CODE, paused])),
    });
  });
  await signInPage(p, s!.stateDir, s!.base, opts.url ?? "/verify?schedules=1");
  await p.waitForSelector('#verify-body[aria-busy="false"]');
  return { p, posts };
}

describe.each(ENGINES)("issue 214: Schedules in %s", (engine) => {
  it("way in: the answer's Schedules link opens one row per schedule", async () => {
    if (!browsers.has(engine)) return;
    await s!.settings({ language: "en" });
    const { p } = await open(engine, {
      width: 1440,
      scheme: "light",
      url: "/verify",
    });
    try {
      await p.click("a[data-sched-open]");
      await p.waitForSelector("li[data-sch]");
      expect(new URL(p.url()).searchParams.get("schedules")).toBe("1");
      const states = await p.$$eval("li[data-sch]", (els) =>
        els.map((e) => (e as HTMLElement).dataset.state),
      );
      expect(states).toEqual(["no-allow-needed", "plan-changed"]);
      // A paused schedule has no Run now; a free one does.
      expect(
        await p.locator(`button[data-sch-run="${PAUSED.id}"]`).count(),
      ).toBe(0);
      expect(await p.locator(`button[data-sch-run="${CODE.id}"]`).count()).toBe(
        1,
      );
    } finally {
      await p.context().close();
    }
  });

  it("Allow: the plan card, one POST with the id, the row comes back allowed; Decline sends nothing", async () => {
    if (!browsers.has(engine)) return;
    await s!.settings({ language: "en" });
    const { p, posts } = await open(engine, { width: 1440, scheme: "light" });
    try {
      await p.click(`button[data-sch-ask="${PAUSED.id}"]`);
      await p.waitForSelector(`[data-sch-card="${PAUSED.id}"]`);
      await p.click(`button[data-sch-decline="${PAUSED.id}"]`);
      expect(await p.locator(`[data-sch-card="${PAUSED.id}"]`).count()).toBe(0);
      expect(posts).toEqual([]);

      await p.click(`button[data-sch-ask="${PAUSED.id}"]`);
      await p.click(`button[data-sch-allow="${PAUSED.id}"]`);
      await p.waitForSelector(
        `li[data-sch="${PAUSED.id}"][data-state="allowed"]`,
      );
      expect(posts).toEqual([
        {
          path: "/api/verify/schedules/allow",
          body: { project: "north", id: PAUSED.id },
        },
      ]);
      // Focus comes back to the row, and the result is announced.
      expect(
        await p.evaluate(() =>
          document.activeElement?.getAttribute("data-sch"),
        ),
      ).toBe(PAUSED.id);
      expect(
        (await p.textContent('[data-part="note"]'))?.length,
      ).toBeGreaterThan(0);
    } finally {
      await p.context().close();
    }
  });

  it.each(["en", "es", "ja"])(
    "narrow: at 390 px in %s, light and dark, nothing scrolls sideways and every button is 32 px or more",
    async (lang) => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: lang });
      try {
        for (const scheme of ["light", "dark"] as const) {
          const { p } = await open(engine, { width: 390, scheme });
          try {
            await p.click(`button[data-sch-ask="${PAUSED.id}"]`);
            await p.waitForSelector(`[data-sch-card="${PAUSED.id}"]`);
            const m = await p.evaluate(() => {
              const small = Array.from(
                document.querySelectorAll(
                  "#verify-body button, #verify-body a[href]",
                ),
              )
                .map((el) => el.getBoundingClientRect())
                .filter((r) => r.width > 0 && (r.height < 32 || r.width < 32));
              return {
                doc: document.documentElement.scrollWidth,
                small: small.length,
              };
            });
            expect([lang, scheme, m.doc <= 390, m.small]).toEqual([
              lang,
              scheme,
              true,
              0,
            ]);
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

  it("axe finds nothing on the list or the open card, light and dark, 1440 and 390 px", async () => {
    if (!browsers.has(engine)) return;
    await s!.settings({ language: "en" });
    const found: string[] = [];
    for (const width of [1440, 390])
      for (const scheme of ["light", "dark"] as const) {
        const { p } = await open(engine, { width, scheme });
        try {
          await p.click(`button[data-sch-ask="${PAUSED.id}"]`);
          await p.waitForSelector(`[data-sch-card="${PAUSED.id}"]`);
          await p.addScriptTag({ path: AXE });
          const r = await p.evaluate(async (tags) => {
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
            const out = await axe.run(document.querySelector("#verify-body")!, {
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
          for (const v of r.violations) found.push(`${width} ${scheme} ${v}`);
        } finally {
          await p.context().close();
        }
      }
    expect(found).toEqual([]);
  }, 180_000);
});
