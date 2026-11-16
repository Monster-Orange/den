/**
 * Issue 210: Plan and Allow (S2) and Running and cancelled (S3) in a real
 * browser, on the real web server, in Chromium and WebKit (Den's
 * Playwright runner when DEN_PW_WS is set).
 *
 *   T7  from S2, Decline runs nothing and Allow starts the run: the
 *       person's own plan on staging, and an agent's ask (?allow=<id>),
 *       through Den's held action only (POST /api/approvals, then decide)
 *   T6  Cancel during S3 asks once, then the run ends as "Cancelled",
 *       never a pass
 *   T9  at 390 px in en, es and ja, light and dark, both screens: no
 *       sideways scroll and every button 32 px or more
 *
 * The routes answer fixed JSON (context.route), so the page is tested on
 * its own; the routes and the held run have their own tests. Invented
 * names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
const browsers = new Map<Engine, Browser>();
let s: AgentsPageServer | null = null;

const HELD = "AbCdEfGhIjKlMnOp";
const mod = (name: string, layer: string, kind: string, mark: string) => ({
  id: `shop:${name}`,
  name,
  repo: "shop",
  layer,
  kind,
  mark,
  adapter: kind === "smoke" ? "smoke" : "cmd",
  environments: ["local", "staging"],
  healthUrls:
    kind === "smoke"
      ? { staging: ["https://api.staging.example.test/health"] }
      : {},
});
const plan = (env: string) => ({
  ok: true,
  project: "north",
  env,
  shared: env !== "local",
  allow: env === "local" ? "none" : "needed",
  scope: "changed",
  modules: [
    mod("api/smoke", "api", "smoke", "enforced"),
    mod("api/orders", "api", "integration", "declared-read-only"),
    mod("web/checkout", "web", "synthetic", "declared-read-only"),
  ],
  cantRun: [
    {
      ...mod("web/devices", "web", "synthetic", "declared-by-service"),
      reason: "adapter-later",
      adapter: "device-farm",
    },
  ],
  layers: { web: ["api"], api: [] },
  nothingToRun: false,
  estimates: { "shop:api/orders": 125_000 },
});
const record = (verdict: string) => ({
  ok: true,
  runId: "r-new",
  project: "north",
  env: "staging",
  scope: "changed",
  verdict,
  exitCode: verdict === "running" ? null : 4,
  startedAt: new Date(Date.now() - 65_000).toISOString(),
  startedBy: { kind: "person" },
  allowedBy: { kind: "person" },
  ...(verdict === "running"
    ? { live: true }
    : {
        endedAt: new Date().toISOString(),
        cancelledBy: { kind: "person" },
        cancelledAt: new Date().toISOString(),
      }),
  modules: [
    {
      ...mod("api/smoke", "api", "smoke", "enforced"),
      state: "passed",
      ms: 900,
    },
    {
      ...mod("api/orders", "api", "integration", "declared-read-only"),
      state: verdict === "running" ? "running" : "cancelled",
      ms: verdict === "running" ? 0 : 2_000,
    },
    {
      ...mod("web/checkout", "web", "synthetic", "declared-read-only"),
      state: verdict === "running" ? "queued" : "cancelled",
      ...(verdict === "running" ? { waitsFor: "api" } : {}),
      ms: 0,
    },
  ],
});

/** What the page sent, for the checks. */
interface Seen {
  asks: { action: string; args: Record<string, unknown> }[];
  decisions: { id: string; decision: string }[];
  runs: unknown[];
  cancels: number;
  /** How many times the shell read what waits (its dialog's poll). */
  lists: number;
}

async function fakeRoutes(
  ctx: BrowserContext,
  waiting: boolean,
): Promise<Seen> {
  const seen: Seen = {
    asks: [],
    decisions: [],
    runs: [],
    cancels: 0,
    lists: 0,
  };
  const ask = {
    id: HELD,
    action: "verify_run",
    agent: "release-helper",
    summary: "run checks on staging in project north",
    params: {
      project: "north",
      env: "staging",
      list: "api/smoke, api/orders, web/checkout",
    },
    details: ["Scope: what changed."],
    state: "pending",
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const json = (r: Route, body: unknown, status = 200) =>
    r.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  await ctx.route(/\/api\/verify\/plan(\?|$)/, (r) => {
    const b = JSON.parse(r.request().postData() ?? "{}") as { env?: string };
    return json(r, plan(b.env ?? "local"));
  });
  await ctx.route(/\/api\/verify\/run(\?|$)/, (r) => {
    seen.runs.push(JSON.parse(r.request().postData() ?? "{}"));
    return json(r, { ok: true, runId: "r-new", running: true }, 202);
  });
  await ctx.route(/\/api\/verify\/runs\/r-new\/cancel(\?|$)/, (r) => {
    seen.cancels++;
    return json(r, { ok: true, runId: "r-new", cancelling: true });
  });
  await ctx.route(/\/api\/verify\/runs\/r-new(\?|$)/, (r) =>
    json(r, record(seen.cancels ? "cancelled" : "running")),
  );
  await ctx.route(/\/api\/approvals(\?|$)/, (r) => {
    if (r.request().method() !== "POST") {
      // The agent's ask waits, until the page decides it.
      seen.lists++;
      return json(r, {
        ok: true,
        pending: waiting && !seen.decisions.length ? [ask] : [],
      });
    }
    seen.asks.push(JSON.parse(r.request().postData() ?? "{}"));
    return json(r, { ok: true, id: HELD, state: "pending" }, 202);
  });
  await ctx.route(new RegExp(`/api/approvals/${HELD}/decide`), (r) => {
    const b = JSON.parse(r.request().postData() ?? "{}") as {
      decision: string;
    };
    seen.decisions.push({ id: HELD, decision: b.decision });
    return json(r, {
      ok: true,
      approval:
        b.decision === "allow"
          ? {
              id: HELD,
              state: "done",
              result: { ok: true, runId: "r-new", running: true },
            }
          : { id: HELD, state: "denied" },
    });
  });
  await ctx.route(new RegExp(`/api/approvals/${HELD}(\\?|$)`), (r) =>
    json(r, { ok: true, ...ask }),
  );
  return seen;
}

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
  url: string,
  opts: { width?: number; scheme?: "light" | "dark"; waiting?: boolean } = {},
): Promise<{ p: Page; seen: Seen }> {
  const ctx = await browsers.get(engine)!.newContext({
    viewport: { width: opts.width ?? 1440, height: 900 },
    colorScheme: opts.scheme ?? "light",
  });
  const seen = await fakeRoutes(ctx, opts.waiting ?? false);
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    try {
      // A stand-in approval key: the routes above are fixed answers.
      localStorage.setItem("den.approveKey", "k".repeat(43));
    } catch {
      /* none */
    }
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, url));
  await p.waitForSelector('#verify-body[aria-busy="false"]');
  return { p, seen };
}

describe.each(ENGINES)(
  "issue 210: Plan and Allow, Running, in %s",
  (engine) => {
    it("T7: the person's plan on staging: Decline runs nothing", async () => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: "en" });
      const { p, seen } = await open(engine, "/verify?plan=staging");
      try {
        await p.waitForSelector(".vf-plan-card");
        expect(await p.textContent(".vf-head h2")).toBe(
          "Run 3 checks on Staging",
        );
        await p.click('[data-act="decline"]');
        await p.waitForSelector("text=Declined. Nothing ran.");
        expect(seen.decisions).toEqual([{ id: HELD, decision: "deny" }]);
        expect(seen.runs).toEqual([]);
        expect(await p.$('[data-act="allow"]')).toBeNull();
      } finally {
        await p.context().close();
      }
    }, 90_000);

    it("T7: the person's plan on staging: Allow asks Den's held action, allows it, and shows the run", async () => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: "en" });
      const { p, seen } = await open(engine, "/verify?plan=staging");
      try {
        await p.click('[data-act="allow"]');
        await p.waitForSelector(".vf-run-card");
        expect(seen.asks).toEqual([
          {
            action: "verify_run",
            args: {
              project: "north",
              env: "staging",
              scope: "changed",
              modules: [
                "shop:api/smoke",
                "shop:api/orders",
                "shop:web/checkout",
              ],
            },
          },
        ]);
        expect(seen.decisions).toEqual([{ id: HELD, decision: "allow" }]);
        expect(new URL(p.url()).searchParams.get("run")).toBe("r-new");
        expect(await p.textContent(".vf-head h2")).toBe("Running on Staging");
      } finally {
        await p.context().close();
      }
    }, 90_000);

    it("T7: an agent's ask (?allow=): Decline runs nothing, and the bell's dialog leaves it to the page", async () => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: "en" });
      const { p, seen } = await open(
        engine,
        `/verify?allow=${HELD}&project=north`,
        {
          waiting: true,
        },
      );
      try {
        await p.waitForSelector(".vf-plan-card");
        expect(await p.textContent(".vf-head h2")).toBe(
          "release-helper wants to run 3 checks on Staging.",
        );
        expect(await p.textContent(".vf-status")).toBe(
          "Waiting for your Allow",
        );
        expect(await p.$("[data-vf-scope]")).toBeNull();
        // The shell has read what waits (the ask is in it), and its dialog
        // leaves this ask to the page.
        for (let i = 0; i < 100 && seen.lists === 0; i++)
          await p.waitForTimeout(50);
        expect(seen.lists).toBeGreaterThan(0);
        await p.waitForTimeout(300);
        expect(await p.isVisible("#den-ap-dlg")).toBe(false);
        await p.click('[data-act="decline"]');
        await p.waitForSelector("text=Declined. Nothing ran.");
        expect(seen.asks).toEqual([]);
        expect(seen.decisions).toEqual([{ id: HELD, decision: "deny" }]);
      } finally {
        await p.context().close();
      }
    }, 90_000);

    it("T7: an agent's ask: Allow decides that ask (no second one) and shows the run", async () => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: "en" });
      const { p, seen } = await open(
        engine,
        `/verify?allow=${HELD}&project=north`,
        {
          waiting: true,
        },
      );
      try {
        await p.click('[data-act="allow"]');
        await p.waitForSelector(".vf-run-card");
        expect(seen.asks).toEqual([]);
        expect(seen.decisions).toEqual([{ id: HELD, decision: "allow" }]);
      } finally {
        await p.context().close();
      }
    }, 90_000);

    it("the bell's dialog for an agent's Verify ask links to its full plan", async () => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: "en" });
      const { p } = await open(engine, "/verify", { waiting: true });
      try {
        await p.waitForSelector("#den-ap-dlg[open]");
        const link = p.locator("#den-ap-full");
        expect(await link.textContent()).toBe("See the full plan");
        expect(await link.getAttribute("href")).toBe(
          `/verify?allow=${HELD}&project=north`,
        );
        await link.click();
        await p.waitForSelector(".vf-plan-card");
        expect(await p.isVisible("#den-ap-dlg")).toBe(false);
        expect(await p.textContent(".vf-head h2")).toBe(
          "release-helper wants to run 3 checks on Staging.",
        );
      } finally {
        await p.context().close();
      }
    }, 90_000);

    it("T6: Cancel asks once, then the run ends as Cancelled, never a pass", async () => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: "en" });
      const { p, seen } = await open(engine, "/verify?run=r-new&project=north");
      try {
        await p.waitForSelector(".vf-run-card");
        expect(await p.textContent('[role="status"]')).toContain(
          "1 of 3 checks are done.",
        );
        expect(await p.textContent(".vf-run-card")).toContain(
          "waits for api to pass",
        );
        await p.click('[data-act="cancel"]');
        await p.waitForSelector('[data-act="cancel-yes"]');
        expect(seen.cancels).toBe(0);
        await p.click('[data-act="cancel-yes"]');
        await p.waitForSelector("text=Cancelled is not a pass.");
        expect(seen.cancels).toBe(1);
        expect(await p.textContent(".vf-head h2")).toBe("Cancelled");
        expect(await p.$(".vf-badge.vf-ok")).toBeNull();
        expect(await p.$('[data-act="cancel"]')).toBeNull();
      } finally {
        await p.context().close();
      }
    }, 90_000);

    it("local: Run starts at once, with no Allow", async () => {
      if (!browsers.has(engine)) return;
      await s!.settings({ language: "en" });
      const { p, seen } = await open(engine, "/verify?plan=local");
      try {
        expect(await p.$('[data-act="allow"]')).toBeNull();
        await p.click('[data-act="run"]');
        await p.waitForSelector(".vf-run-card");
        expect(seen.asks).toEqual([]);
        expect(seen.runs).toEqual([{ env: "local", background: true }]);
      } finally {
        await p.context().close();
      }
    }, 90_000);

    it.each(["en", "es", "ja"])(
      "T9: S2 and S3 at 390 px in %s, light and dark: nothing scrolls sideways, every button 32 px or more",
      async (lang) => {
        if (!browsers.has(engine)) return;
        await s!.settings({ language: lang });
        try {
          for (const scheme of ["light", "dark"] as const)
            for (const url of [
              "/verify?plan=staging",
              `/verify?allow=${HELD}&project=north`,
              "/verify?run=r-new&project=north",
            ]) {
              const { p } = await open(engine, url, {
                width: 390,
                scheme,
                waiting: url.includes("allow="),
              });
              try {
                await p.waitForSelector(".vf-plan-card, .vf-run-card");
                const m = await p.evaluate(() => {
                  const main = document.querySelector("#den-content")!;
                  const small = Array.from(
                    main.querySelectorAll("button, a.den-btn, .vf-back a"),
                  )
                    .map((el) => el.getBoundingClientRect())
                    .filter((r) => r.width > 0 && r.height < 32).length;
                  // What sticks out past the viewport, to name in a failure.
                  const wide = Array.from(main.querySelectorAll("*"))
                    .filter((el) => el.getBoundingClientRect().right > 391)
                    .slice(0, 3)
                    .map((el) => `${el.tagName}.${el.className}`);
                  return {
                    doc: document.documentElement.scrollWidth,
                    main: (main as HTMLElement).scrollWidth,
                    mainW: (main as HTMLElement).clientWidth,
                    small,
                    wide,
                  };
                });
                expect([lang, scheme, url, m.doc <= 390, m.wide]).toEqual([
                  lang,
                  scheme,
                  url,
                  true,
                  [],
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
      180_000,
    );
  },
);
