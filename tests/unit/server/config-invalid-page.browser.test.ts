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
import type { Browser, Page } from "playwright";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";

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
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startFrameServer({ prefix: "den-422-ui-", denConfig: INVALID });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
  removeFrameTmp(s);
});

const skip = () => !browser;

/** A page, and every /api answer it got that was 422. */
async function open(
  p: string,
): Promise<{ page: Page; refused: string[]; errors: string[] }> {
  const page = await browser!.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const refused: string[] = [];
  // Uncaught exceptions on the page: messages only.
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && r.status() === 422)
      refused.push(u.pathname);
  });
  await page.goto(`${s!.base}${p}`);
  await page.waitForSelector(".den-top");
  return { page, refused, errors };
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
    await page.close();
  });

  it.each(["/settings", "/logs"])(
    "%s still loads, and the shell's calls on it are not refused",
    async (p) => {
      if (skip()) return;
      const { page, refused } = await open(p);
      // (The health stream keeps the network busy: no "networkidle".)
      await page.waitForTimeout(1_500);
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
      await page.close();
    },
  );

  // dev.40: every page threw "envs.map is not a function" once
  // /api/environments answered 422. The sweep: no page throws, and each
  // shows the 422 page or (Settings, Logs) loads.
  it.each([
    "/",
    "/graph",
    "/tests",
    "/services",
    "/environments",
    "/release",
    "/edge",
    "/settings",
    "/logs",
  ])("%s throws nothing", async (p) => {
    if (skip()) return;
    const { page, errors } = await open(p);
    await page.waitForTimeout(1_500);
    expect(errors).toEqual([]);
    const free = p === "/settings" || p === "/logs";
    expect(await page.locator("#den-error-page").count()).toBe(free ? 0 : 1);
    await page.close();
  });

  // 0.4.1 (the config-poll fix): once the shell knows the config is
  // invalid (the 422 page's data, or the server's mark on a page that still
  // loads), it starts none of its config polls and streams, so the console
  // has no "Failed to load resource … 422" lines. The navigation itself is
  // the only 422 a page gets: every /api answer counted here is after it.
  it.each([
    "/",
    "/graph",
    "/tests",
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
      await page.close();
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
      await page.close();
    } finally {
      await s!.req("POST", "/api/settings", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: null }),
      });
    }
  });
});
