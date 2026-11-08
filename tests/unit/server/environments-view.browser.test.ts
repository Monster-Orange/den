/**
 * Environments and Releases (0.4.17, the 0.4.14 walk's bugs 8 and 9) on the
 * real server and the demo distribution (acme; north: notes, south: blog),
 * in a real browser:
 *
 *   - one rule for org and workspace: neither page has an org picker of
 *     its own; both follow the top bar's View and say so with the same
 *     note, and Environments asks for the View's workspace only;
 *   - Environments renders every row at once, each cell pulsing
 *     "checking…" until its result streams in; the controls never wait
 *     (Re-check works while checks run); a check that ran out of time
 *     says "timed out after 10 s" in its own cell.
 *
 * The health stream is the page's route (Playwright), so the test decides
 * when a result lands. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1
 * skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
const errors: string[] = [];
let latest = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function page(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "no-preference",
  });
  // What's new stays shut: it would cover the controls.
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  return p;
}

const result = (repo: string, extra: Record<string, unknown>) => ({
  type: "result",
  result: {
    repo,
    service: repo,
    label: repo,
    isEntrypoint: true,
    idx: 0,
    ...extra,
  },
});
const sse = (msgs: unknown[]) =>
  msgs.map((m) => `data: ${JSON.stringify(m)}\n\n`).join("");

async function setView(scope: string): Promise<void> {
  const r = await fetch(`${s!.base}/api/scope`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // SEC-1a: a mutation carries the CLI's credential.
      ...denAuth(s!.stateDir),
    },
    body: JSON.stringify({ scope }),
  });
  if (!r.ok) throw new Error(`POST /api/scope: ${r.status}`);
}
async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Environments (0.4.17)", () => {
  it("every row at once, pulsing checking…; results stream into their cells; Re-check never waits; a timed-out check says so", async () => {
    if (skip()) return;
    const p = await page();
    const held: Route[] = [];
    await p.route("**/api/health/stream**", (r) => {
      held.push(r);
    });
    await p.goto(`${s!.base}/environments`);
    // Both services' rows, before any result: each cell checking.
    await p.waitForSelector('tr[data-svc="notes/notes"] [data-checking]');
    await p.waitForSelector('tr[data-svc="blog/blog"] [data-checking]');
    expect(
      await p.$eval(
        'tr[data-svc="notes/notes"] .dot.checking',
        (e) => getComputedStyle(e).animationName,
      ),
    ).toBe("env-pulse");
    expect(await p.textContent("#status")).toMatch(/^checking /);
    // No org picker of its own: the View's note instead.
    expect(await p.$("#org-filter")).toBeNull();
    expect(await p.textContent("#view-note")).toBe(
      "Shows all active workspaces, as the top bar's View. Change it there.",
    );
    // The controls never wait: Re-check works while the checks run.
    expect(await p.isEnabled("#refresh")).toBe(true);
    await p.click("#refresh");
    // Re-check's own stream (refresh=1; the top bar's dots never send it).
    const recheck = () =>
      held.find(
        (r) => new URL(r.request().url()).searchParams.get("refresh") === "1",
      );
    await until(() => !!recheck());
    // Results land: one up, one timed out, each in its own row.
    const last = recheck()!;
    await last.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        result("notes", { ok: true, ms: 12, url: "http://localhost:1/h" }),
        // A hosted check's own timeout ("timeout", after 10 s).
        result("blog", { ok: false, ms: 10_004, error: "timeout" }),
        { type: "done" },
      ]),
    });
    await p.waitForFunction(
      () =>
        !document.querySelector('tr[data-svc="notes/notes"] [data-checking]'),
    );
    expect(
      await p.textContent('tr[data-svc="notes/notes"] td[data-env="local"]'),
    ).toContain("up");
    expect(
      await p.textContent('tr[data-svc="blog/blog"] td[data-env="local"]'),
    ).toContain("timed out after 10 s");
    expect(await p.textContent("#status")).toMatch(/^checked .* 1 failing$/);
    await p.context().close();
  }, 60_000);

  it("follows the top bar's View: one workspace asks for that workspace only, and says so; Releases says the same", async () => {
    if (skip()) return;
    await setView("south");
    try {
      const p = await page();
      const asked: string[] = [];
      await p.route("**/api/health/stream**", (r) => {
        asked.push(r.request().url());
        void r.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: sse([result("blog", { ok: true, ms: 5 }), { type: "done" }]),
        });
      });
      await p.goto(`${s!.base}/environments`);
      await p.waitForSelector('tr[data-svc="blog/blog"]');
      expect(await p.$('tr[data-svc="notes/notes"]')).toBeNull();
      // The page's own stream asks for the View's workspace (the top
      // bar's dots use the same route for their own).
      expect(
        asked.some((u) => new URL(u).searchParams.get("workspace") === "south"),
      ).toBe(true);
      const note =
        "Shows workspace south, as the top bar's View. Change it there.";
      expect(await p.textContent("#view-note")).toBe(note);
      await p.goto(`${s!.base}/release`);
      await p.waitForSelector("#view-note .view-note");
      expect(await p.textContent("#view-note")).toBe(note);
      expect(await p.$("#org-filter")).toBeNull();
      await p.context().close();
    } finally {
      await setView("all");
    }
  }, 60_000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
