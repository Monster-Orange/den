/**
 * Issue 212: History (S5) and Findings (S6) in a real browser, on the
 * real web server, in Chromium and WebKit (DEN_PW_WS when set).
 *
 *   from the board's panel, History opens the check's history; a run in
 *   its strip opens that run; Findings opens the scan's findings with the
 *   threshold and the SARIF report
 *   "Open an issue with this range": the exact title and body first,
 *   then Send files it and says where (at 390 px: nothing scrolls
 *   sideways)
 *   T9 at 390 px in en, es and ja, light and dark: no sideways scroll,
 *   every button 32 px or more
 *
 * The routes are fixed answers (context route); they have their own
 * tests. Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
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
const OVERVIEW = {
  ok: true,
  project: "north",
  modules: 2,
  envOrder: ["local", "staging"],
  activity: [],
  envs: [
    { env: "staging", answer: "failed", counts, failures: [], blocked: [] },
    { env: "local", answer: "ready", counts, failures: [], blocked: [] },
  ],
  checks: [
    {
      id: "shop:api/orders-with-a-much-longer-name",
      module: "api/orders-with-a-much-longer-name",
      layer: "api",
      kind: "integration",
      mark: "declared-read-only",
      dependsOn: [],
      states: { local: "passed", staging: "failed" },
      recent: { local: ["passed"], staging: ["passed", "failed"] },
      from: { staging: { commit: "e4f5a6b", runId: "r4" } },
    },
    {
      id: "shop:code/deps",
      module: "code/deps",
      layer: "code",
      kind: "security",
      mark: "reads-code-only",
      dependsOn: [],
      states: { local: "passed", staging: "passed" },
      recent: { local: ["passed"], staging: ["passed"] },
      from: { local: { commit: "e4f5a6b", runId: "r-scan" } },
    },
  ],
};
const run = (i: number, state: string, over: Record<string, unknown> = {}) => ({
  runId: `r${i}`,
  endedAt: at,
  commit: `c${i}aaaa`,
  state,
  ms: 100,
  ...over,
});
const HISTORY = {
  ok: true,
  project: "north",
  module: "shop:api/orders-with-a-much-longer-name",
  name: "api/orders-with-a-much-longer-name",
  kind: "integration",
  env: "staging",
  runs: [
    ...Array.from({ length: 9 }, (_, i) =>
      run(
        i,
        "passed",
        i % 4 === 1
          ? {
              flaky: true,
              attempts: [
                {
                  state: "failed",
                  message:
                    "timed out waiting for the pay button to appear on the page",
                  ms: 9,
                },
                { state: "passed", ms: 9 },
              ],
            }
          : {},
      ),
    ),
    run(9, "failed", { message: "POST /orders returned 500" }),
  ],
  flaky: { mark: true, count: 2, window: 10, min: 2 },
  streak: { state: "failed", runs: 1, passedBefore: 9 },
  range: {
    lastPassed: { runId: "r8", commit: "a1b2c3d" },
    firstFailed: { runId: "r9", commit: "e4f5a6b" },
  },
  commits: [
    {
      commit: "b7c8d9e",
      subject:
        "orders: add discount codes to the checkout with a long subject line",
    },
    { commit: "e4f5a6b", subject: "api: update database driver" },
  ],
};
const SCAN = {
  ok: true,
  runId: "r-scan",
  project: "north",
  env: "local",
  scope: "all",
  verdict: "passed",
  exitCode: 0,
  startedAt: at,
  endedAt: at,
  commit: "e4f5a6b",
  modules: [
    {
      id: "shop:code/deps",
      name: "code/deps",
      repo: "shop",
      layer: "code",
      kind: "security",
      mark: "reads-code-only",
      state: "passed",
      ms: 10,
      findings: {
        counts: { critical: 0, high: 0, medium: 2, low: 5 },
        failOn: "high",
        report: "deps.sarif",
        list: [
          {
            severity: "medium",
            message: "x",
            package: "yaml-lite-with-a-long-package-name",
            version: "0.9.3",
            fixedIn: "0.9.5",
          },
          {
            severity: "medium",
            message:
              "image-resize can be tricked into reading outside its folder",
          },
        ],
      },
    },
  ],
};
const RUN9 = {
  ...SCAN,
  runId: "r9",
  env: "staging",
  verdict: "failed",
  exitCode: 1,
  modules: [
    {
      ...SCAN.modules[0],
      id: "shop:api/orders",
      name: "api/orders",
      state: "failed",
      findings: undefined,
    },
  ],
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

const ISSUE_BODY =
  "`api/orders-with-a-much-longer-name` (integration) fails on **staging** in project north.\n\n- First failing run: `r9`, at commit `e4f5a6b`\n- `b7c8d9e` orders: add discount codes to the checkout with a long subject line that goes on\n";
/** The issue route's asks, in order: { send } per POST. */
const issueAsks: { send?: boolean; env?: string }[] = [];

async function routes(ctx: BrowserContext) {
  const json = (b: unknown) => ({
    contentType: "application/json",
    body: JSON.stringify(b),
  });
  await ctx.route(/\/api\/verify\/overview/, (r) => r.fulfill(json(OVERVIEW)));
  await ctx.route(/\/api\/verify\/modules\/[^/]+\/history/, (r) =>
    r.fulfill(json(HISTORY)),
  );
  await ctx.route(/\/api\/verify\/modules\/[^/]+\/issue/, (r) => {
    const b = JSON.parse(r.request().postData() || "{}") as {
      send?: boolean;
      env?: string;
    };
    issueAsks.push(b);
    return r.fulfill(
      json(
        b.send
          ? {
              ok: true,
              url: "https://github.com/acme/shop/issues/9",
              repo: "acme/shop",
            }
          : {
              ok: true,
              repo: "acme/shop",
              title:
                "api/orders-with-a-much-longer-name fails on staging since e4f5a6b",
              body: ISSUE_BODY,
              newIssueUrl:
                "https://github.com/acme/shop/issues/new?title=x&body=y",
            },
      ),
    );
  });
  await ctx.route(/\/api\/verify\/runs\/r-scan(\?|$)/, (r) =>
    r.fulfill(json(SCAN)),
  );
  await ctx.route(/\/api\/verify\/runs\/r9(\?|$)/, (r) =>
    r.fulfill(json(RUN9)),
  );
}

async function open(
  engine: Engine,
  opts: { width: number; scheme: "light" | "dark"; url: string },
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
  await routes(ctx);
  await p.goto(signInUrl(s!.stateDir, s!.base, opts.url));
  await p.waitForSelector('#verify-body[aria-busy="false"]');
  return p;
}

describe.each(ENGINES)("issue 212: history and findings in %s", (engine) => {
  it("board panel → History → a run in the strip; board panel → Findings", async () => {
    if (!browsers.has(engine)) return;
    await s!.settings({ language: "en" });
    const p = await open(engine, {
      width: 1440,
      scheme: "light",
      url: "/verify?tab=board",
    });
    try {
      await p.click('[data-vf-cell="staging|api"]');
      await p.click('.vf-panel a:has-text("History")');
      await p.waitForSelector(".vf-hstrip");
      const q = new URL(p.url()).searchParams;
      expect([q.get("history"), q.get("env")]).toEqual([
        "shop:api/orders-with-a-much-longer-name",
        "staging",
      ]);
      expect(await p.textContent("#verify-body")).toContain(
        "It first failed at e4f5a6b.",
      );
      expect(await p.locator(".vf-hrun").count()).toBe(10);
      // The flaky card lists every attempt.
      await p.click(".vf-tries summary");
      expect(
        await p.isVisible("text=timed out waiting for the pay button"),
      ).toBe(true);
      // A run in the strip opens it.
      await p.click('[data-vf-run="r9"]');
      await p.waitForSelector(".vf-run-card");
      expect(new URL(p.url()).searchParams.get("run")).toBe("r9");
      // Back returns to the history.
      await p.goBack();
      await p.waitForSelector(".vf-hstrip");

      await p.goto(new URL("/verify?tab=board", p.url()).toString());
      await p.waitForSelector('#verify-body[aria-busy="false"]');
      await p.click('[data-vf-cell="local|code"]');
      await p.click('.vf-panel a:has-text("Findings")');
      await p.waitForSelector(".vf-sevs");
      const body = await p.textContent("#verify-body");
      expect(body).toContain("Nothing at high or worse, so this scan passes.");
      expect(body).toContain("They do not fail the check.");
      expect(await p.getAttribute(".vf-report", "href")).toContain(
        "kind=sarif",
      );
    } finally {
      await p.context().close();
    }
  }, 90_000);

  it("Open an issue with this range: the exact text first, then Send files it", async () => {
    if (!browsers.has(engine)) return;
    await s!.settings({ language: "en" });
    issueAsks.length = 0;
    const p = await open(engine, {
      width: 390,
      scheme: "dark",
      url: "/verify?history=shop%3Aapi%2Forders-with-a-much-longer-name&env=staging",
    });
    try {
      await p.click('button:has-text("Open an issue with this range")');
      await p.waitForSelector(".vf-ipv");
      expect(issueAsks).toEqual([{ env: "staging" }]);
      const pv = await p.textContent(".vf-ipv");
      expect(pv).toContain("On acme/shop, as you (your gh login).");
      expect(pv).toContain("fails on staging since e4f5a6b");
      expect(await p.textContent(".vf-ipv-body")).toBe(ISSUE_BODY);
      expect(
        await p.getAttribute(
          '.vf-ipv a:has-text("Open it on GitHub instead")',
          "href",
        ),
      ).toContain("github.com/acme/shop/issues/new");
      // The preview fits the phone: no sideways scroll, buttons 32 px+.
      const m = await p.evaluate(() => {
        const main = document.querySelector("#den-content") as HTMLElement;
        return {
          doc: document.documentElement.scrollWidth,
          main: main.scrollWidth - main.clientWidth,
          small: Array.from(
            document.querySelectorAll(".vf-ipv button, .vf-ipv a.den-btn"),
          )
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.height < 32).length,
        };
      });
      expect(m).toEqual({ doc: 390, main: 0, small: 0 });
      await p.click('.vf-ipv button:has-text("Send")');
      await p.waitForSelector(
        '#vf-issue a[href="https://github.com/acme/shop/issues/9"]',
      );
      expect(issueAsks).toEqual([
        { env: "staging" },
        { env: "staging", send: true },
      ]);
      expect(await p.textContent("#vf-issue")).toContain("Filed on acme/shop:");
    } finally {
      await p.context().close();
    }
  }, 90_000);

  it.each(["en", "es", "ja"])(
    "T9: at 390 px in %s, light and dark, history and findings scroll no sideways and buttons are 32 px or more",
    async (lang) => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: lang });
      try {
        for (const scheme of ["light", "dark"] as const)
          for (const url of [
            "/verify?history=shop%3Aapi%2Forders-with-a-much-longer-name&env=staging",
            "/verify?findings=r-scan&module=shop%3Acode%2Fdeps",
          ]) {
            const p = await open(engine, { width: 390, scheme, url });
            try {
              await p.evaluate(() =>
                document
                  .querySelectorAll("details")
                  .forEach((d) => (d.open = true)),
              );
              const m = await p.evaluate(() => {
                const main = document.querySelector("#den-content")!;
                const small = Array.from(
                  main.querySelectorAll("button, a.den-btn, summary"),
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
              expect([
                lang,
                scheme,
                url,
                m.doc <= 390,
                m.main <= m.mainW,
                m.small,
              ]).toEqual([lang, scheme, url, true, true, 0]);
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
