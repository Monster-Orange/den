/**
 * Issue 167 (mock v6 A6): Settings › Project setup › Name, linked to Hub,
 * when Den's last check of Hub's names failed: the last name, how old it
 * is, and Try again (the working pop-up while Den asks Hub). Hub answering
 * again takes the line away.
 *
 * The demo distribution (helpers/agents-page-server.ts). Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

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
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;
const STAR = { id: "proj_star1", slug: "north-star", name: "North Star" };
const ROW = '[data-setting="workspace.name"]';

/**
 * Settings for project north, linked to STAR; `extra` answers more routes
 * (a glob → its handler).
 */
async function page(
  extra: Record<string, (r: Route) => unknown> = {},
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 375, height: 900 },
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
  await p.route("**/api/workspaces", async (r) => {
    const res = await r.fetch();
    const b = (await res.json()) as {
      workspaces: Record<string, Record<string, unknown>>;
    };
    if (b.workspaces?.north) b.workspaces.north.hub_project = STAR;
    return r.fulfill({ response: res, body: JSON.stringify(b) });
  });
  for (const [glob, h] of Object.entries(extra))
    await p.route(glob, (r) => h(r) as Promise<void>);
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings?ws=north#workspace"));
  await p.waitForSelector(`${ROW} [data-pname]`);
  return p;
}

const json = (r: Route, body: unknown) =>
  r.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
const fits = (p: Page) =>
  p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

describe("Settings › Project setup › Name, Hub not reachable (A6)", () => {
  it("the last name, how old, Try again; Hub answering takes the line away", async () => {
    if (skip()) return;
    const okAt = new Date(Date.now() - 12 * 60_000).toISOString();
    let up = false;
    let posts = 0;
    const p = await page({
      "**/api/hub/names-check": (r) => {
        if (r.request().method() === "POST") {
          posts++;
          up = true;
        }
        return json(
          r,
          up
            ? { ok: true, okAt: new Date().toISOString(), failAt: okAt }
            : { ok: true, okAt, failAt: new Date().toISOString() },
        );
      },
    });
    await p.waitForSelector(`${ROW} [data-pname-offline]`);
    expect(await p.textContent(`${ROW} [data-pname-value]`)).toBe("North Star");
    expect(await p.textContent(`${ROW} [data-pname-offline]`)).toContain(
      "Hub can't be reached. Showing the last name Den got from Hub (checked 12 min ago).",
    );
    expect(await fits(p)).toBeLessThanOrEqual(0);
    await p.click(`${ROW} [data-pname-retry]`);
    await p.waitForSelector(`${ROW} [data-pname-offline]`, {
      state: "detached",
    });
    expect(posts).toBe(1);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);
});
