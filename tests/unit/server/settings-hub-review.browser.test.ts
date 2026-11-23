/**
 * Issue 646: the owner's walk in the page. Settings › Hub, connected to a
 * company: Connect's review shows a row per project (one by repo, one by
 * name, one to create), Change opens the picker in the row as a list with
 * a search (point 7), and Connect and link all sends every row at once,
 * then the summary says what happened, with Hub's plan page for the new
 * project. Switch company is there. Fits a phone.
 *
 * Subject: src/ui/server/hub-connect-review.ts (the review's rows and
 * apply) and the review drawn by settings-registry.js.
 *
 * The demo distribution (helpers/agents-page-server.ts); /api/hub and
 * /api/hub/connect-review answered by the test. Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const [top] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = top?.version ?? "";
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;
/** A key's words from the page's own catalog, filled the way it fills them. */
const tr = (p: Page, key: string, vars: Record<string, string> = {}) =>
  p.evaluate(
    ([k, v]) =>
      Object.entries(v).reduce(
        (a, [n, x]) => a.split(`{${n}}`).join(x),
        String(
          (
            window as unknown as { denShell: { t: (k: string) => string } }
          ).denShell.t(k),
        ),
      ),
    [key, vars] as const,
  );
const ROW = '[data-setting="agents.hub"]';
const WEB = { id: "proj_web1", slug: "web", name: "Web" };
const DOCS = { id: "proj_docs1", slug: "docs", name: "Docs" };
const OTHER = { id: "proj_o1", slug: "other", name: "Other" };

const STATUS = {
  configured: true,
  connected: true,
  state: "connected",
  url: "https://hub.example.test",
  team: "Acme Co",
  role: "owner",
  login: "tester",
  label: "den on box",
};

const review = () => ({
  ok: true,
  connected: true,
  projects: [WEB, DOCS, OTHER],
  rows: [
    {
      project: "north",
      name: "north",
      linked: null,
      proposal: { kind: "link", hub: WEB, why: "repo" },
    },
    {
      project: "south",
      name: "south",
      linked: null,
      proposal: { kind: "link", hub: DOCS, why: "name" },
    },
    {
      project: "east",
      name: "east",
      linked: null,
      proposal: { kind: "create", name: "east" },
    },
  ],
});

async function page(
  width: number,
  onPost: (body: unknown) => unknown,
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
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
  await p.route(
    (u) => u.pathname === "/api/hub",
    (r) =>
      r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(STATUS),
      }),
  );
  let after: unknown = null;
  await p.route("**/api/hub/connect-review", (r) => {
    if (r.request().method() === "POST") {
      after = onPost(r.request().postDataJSON());
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(after),
      });
    }
    const b = review();
    // After the press: every row linked or asked.
    if (after)
      b.rows = b.rows.map((x) =>
        x.project === "east"
          ? { ...x, proposal: null, waiting: { name: "east" } }
          : {
              ...x,
              linked: { ...(x.proposal as { hub: typeof WEB }).hub },
              proposal: null,
            },
      ) as never;
    return r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(b),
    });
  });
  // Each test's own session (signInPage), never a login link: after the
  // first run, a link opened away from the Den computer asks for pairing
  // (issue 819), so a second test's link would land signed out.
  await signInPage(p, s!.stateDir, s!.base, "/settings");
  await p.waitForSelector(`${ROW} [data-hub-review]`);
  return p;
}

const fits = (p: Page) =>
  p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

describe("issue 646: Connect's review in Settings › Hub", () => {
  it("three rows, Change picks from a list, one press links all and says what happened", async () => {
    if (skip()) return;
    const posts: unknown[] = [];
    const p = await page(1280, (body) => {
      posts.push(body);
      return {
        ok: true,
        linked: [
          { project: "north", hub: WEB, why: "repo" },
          { project: "south", hub: OTHER, why: "picked" },
        ],
        creating: [{ project: "east", name: "east", slug: "east" }],
        plan: { url: "https://hub.example.test/plans/1" },
        skipped: [],
      };
    });
    const text = await p.textContent(`${ROW} [data-hub-review]`);
    expect(text).toContain(await tr(p, "hubrv.title", { company: "Acme Co" }));
    expect(text).toContain(await tr(p, "hubrv.why.repo"));
    expect(text).toContain(await tr(p, "hubrv.why.name"));
    expect(text).toContain(await tr(p, "hubrv.create", { name: "east" }));
    expect(await p.$(`${ROW} [data-hub-switch]`)).not.toBeNull();
    // Change: the picker opens in the row, a list with a search.
    await p.click(`${ROW} [data-hub-rv-change="south"]`);
    await p.waitForSelector(`${ROW} [data-hub-pick="south"]`);
    expect(await p.locator(`${ROW} [data-hub-pick-id]`).count()).toBe(3);
    await p.fill(`${ROW} [data-hub-pick-q]`, "oth");
    expect(await p.locator(`${ROW} [data-hub-pick-id]:visible`).count()).toBe(
      1,
    );
    await p.click(`${ROW} [data-hub-pick-id="${OTHER.id}"]`);
    await p.click(`${ROW} [data-hub-pick-use]`);
    expect(await p.textContent(`${ROW} [data-hub-rv-row="south"]`)).toContain(
      "Other",
    );
    await p.click(`${ROW} [data-hub-rv-apply]`);
    await p.waitForSelector(`${ROW} [data-hub-rv-done]`);
    expect(posts).toEqual([
      {
        rows: [
          { project: "north", hub: WEB.id },
          { project: "south", hub: OTHER.id },
          { project: "east", create: "east" },
        ],
      },
    ]);
    const done = await p.textContent(`${ROW} [data-hub-rv-done]`);
    expect(done).toContain(
      await tr(p, "hubrv.doneTitle", { company: "Acme Co" }),
    );
    expect(done).toContain(
      await tr(p, "hubrv.linkedLine", {
        project: "north",
        name: WEB.name,
        why: await tr(p, "hubrv.why.repo"),
      }),
    );
    expect(done).toContain(
      await tr(p, "hubrv.creatingLine", { project: "east", name: "east" }),
    );
    expect(await p.getAttribute(`${ROW} [data-hub-rv-plan]`, "href")).toBe(
      "https://hub.example.test/plans/1",
    );
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("fits a phone, with 40px targets", async () => {
    if (skip()) return;
    const p = await page(375, () => ({ ok: true, linked: [], skipped: [] }));
    expect(await fits(p)).toBeLessThanOrEqual(0);
    const h = await p.$eval(
      `${ROW} [data-hub-rv-change="north"]`,
      (el) => el.getBoundingClientRect().height,
    );
    expect(h).toBeGreaterThanOrEqual(40);
    await p.context().close();
  }, 60_000);
});
