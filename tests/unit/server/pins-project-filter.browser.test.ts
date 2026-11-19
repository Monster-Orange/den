/**
 * Issue 402: "If I have pinned a service then when I filter by project,
 * also filter it." shell.js and header.js from disk, on a bare page served
 * by a stub origin with two active projects:
 *
 *   alpha  the repo "shop" (services shop and shop/db)
 *   beta   the repo "billing" (service billing/api)
 *
 * and three pins: "shop", "shop/db" and "billing/api".
 *
 * - the view filtered to beta: the rail's Pinned shows billing/api only;
 * - the view filtered to alpha: shop and shop/db, not billing/api;
 * - the Agents page's own ?project= filters the pins the same way;
 * - All active (the filter cleared): every pin again;
 * - filtering never writes the pins: no save, and isPinned still says yes.
 *
 * Chromium and WebKit. DEN_PW_WS: Den's own Playwright server instead of a
 * local browser. DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { kitAsset, kitPage } from "./helpers/kit-shell.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

const PINS = ["shop", "shop/db", "billing/api"];
const WORKSPACES = {
  workspaces: {
    alpha: { services: { shop: {}, "shop/db": {} } },
    beta: { services: { "billing/api": {} } },
  },
  active: ["alpha", "beta"],
  focus: "alpha",
};

interface Mounted {
  p: Page;
  /** Every /api/settings save the page sent. */
  saves: unknown[];
  /** What GET /api/scope answers from now on. */
  setScope: (s: string) => void;
}

async function mount(
  browser: Browser,
  scope: string,
  pagePath = "/services",
): Promise<Mounted> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  const saves: unknown[] = [];
  let view = scope;
  await p.route("http://den.test/**", async (r) => {
    const url = new URL(r.request().url());
    const method = r.request().method();
    const json = (j: unknown) => r.fulfill({ json: j });
    const kit = kitAsset(url.pathname);
    if (kit) return r.fulfill(kit);
    const file = /^\/([\w-]+\.js)$/.exec(url.pathname);
    if (file && fs.existsSync(path.join(PUBLIC, file[1])))
      return r.fulfill({
        contentType: "text/javascript; charset=utf-8",
        body: fs.readFileSync(path.join(PUBLIC, file[1]), "utf-8"),
      });
    switch (url.pathname) {
      case "/api/settings":
        if (method === "POST") {
          saves.push(JSON.parse(r.request().postData() ?? "null"));
          return json({ ok: true });
        }
        return json({ shell: { pins: PINS, collapsed: false } });
      case "/api/workspaces":
        return json(WORKSPACES);
      case "/api/scope":
        return json({
          scope: view,
          focus: "alpha",
          inView: view === "all" ? ["alpha", "beta"] : [view],
        });
      case "/api/session":
        return json({ csrf: "stub-csrf", actor: null });
      case "/api/health/stream":
        return r.fulfill({
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({ type: "done" })}\n\n`,
        });
      case "/api/health":
      case "/api/environments":
        return json([]);
      case "/theme.css":
        return r.fulfill({ contentType: "text/css", body: "" });
    }
    if (url.pathname.startsWith("/api/")) return json({});
    const page = url.pathname.replace(/^\//, "") || "services";
    return r.fulfill({
      contentType: "text/html; charset=utf-8",
      body: kitPage(
        `<!doctype html><html><head><style>:root { --mono: monospace; --sans: sans-serif; --display: sans-serif; }</style></head><body>` +
          `<div id="den-shell" data-page="${page}"></div><script src="/shell.js"></script>` +
          `<main id="den-content">page</main>` +
          `<script type="module">const h = await import("/header.js"); await h.initWorkspacePill(); window.__hdr = h;</script></body></html>`,
      ),
    });
  });
  await p.goto(`http://den.test${pagePath}`);
  await p.waitForSelector(".den-rail .den-ni");
  // The pill is painted once /api/workspaces and /api/scope answered.
  await p.waitForFunction(
    () => (window as unknown as { __hdr?: object }).__hdr,
  );
  return {
    p,
    saves,
    setScope: (s) => {
      view = s;
    },
  };
}

/** The rail's pinned rows, by their pin id. */
const railPins = (p: Page) =>
  p.$$eval(".den-rail .den-ni[data-pin]", (rows) =>
    rows.map((r) => (r as HTMLElement).dataset.pin),
  );

/** Waits until the rail's pins are `want` (each repaint is the page's own time). */
async function pinsAre(p: Page, want: string[]): Promise<string[]> {
  await p
    .waitForFunction(
      (w) =>
        JSON.stringify(
          [...document.querySelectorAll(".den-rail .den-ni[data-pin]")].map(
            (r) => (r as HTMLElement).dataset.pin,
          ),
        ) === JSON.stringify(w),
      want,
      { timeout: 5000 },
    )
    .catch(() => {});
  return railPins(p);
}

const pinnedHeading = (p: Page) =>
  p.$$eval(".den-rail .den-gh > span", (h) =>
    h.map((e) => e.textContent).includes("Pinned"),
  );

for (const name of ["chromium", "webkit"]) {
  describe(`issue 402: pins follow the project filter (${name})`, () => {
    it("filtered to a project, the rail shows only that project's pins", async () => {
      const b = browsers[name];
      if (!b) return;
      const { p } = await mount(b, "beta");
      expect(await pinsAre(p, ["billing/api"])).toEqual(["billing/api"]);
      await p.context().close();
      const a = await mount(b, "alpha");
      expect(await pinsAre(a.p, ["shop", "shop/db"])).toEqual([
        "shop",
        "shop/db",
      ]);
      await a.p.context().close();
    });

    it("the Agents page's ?project= filters the pins too", async () => {
      const b = browsers[name];
      if (!b) return;
      const { p } = await mount(b, "all", "/agents?project=beta");
      expect(await pinsAre(p, ["billing/api"])).toEqual(["billing/api"]);
      await p.context().close();
    });

    it("clearing the filter shows every pin again; filtering never writes the pins", async () => {
      const b = browsers[name];
      if (!b) return;
      const { p, saves, setScope } = await mount(b, "beta");
      expect(await pinsAre(p, ["billing/api"])).toEqual(["billing/api"]);
      setScope("all");
      await p.evaluate(() =>
        (
          window as unknown as {
            __hdr: { refreshWorkspacePill(): Promise<void> };
          }
        ).__hdr.refreshWorkspacePill(),
      );
      expect(await pinsAre(p, PINS)).toEqual(PINS);
      expect(await pinnedHeading(p)).toBe(true);
      // The pins themselves never changed: no save, and every one is pinned.
      expect(saves).toEqual([]);
      expect(
        await p.evaluate(
          (ids) =>
            ids.map((id) =>
              (
                window as unknown as {
                  denShell: { isPinned(id: string): boolean };
                }
              ).denShell.isPinned(id),
            ),
          PINS,
        ),
      ).toEqual([true, true, true]);
      await p.context().close();
    });

    it("a project with none of the pins hides the Pinned group, and keeps the pins", async () => {
      const b = browsers[name];
      if (!b) return;
      const { p, saves } = await mount(b, "beta");
      await pinsAre(p, ["billing/api"]);
      // From beta, unpin billing/api: alpha's pins stay saved.
      await p.evaluate(() =>
        (
          window as unknown as { denShell: { unpin(id: string): void } }
        ).denShell.unpin("billing/api"),
      );
      expect(await pinsAre(p, [])).toEqual([]);
      expect(await pinnedHeading(p)).toBe(false);
      expect(saves).toEqual([{ shell: { pins: ["shop", "shop/db"] } }]);
      await p.context().close();
    });
  });
}
