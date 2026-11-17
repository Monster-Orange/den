/**
 * H5: Settings › Project setup › Hub project.
 *
 * Not connected to Hub: says so, with Connect (the real server, no Hub).
 * Not linked: says Hub files the work in Unfiled, with Hub's suggestion
 * first and picked; nothing is linked until Link, which sends the picked
 * Hub project's id. Linked (issue 167, mock v6 A0): the read-only pair;
 * Switch and Unlink behind More; Unlink asks first in a dialog with a
 * Report button and sends null only on Yes. Waiting for a pick: a button
 * to Unclear matches. In Spanish the row is Spanish. Issue 271: the
 * picker's first option is "Create a Hub project named <name>", the name
 * editable; Create asks Hub (the working pop-up meanwhile); an owner gets
 * Hub's Allow right in the row, anyone else is told who must allow it;
 * the row links on its own once Hub says it is allowed.
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
import { closeBrowserSuite } from "../../browser-teardown.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    browser = process.env.DEN_PW_WS
      ? await chromium.connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await chromium.launch();
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
    await p.route("**/api/workspaces/*/hub-create", async (r) => {
      const body = r.request().postDataJSON() as unknown;
      puts.push({ create: body });
      // Slow enough for the working pop-up to show.
      await new Promise((ok) => setTimeout(ok, 1500));
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer("CREATE", body)),
      });
    });
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
    expect(await rowText(p)).toContain(
      "isn't connected to Hub, so there is nothing to link yet",
    );
    expect(
      await p.textContent('[data-hubp] a[href="/settings#agents.hub"]'),
    ).toBe("Connect to Hub");
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
    expect(text).toContain("Not linked.");
    expect(text).toContain("Unfiled");
    expect(text).toContain("Linking affects only the project north.");
    // Picked, not linked: nothing was sent yet.
    expect(await p.inputValue("#hubp-sel")).toBe(BACK.id);
    expect(puts).toEqual([]);
    expect(
      await p.$$eval("#hubp-sel option", (os) => os.map((o) => o.textContent)),
    ).toEqual([
      "Create a Hub project named north",
      "Back office (back-office): has these repos",
      "Blog (blog)",
    ]);
    expect(await fits(p)).toBeLessThanOrEqual(0);

    await p.click('[data-hubp-action="link"]');
    await p.waitForSelector('[data-hubp-state="linked"]');
    expect(puts).toEqual([{ hub: BACK.id }]);
    expect(await p.textContent("[data-hubp-name]")).toBe(
      "Back office (back-office)",
    );
    await p.context().close();
  }, 60_000);

  it("linked: the pair; Switch and Unlink behind More; Unlink asks, then sends null", async () => {
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
    const text = await rowText(p);
    expect(text).toContain("north");
    expect(text).toContain("Linked when this install connected to Hub.");
    expect(text).toContain(
      "Docs, mocks and comments that north's agents make go to Back office in Hub.",
    );
    // More is closed: Switch and Unlink aren't on screen.
    expect(await p.isVisible('[data-hubp-action="unlink"]')).toBe(false);
    await p.click("[data-hubp-more] summary");
    expect(await p.textContent('[data-hubp-action="link"]')).toBe("Switch");
    // The linked one isn't offered again.
    expect(
      await p.$$eval("#hubp-sel option", (os) => os.map((o) => o.value)),
    ).toEqual([BLOG.id]);
    expect(await fits(p)).toBeLessThanOrEqual(0);
    // Unlink asks first; Cancel sends nothing.
    await p.click('[data-hubp-action="unlink"]');
    await p.waitForSelector("#hubp-dlg[open]");
    expect(await p.textContent("#hubp-dlg h2")).toBe(
      "Unlink north from the Hub project Back office?",
    );
    expect(await p.$("#hubp-dlg [data-den-report]")).not.toBeNull();
    await p.click('[data-hubp-dlg="cancel"]');
    await p.waitForSelector("#hubp-dlg", { state: "detached" });
    expect(puts).toEqual([]);
    await p.click('[data-hubp-action="unlink"]');
    await p.click('[data-hubp-dlg="yes"]');
    await p.waitForSelector('[data-hubp-state="unlinked"]');
    expect(puts).toEqual([{ hub: null }]);
    await p.context().close();
  }, 60_000);

  it("linked, the only project: no 'no Hub projects yet' (the 0.4.39 gate)", async () => {
    if (skip()) return;
    const { p } = await page(() => ({
      ok: true,
      project: "north",
      hub: BACK,
      connected: true,
      suggestions: [],
      projects: [BACK],
    }));
    const text = await rowText(p);
    expect(text).toContain("Linked when this install connected to Hub.");
    expect(text).not.toContain("no Hub projects yet");
    expect(text).toContain("no other Hub projects to switch to");
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
        name: "North",
      }),
      "es",
    );
    try {
      const text = await rowText(p);
      expect(text).toContain("Sin vincular.");
      // Issue 271: nothing suggested, so Create is picked.
      expect(await p.inputValue("#hubp-sel")).toBe("__create");
      expect(await p.textContent('#hubp-sel option[value="__create"]')).toBe(
        "Crear un proyecto de Hub llamado North",
      );
      expect(await p.textContent('[data-hubp-action="link"]')).toBe("Crear");
      await p.selectOption("#hubp-sel", BLOG.id);
      expect(await p.textContent('[data-hubp-action="link"]')).toBe("Vincular");
    } finally {
      await setLanguage(p, null);
      await p.context().close();
    }
  }, 60_000);

  const HELD = "http://127.0.0.1:9/acme/held/held_1";
  const ASK = {
    held: "held_1",
    name: "North Star",
    slug: "north-star",
    url: HELD,
    askedAt: "2026-11-17T17:00:00.000Z",
    by: "person",
  };
  const NORTH = { id: "proj_north1", slug: "north-star", name: "North Star" };

  /** Hub with no projects; `after` is what Hub says once asked. */
  const creating = (owner: boolean, after: () => Record<string, unknown>) => {
    let asked = false;
    return (method: string, body: unknown) => {
      if (method === "CREATE") {
        asked = true;
        return {
          ok: true,
          project: "north",
          ask: { ...ASK, name: (body as { name: string }).name },
        };
      }
      return {
        ok: true,
        project: "north",
        hub: null,
        connected: true,
        suggestions: [],
        projects: [],
        name: "North",
        owner,
        company: "Acme Co",
        create: null,
        ...(asked ? after() : {}),
      };
    };
  };

  it("issue 271: Create, named as typed; an owner gets Hub's Allow in the row; linked once allowed", async () => {
    if (skip()) return;
    let allowed = false;
    const { p, puts } = await page(
      creating(true, () =>
        allowed ? { hub: NORTH, create: null } : { create: ASK },
      ),
    );
    // No Hub projects yet: Create is the one option, picked, with the name.
    expect(await rowText(p)).not.toContain("no Hub projects yet");
    expect(
      await p.$$eval("#hubp-sel option", (os) => os.map((o) => o.textContent)),
    ).toEqual(["Create a Hub project named North"]);
    expect(await p.inputValue("#hubp-new")).toBe("North");
    expect(await p.textContent('[data-hubp-action="link"]')).toBe("Create");
    // The name is editable; the option says the new one.
    await p.fill("#hubp-new", "North Star");
    expect(await p.textContent('#hubp-sel option[value="__create"]')).toBe(
      "Create a Hub project named North Star",
    );
    expect(await fits(p)).toBeLessThanOrEqual(0);
    // An empty name isn't sent.
    await p.fill("#hubp-new", "  ");
    await p.click('[data-hubp-action="link"]');
    expect(await p.textContent("[data-hubp] .rt-err")).toBe(
      "Type a name for the Hub project.",
    );
    await p.fill("#hubp-new", "North Star");
    await p.click('[data-hubp-action="link"]');
    // The working pop-up while Hub is asked.
    await p.waitForSelector('dialog.bz-dlg[open][data-state="working"]', {
      timeout: 5000,
    });
    await p.waitForSelector('[data-hubp-state="creating"]', {
      timeout: 15_000,
    });
    expect(puts).toEqual([{ create: { name: "North Star" } }]);
    const text = await rowText(p);
    expect(text).toContain(
      "Den asked Hub to create the Hub project North Star for north.",
    );
    expect(text).toContain("You're an owner in Hub.");
    expect(await p.getAttribute("[data-hubp-allow]", "href")).toBe(HELD);
    expect(await p.getAttribute("[data-hubp-allow]", "target")).toBe("_blank");
    expect(await p.textContent("[data-hubp-allow]")).toBe("Allow in Hub");
    expect(await fits(p)).toBeLessThanOrEqual(0);
    // The owner allows it in Hub: the row links on its own.
    allowed = true;
    await p.waitForSelector('[data-hubp-state="linked"]', { timeout: 20_000 });
    expect(await p.textContent("[data-hubp-name]")).toBe(
      "North Star (north-star)",
    );
    await p.context().close();
  }, 90_000);

  it("issue 271: not an owner: says who must allow it, no Allow button", async () => {
    if (skip()) return;
    const { p } = await page(creating(false, () => ({ create: ASK })));
    await p.click('[data-hubp-action="link"]');
    await p.waitForSelector('[data-hubp-state="creating"]', {
      timeout: 15_000,
    });
    expect(await rowText(p)).toContain(
      "An owner of Acme Co in Hub must allow it. Den links north on its own when they do.",
    );
    expect(await p.$("[data-hubp-allow]")).toBeNull();
    await p.context().close();
  }, 60_000);

  it("issue 271: declined in Hub: says so, and Create is offered again", async () => {
    if (skip()) return;
    const { p } = await page(() => ({
      ok: true,
      project: "north",
      hub: null,
      connected: true,
      suggestions: [],
      projects: [BLOG],
      name: "North",
      owner: false,
      company: "Acme Co",
      create: { ...ASK, outcome: "declined" },
    }));
    expect(await p.getAttribute("[data-hubp]", "data-hubp-state")).toBe(
      "unlinked",
    );
    expect(await rowText(p)).toContain(
      "An owner in Hub declined the Hub project North Star.",
    );
    expect(await p.inputValue("#hubp-sel")).toBe("__create");
    await p.context().close();
  }, 60_000);

  it("issue 271: in Japanese, Create and the wait are Japanese", async () => {
    if (skip()) return;
    const { p } = await page(
      creating(false, () => ({ create: ASK })),
      "ja",
    );
    try {
      expect(await p.textContent('#hubp-sel option[value="__create"]')).toBe(
        "Hub プロジェクト「North」を作成",
      );
      await p.click('[data-hubp-action="link"]');
      await p.waitForSelector('[data-hubp-state="creating"]', {
        timeout: 15_000,
      });
      expect(await rowText(p)).toContain("Acme Co");
      expect(await rowText(p)).not.toContain("must allow it");
    } finally {
      await setLanguage(p, null);
      await p.context().close();
    }
  }, 60_000);

  it("waiting for a pick: says nothing is filed, and opens Unclear matches", async () => {
    if (skip()) return;
    const { p, puts } = await page(() => ({
      ok: true,
      project: "north",
      hub: null,
      pick: true,
      connected: true,
      suggestions: [
        { ...BACK, why: "repo" },
        { ...BLOG, why: "repo" },
      ],
      projects: [BLOG, BACK],
    }));
    expect(await p.getAttribute("[data-hubp]", "data-hubp-state")).toBe("pick");
    expect(await rowText(p)).toContain(
      "nothing is filed for north until you pick one",
    );
    expect(
      await p.getAttribute('[data-hubp] a[href^="/settings#agents"]', "href"),
    ).toBe("/settings#agents.hub_link_all");
    expect(puts).toEqual([]);
    expect(await fits(p)).toBeLessThanOrEqual(0);
    await p.context().close();
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
      "/settings?project=north#workspace",
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
