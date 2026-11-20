/**
 * Issue 167 (mock v6 A6): Settings › Project setup › Name, linked to Hub,
 * when Den's last check of Hub's names failed: the last name, how old it
 * is, and Try again (the working pop-up while Den asks Hub). Hub answering
 * again takes the line away. Rename (A1-A3): Rename… opens New name, Ask
 * Hub to rename and Cancel; asking posts the new name, then the row says
 * the rename waits in Hub with Open in Hub and Rename off, and the name
 * shown is still Hub's. Hub refusing: its words inline, the name as it was.
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
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    browser = await launchBrowser(chromium);
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
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
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
  pending: () => unknown = () => null,
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
    if (b.workspaces?.north) {
      b.workspaces.north.hub_project = STAR;
      const w = pending();
      if (w) b.workspaces.north.hub_rename = w;
    }
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

  it("Rename asks Hub; the row then says it waits there, the name unchanged", async () => {
    if (skip()) return;
    const posts: unknown[] = [];
    let waiting: unknown = null;
    const held = "https://hub.example.test/acme/held/held_1";
    const p = await page(
      {
        "**/api/hub/names-check": (r) =>
          json(r, { ok: true, okAt: new Date().toISOString() }),
        "**/api/workspaces/north/hub-rename": (r) => {
          posts.push(r.request().postDataJSON());
          waiting = {
            to: "Polaris",
            held: "held_1",
            url: held,
            askedAt: new Date().toISOString(),
          };
          return json(r, { ok: true, project: "north", pending: waiting });
        },
      },
      () => waiting,
    );
    await p.click(`${ROW} [data-pname-rename]`);
    await p.waitForSelector(`${ROW} #pname-new`);
    expect(await p.textContent(`${ROW} label[for="pname-new"]`)).toBe(
      "New name",
    );
    expect(await p.textContent(`${ROW} #pname-new-help`)).toBe(
      "This sends a held change to Hub. The name here stays as it is until it is approved.",
    );
    // Cancel: back as it was, nothing sent.
    await p.click(`${ROW} [data-pname-cancel]`);
    expect(await p.$(`${ROW} #pname-new`)).toBeNull();
    expect(posts).toEqual([]);
    await p.click(`${ROW} [data-pname-rename]`);
    await p.fill(`${ROW} #pname-new`, "Polaris");
    await p.click(`${ROW} [data-pname-ask]`);
    await p.waitForSelector(`${ROW} [data-pname-pending]`);
    expect(posts).toEqual([{ name: "Polaris" }]);
    expect(await p.textContent(`${ROW} [data-pname-pending]`)).toContain(
      "Rename to “Polaris” is waiting for a decision in Hub.",
    );
    expect(await p.getAttribute(`${ROW} [data-pname-open]`, "href")).toBe(held);
    expect(await p.textContent(`${ROW} [data-pname-value]`)).toBe("North Star");
    expect(await p.isDisabled(`${ROW} [data-pname-rename]`)).toBe(true);
    expect(await p.$(`${ROW} :text("Withdraw")`)).toBeNull();
    expect(await fits(p)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("Hub refuses the rename: its words inline, the name as it was", async () => {
    if (skip()) return;
    const p = await page({
      "**/api/hub/names-check": (r) =>
        json(r, { ok: true, okAt: new Date().toISOString() }),
      "**/api/workspaces/north/hub-rename": (r) =>
        r.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: "Hub could not be reached: ECONNREFUSED",
          }),
        }),
    });
    await p.click(`${ROW} [data-pname-rename]`);
    await p.fill(`${ROW} #pname-new`, "Polaris");
    await p.click(`${ROW} [data-pname-ask]`);
    await p.waitForSelector(`${ROW} [data-pname-ask-err]:not([hidden])`);
    expect(await p.textContent(`${ROW} [data-pname-ask-err]`)).toContain(
      "Hub could not be reached",
    );
    expect(await p.textContent(`${ROW} [data-pname-value]`)).toBe("North Star");
    expect(await p.$(`${ROW} [data-pname-pending]`)).toBeNull();
    await p.context().close();
  }, 60_000);
});
