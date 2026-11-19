/**
 * R26a's 422 page in a real browser (0.3.0-dev.40): a page navigation with
 * a config that fails validation gets the shell frame with "Config is
 * invalid", each problem (file, key path, message), `<cli> validate` and
 * "Reload once fixed". The rail stays usable: Settings and Logs load, and
 * the shell's own calls on them (prefs, themes, scope, the server log)
 * answer, not 422. In ja and es too.
 *
 * The real server (helpers/error-frame-server.ts: a minimal env, failing
 * shims for external tools). Invented orgs only.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as path from "path";
import type { Browser, Page, Request } from "playwright";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";

let s: FrameServer | null = null;
let browser: Browser | null = null;

const INVALID = [
  "environments: [local]",
  "orgs:",
  "  acme:",
  "    sources: not-a-list",
  "  globex:",
  "    repos: nope",
  "",
].join("\n");

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS=ws://localhost:<port>/ uses a browser behind a Playwright
    // run-server (its localhost is this machine's: exposeNetwork).
    browser = process.env.DEN_PW_WS
      ? await chromium.connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startFrameServer({ prefix: "den-422-ui-", denConfig: INVALID });
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
    after: () => removeFrameTmp(s),
  });
});

const skip = () => !browser;

/** A page, and every /api answer it got that was 422. */
async function open(
  p: string,
  before?: (page: Page) => Promise<void>,
): Promise<{
  page: Page;
  refused: string[];
  errors: string[];
  settled: () => Promise<void>;
}> {
  const context = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await signIn(context, path.join(s!.tmp, "den-home"), s!.base);
  const page = await context.newPage();
  if (before) await before(page);
  const refused: string[] = [];
  // Uncaught exceptions on the page: messages only.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Every /api call the page has asked and not yet had in full. A stream
  // (text/event-stream) never ends: it counts once its answer starts.
  const pending = new Set<Request>();
  page.on("request", (r) => {
    if (r.resourceType() === "eventsource") return;
    if (new URL(r.url()).pathname.startsWith("/api/")) pending.add(r);
  });
  page.on("response", (r) => {
    if ((r.headers()["content-type"] ?? "").includes("text/event-stream"))
      pending.delete(r.request());
  });
  page.on("requestfinished", (r) => pending.delete(r));
  page.on("requestfailed", (r) => pending.delete(r));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && r.status() === 422)
      refused.push(u.pathname);
  });
  await page.goto(`${s!.base}${p}`);
  await page.waitForSelector(".den-top");
  return { page, refused, errors, settled: () => settle(page, pending) };
}

/**
 * Issue 195: the page has settled. The shell is up, every /api call it
 * asked has its answer, and the page has run what those answers start
 * (a frame and a task later), twice in a row with nothing new asked. As
 * long as the page needs, and no longer (a fixed 1.5 s sleep was both too
 * short for a slow answer and wasted time on a fast one).
 */
async function settle(page: Page, pending: Set<Request>): Promise<void> {
  await page.waitForFunction(
    () => !!(window as unknown as { denShell?: unknown }).denShell,
  );
  const turn = () =>
    page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => setTimeout(() => r(), 0)),
        ),
    );
  for (let quiet = 0; quiet < 2; ) {
    if (pending.size) {
      quiet = 0;
      await Promise.all(
        [...pending].map((r) =>
          r
            .response()
            .then((res) => res?.finished())
            .catch(() => null),
        ),
      );
    }
    await turn();
    quiet = pending.size ? 0 : quiet + 1;
  }
}

describe("a page navigation with an invalid config", () => {
  it("/ is the 422 page: each problem, the validate command, Reload once fixed", async () => {
    if (skip()) return;
    const { page } = await open("/");
    await page.waitForSelector("#den-err-issues");
    expect(await page.textContent("#den-error-page h1")).toBe(
      "Config is invalid",
    );
    expect(await page.locator(".den-rail").count()).toBe(1);
    const rows = await page.$$eval("#den-err-issues tbody tr", (trs) =>
      trs.map((tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent),
      ),
    );
    expect(rows).toEqual([
      [
        "config/den.yml",
        "orgs.acme.sources",
        "must be a list of { host, owner } or { host, group }",
      ],
      ["config/den.yml", "orgs.globex.repos", "must be a list of repo names"],
    ]);
    expect(await page.textContent("#den-err-cmd")).toBe("den validate");
    expect(await page.textContent("#den-err-retry")).toBe("Reload once fixed");
    expect(
      await page.locator('#den-error-page a[href="/settings"]').count(),
    ).toBe(1);
    expect(await page.locator('#den-error-page a[href="/logs"]').count()).toBe(
      1,
    );
    await page.context().close();
  });

  it.each(["/settings", "/logs"])(
    "%s still loads, and the shell's calls on it are not refused",
    async (p) => {
      if (skip()) return;
      const { page, refused, settled } = await open(p);
      // (The health stream keeps the network busy: no "networkidle".)
      await settled();
      // Whatever else the page asks that reads the config fails quietly:
      // no error toast.
      expect(await page.locator(".den-toast-err").count()).toBe(0);
      expect(await page.locator("#den-error-page").count()).toBe(0);
      for (const route of [
        "/api/settings",
        "/api/themes",
        "/api/scope",
        "/api/server-log",
        "/api/server-info",
        "/api/changelog",
        "/api/environments",
      ])
        expect(refused).not.toContain(route);
      // The rail can reach the other one.
      expect(
        await page
          .locator(
            `.den-rail a[href="${p === "/logs" ? "/settings" : "/logs"}"]`,
          )
          .count(),
      ).toBeGreaterThan(0);
      await page.context().close();
    },
  );

  // dev.40: every page threw "envs.map is not a function" once
  // /api/environments answered 422. The sweep: no page throws, and each
  // shows the 422 page or (Settings, Logs) loads.
  it.each([
    "/",
    "/graph",
    "/verify",
    "/test-runs",
    "/services",
    "/environments",
    "/release",
    "/edge",
    "/settings",
    "/logs",
  ])("%s throws nothing", async (p) => {
    if (skip()) return;
    const { page, errors, settled } = await open(p);
    await settled();
    expect(errors).toEqual([]);
    const free = p === "/settings" || p === "/logs";
    expect(await page.locator("#den-error-page").count()).toBe(free ? 0 : 1);
    await page.context().close();
  });

  // Issue 195: "settled" waits for what the page asked, however long that
  // takes. An answer that comes late (here 2.5 s) and makes the page throw
  // is still seen.
  it("a throw after a slow /api answer is still caught", async () => {
    if (skip()) return;
    const { page, errors, settled } = await open("/release", async (pg) => {
      await pg.route("**/api/changelog", async (route) => {
        await new Promise((r) => setTimeout(r, 2_500));
        await route.continue();
      });
      await pg.addInitScript(() => {
        const f = window.fetch.bind(window);
        window.fetch = (input, init) =>
          f(input, init).then((r) => {
            if (String(r.url).includes("/api/changelog"))
              setTimeout(() => {
                throw new Error("late throw");
              }, 0);
            return r;
          });
      });
    });
    await settled();
    expect(errors).toEqual(["late throw"]);
    await page.context().close();
  });

  // 0.4.1 (the config-poll fix): once the shell knows the config is
  // invalid (the 422 page's data, or the server's mark on a page that still
  // loads), it starts none of its config polls and streams, so the console
  // has no "Failed to load resource … 422" lines. The navigation itself is
  // the only 422 a page gets: every /api answer counted here is after it.
  it.each([
    "/",
    "/graph",
    "/verify",
    "/test-runs",
    "/services",
    "/environments",
    "/release",
    "/edge",
    "/settings",
    "/logs",
  ])(
    "%s asks no /api route that answers 422",
    async (p) => {
      if (skip()) return;
      const { page, refused } = await open(p);
      // The shell has booted: its chips are drawn (the sudo chip hidden
      // until a run needs the password, LK-0).
      await page.waitForFunction(
        () => !!(window as unknown as { denShell?: unknown }).denShell,
      );
      await page.waitForSelector("#den-lock .den-lbl-l", { state: "attached" });
      // A poll interval's worth of quiet (the health poll is 5 s): nothing
      // the shell starts later may answer 422 either.
      await page.waitForTimeout(6_000);
      expect(refused).toEqual([]);
      await page.context().close();
    },
    30_000,
  );

  it.each([
    ["ja", "設定が無効です", "直したら再読み込み"],
    ["es", "La configuración no es válida", "Recargar cuando esté corregido"],
  ])("in %s", async (lang, title, reload) => {
    if (skip()) return;
    const set = await s!.req("POST", "/api/settings", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: lang }),
    });
    expect(set.status).toBe(200);
    try {
      const { page } = await open("/");
      await page.waitForSelector("#den-err-issues");
      expect(await page.textContent("#den-error-page h1")).toBe(title);
      expect(await page.textContent("#den-err-retry")).toBe(reload);
      await page.context().close();
    } finally {
      await s!.req("POST", "/api/settings", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: null }),
      });
    }
  });
});
