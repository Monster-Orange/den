/**
 * #68: Settings › Agents › Link projects to Hub.
 *
 * Not connected (the real server, no Hub): says so and where to connect.
 * Connected: each project with Hub's suggestion, the unlinked ones with a
 * suggestion ticked; nothing is linked until Link ticked, which sends only
 * the ticked pairs, then says how many were linked and what was skipped
 * and why. In Japanese the row is Japanese. Fits a phone.
 *
 * The demo distribution (helpers/agents-page-server.ts). Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
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

const BACK = { id: "proj_back1", slug: "back-office", name: "Back office" };
const BLOG = { id: "proj_blog2", slug: "blog", name: "Blog" };
const ROW = '[data-setting="agents.hub_link_all"]';

async function page(
  answer?: (method: string, body: unknown) => unknown,
  language?: string,
): Promise<{ p: Page; posts: unknown[] }> {
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
  const posts: unknown[] = [];
  if (answer)
    await p.route("**/api/hub/link-suggestions", (r) => {
      const body = r.request().postDataJSON() as unknown;
      if (r.request().method() === "POST") posts.push(body);
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer(r.request().method(), body)),
      });
    });
  if (language) {
    await p.goto(signInUrl(s!.stateDir, s!.base, "/settings#agents"));
    await p.evaluate(
      (l) =>
        (
          window as unknown as {
            denShell: {
              api: (m: string, u: string, b: unknown) => Promise<unknown>;
            };
          }
        ).denShell.api("POST", "/api/settings", { language: l }),
      language,
    );
    await p.reload();
  } else await p.goto(signInUrl(s!.stateDir, s!.base, "/settings#agents"));
  await p.waitForSelector(`${ROW} [data-hubla]`);
  return { p, posts };
}

const rowText = (p: Page) => p.$eval(ROW, (el) => el.textContent ?? "");
const fits = (p: Page) =>
  p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const suggestions = () => ({
  ok: true,
  connected: true,
  projects: [
    { project: "north", hub: null, suggestion: { ...BACK, why: "repo" } },
    { project: "south", hub: null, suggestion: { ...BLOG, why: "name" } },
    { project: "west", hub: null, suggestion: null },
    { project: "east", hub: BLOG, suggestion: null },
  ],
});

describe("Settings › Agents › Link projects to Hub (#68)", () => {
  it("not connected (the real server): says so and where to connect", async () => {
    if (skip()) return;
    const { p } = await page();
    expect(
      await p.getAttribute(`${ROW} [data-hubla]`, "data-hubla-state"),
    ).toBe("offline");
    expect(await rowText(p)).toContain("isn't connected to Hub yet");
    expect(await fits(p)).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);

  it("suggestions ticked; Link ticked sends only the ticked pairs, then says what happened", async () => {
    if (skip()) return;
    let done = false;
    const { p, posts } = await page((method) => {
      if (method === "POST") {
        done = true;
        return {
          ok: true,
          linked: [{ project: "north", hub: BACK }],
          skipped: [],
        };
      }
      const b = suggestions();
      if (done)
        b.projects[0] = {
          project: "north",
          hub: BACK,
          suggestion: null,
        } as never;
      return b;
    });
    const text = await rowText(p);
    expect(text).toContain(
      "north → Back office (back-office): has these repos",
    );
    expect(text).toContain("south → Blog (blog): same name");
    expect(text).toContain("west: Hub has no suggestion");
    expect(text).toContain("east: linked to Blog (blog)");
    expect(posts).toEqual([]);
    const north = p.locator(`${ROW} [data-hubla-pick="north"]`);
    const south = p.locator(`${ROW} [data-hubla-pick="south"]`);
    expect(await north.isChecked()).toBe(true);
    expect(await south.isChecked()).toBe(true);
    await south.uncheck();
    await p.click(`${ROW} [data-hubla-action="link"]`);
    await p.waitForSelector(`${ROW} [data-hubla-result]:not([hidden])`);
    expect(posts).toEqual([{ links: [{ project: "north", hub: BACK.id }] }]);
    expect(await rowText(p)).toContain("Linked 1 project.");
    expect(await rowText(p)).toContain("north: linked to Back office");
    expect(await fits(p)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("a skipped pair says why, in Japanese", async () => {
    if (skip()) return;
    try {
      const { p } = await page(
        (method) =>
          method === "POST"
            ? {
                ok: true,
                linked: [],
                skipped: [
                  {
                    project: "north",
                    code: "stale",
                    why: "not Hub's suggestion for it",
                  },
                ],
              }
            : suggestions(),
        "ja",
      );
      expect(await rowText(p)).toContain("チェックしたものをリンク");
      await p.click(`${ROW} [data-hubla-action="link"]`);
      await p.waitForSelector(`${ROW} [data-hubla-result]:not([hidden])`);
      const t = await rowText(p);
      expect(t).toContain("north をスキップ: Hub の候補ではなくなりました");
      expect(t).not.toContain("not Hub's suggestion");
      await p.context().close();
    } finally {
      await fetch(`${s!.base}/api/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: null }),
      }).catch(() => null);
    }
  }, 60_000);
});
