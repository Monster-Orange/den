/**
 * H5: Settings › Project setup › Hub project.
 *
 * Not connected to Hub: says so and links to Agents › Hub (the real
 * server, no Hub). Not linked: says Hub files the work in Unfiled, with
 * Hub's suggestion first and picked; nothing is linked until Link, which
 * sends the picked Hub project's id. Linked: the Hub project's name,
 * Change and Unlink (which sends null). In Spanish the row is Spanish.
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

/** Settings for project north; /api/…/hub-project answered by `answer`. */
async function page(
  answer?: (method: string, body: unknown) => unknown,
  language?: string,
): Promise<{ p: Page; puts: unknown[] }> {
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
  const puts: unknown[] = [];
  if (answer)
    await p.route("**/api/workspaces/*/hub-project", (r) => {
      const body = r.request().postDataJSON() as unknown;
      if (r.request().method() === "PUT") puts.push(body);
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer(r.request().method(), body)),
      });
    });
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings?ws=north#workspace"));
  if (language) {
    await setLanguage(p, language);
    await p.reload();
  }
  await p.waitForSelector('[data-setting="workspace.hub"] [data-hubp]');
  return { p, puts };
}

/** This install's language (a stored setting); null: back to English. */
const setLanguage = (p: Page, language: string | null) =>
  p.evaluate(
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

const rowText = (p: Page) =>
  p.$eval('[data-setting="workspace.hub"]', (el) => el.textContent ?? "");
const fits = (p: Page) =>
  p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

describe("Settings › Project setup › Hub project (H5)", () => {
  it("not connected (the real server): says so and where to connect", async () => {
    if (skip()) return;
    const { p } = await page();
    expect(await p.getAttribute("[data-hubp]", "data-hubp-state")).toBe(
      "offline",
    );
    expect(await rowText(p)).toContain("isn't connected to Hub yet");
    expect(
      await p.getAttribute(
        '[data-hubp] a[href="/settings#agents.hub"]',
        "href",
      ),
    ).toBe("/settings#agents.hub");
    expect(await fits(p)).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);

  it("not linked: Unfiled, Hub's suggestion first and picked; Link sends its id", async () => {
    if (skip()) return;
    let linked: typeof BACK | null = null;
    const { p, puts } = await page((method, body) => {
      if (method === "PUT") {
        linked = (body as { hub: string }).hub === BACK.id ? BACK : null;
        return { ok: true, project: "north", hub: linked };
      }
      return {
        ok: true,
        project: "north",
        hub: linked,
        connected: true,
        suggestions: [{ ...BACK, why: "repo" }],
        projects: [BLOG, BACK],
      };
    });
    expect(await p.getAttribute("[data-hubp]", "data-hubp-state")).toBe(
      "unlinked",
    );
    const text = await rowText(p);
    expect(text).toContain("Not linked to a Hub project");
    expect(text).toContain("Unfiled");
    // Picked, not linked: nothing was sent yet.
    expect(await p.inputValue("#hubp-sel")).toBe(BACK.id);
    expect(puts).toEqual([]);
    expect(
      await p.$$eval("#hubp-sel option", (os) => os.map((o) => o.textContent)),
    ).toEqual(["Back office (back-office): has these repos", "Blog (blog)"]);
    expect(await fits(p)).toBeLessThanOrEqual(0);

    await p.click('[data-hubp-action="link"]');
    await p.waitForSelector('[data-hubp-state="linked"]');
    expect(puts).toEqual([{ hub: BACK.id }]);
    expect(await p.textContent("[data-hubp-name]")).toBe(
      "Back office (back-office)",
    );
    await p.context().close();
  }, 60_000);

  it("linked: the name, Change and Unlink; Unlink sends null", async () => {
    if (skip()) return;
    let linked: typeof BACK | null = BACK;
    const { p, puts } = await page((method) => {
      if (method === "PUT") {
        linked = null;
        return { ok: true, project: "north", hub: null };
      }
      return {
        ok: true,
        project: "north",
        hub: linked,
        connected: true,
        suggestions: [{ ...BACK, why: "repo" }],
        projects: [BLOG, BACK],
      };
    });
    expect(await rowText(p)).toContain("Linked to Hub project");
    expect(await p.textContent('[data-hubp-action="link"]')).toBe("Change");
    // The linked one isn't offered again.
    expect(
      await p.$$eval("#hubp-sel option", (os) => os.map((o) => o.value)),
    ).toEqual([BLOG.id]);
    await p.click('[data-hubp-action="unlink"]');
    await p.waitForSelector('[data-hubp-state="unlinked"]');
    expect(puts).toEqual([{ hub: null }]);
    await p.context().close();
  }, 60_000);

  it("in Spanish, the row is Spanish", async () => {
    if (skip()) return;
    const { p } = await page(
      () => ({
        ok: true,
        project: "north",
        hub: null,
        connected: true,
        suggestions: [],
        projects: [BLOG],
      }),
      "es",
    );
    try {
      const text = await rowText(p);
      expect(text).toContain("No está vinculado a un proyecto de Hub");
      expect(await p.textContent('[data-hubp-action="link"]')).toBe("Vincular");
    } finally {
      await setLanguage(p, null);
      await p.context().close();
    }
  }, 60_000);

  it("the project's header shows its Hub project, linking to Project setup", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
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
    // The list as the server sends it, with north linked.
    await p.route("**/api/workspaces", async (r) => {
      const res = await r.fetch();
      const b = (await res.json()) as {
        workspaces: Record<string, Record<string, unknown>>;
      };
      if (b.workspaces?.north) b.workspaces.north.hub_project = BACK;
      return r.fulfill({ response: res, body: JSON.stringify(b) });
    });
    await p.goto(signInUrl(s!.stateDir, s!.base, "/?ws=north"));
    await p.waitForSelector(".content-header #ws-hub-project");
    expect(await p.textContent("#ws-hub-project")).toBe("Hub: Back office");
    expect(await p.getAttribute("#ws-hub-project", "href")).toBe(
      "/settings?ws=north#workspace",
    );
    // south isn't linked: no chip.
    await p.goto(`${s!.base}/?ws=south`);
    await p.waitForSelector(".content-header #ws-open-graph");
    expect(await p.$("#ws-hub-project")).toBeNull();
    await ctx.close();
  }, 60_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
