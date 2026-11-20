/**
 * Issue 402, the model set on 11-18: a pin is (company, project or none,
 * person, item). shell.js and header.js from disk, on a bare page served
 * by a stub origin with two active projects:
 *
 *   alpha  shop, shop/db and common/web
 *   beta   billing/api and common/web
 *
 * and the stored pins (what /api/settings answers, already migrated):
 *   shop@alpha, shop/db@alpha, billing/api@beta, common/web@alpha,
 *   common/web@beta, loose@none.
 *
 * - clause 2: pinning records the project in view; under All, none;
 * - clause 3: a project picked, the rail shows only the pins made for it;
 * - clause 4: All, every pin of this person, whatever its project;
 * - clause 5: one item pinned in two projects is two pins: unpinning in
 *   one leaves the other; ☆/★ follows the project in view, any pin under
 *   All; unpinning under All removes every pin of the item, and its Undo
 *   puts back exactly those;
 * - no project selected by the person (one active project, never picked):
 *   that project's pins and the pins of no project. A pin made under All
 *   stays on the rail and ★ after the other project is archived.
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
import { launchBrowser } from "../helpers/browser.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = await launchBrowser(kind);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

interface Pin {
  item: string;
  project: string | null;
}
const PINS: Pin[] = [
  { item: "shop", project: "alpha" },
  { item: "shop/db", project: "alpha" },
  { item: "billing/api", project: "beta" },
  { item: "common/web", project: "alpha" },
  { item: "common/web", project: "beta" },
  { item: "loose", project: null },
];
const WORKSPACES = {
  workspaces: {
    alpha: { services: { shop: {}, "shop/db": {}, "common/web": {} } },
    beta: { services: { "billing/api": {}, "common/web": {} } },
  },
  active: ["alpha", "beta"],
  focus: "alpha",
};

interface Mounted {
  p: Page;
  /** Every /api/settings save the page sent. */
  saves: { shell: { pins: Pin[] } }[];
  /** What GET /api/scope answers from now on, and the pill repainted. */
  view: (s: string) => Promise<void>;
  /** Archive a project (no longer active), and the pill repainted. */
  archive: (name: string) => Promise<void>;
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
  const saves: Mounted["saves"] = [];
  let view = scope;
  let active = [...WORKSPACES.active];
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
        return json({ ...WORKSPACES, active });
      case "/api/scope":
        return json({
          scope: view,
          focus: "alpha",
          inView: view === "all" ? active : [view],
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
          `<main id="den-content"><button type="button" data-pin-toggle="common/web">?</button></main>` +
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
  const repaint = () =>
    p.evaluate(() =>
      (
        window as unknown as {
          __hdr: { refreshWorkspacePill(): Promise<void> };
        }
      ).__hdr.refreshWorkspacePill(),
    );
  return {
    p,
    saves,
    view: async (s) => {
      view = s;
      await repaint();
    },
    archive: async (name) => {
      active = active.filter((a) => a !== name);
      await repaint();
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

type Shell = {
  denShell: {
    pin(id: string): void;
    unpin(id: string): void;
    isPinned(id: string): boolean;
  };
};
const pin = (p: Page, id: string) =>
  p.evaluate((i) => (window as unknown as Shell).denShell.pin(i), id);
const unpin = (p: Page, id: string) =>
  p.evaluate((i) => (window as unknown as Shell).denShell.unpin(i), id);
const isPinned = (p: Page, id: string) =>
  p.evaluate((i) => (window as unknown as Shell).denShell.isPinned(i), id);
/** The page's ☆/★ toggle for common/web, once it says `want`. */
async function star(p: Page, want: string): Promise<string | null> {
  await p
    .waitForFunction(
      (w) =>
        document
          .querySelector('[data-pin-toggle="common/web"]')
          ?.getAttribute("aria-pressed") === w,
      want,
      { timeout: 5000 },
    )
    .catch(() => {});
  return p.$eval('[data-pin-toggle="common/web"]', (b) =>
    b.getAttribute("aria-pressed"),
  );
}
const last = (m: Mounted) => m.saves[m.saves.length - 1]?.shell?.pins;
/** Waits until the page has sent `n` saves (each is the page's own time). */
async function saved(m: Mounted, n: number) {
  for (let i = 0; i < 50 && m.saves.length < n; i++)
    await m.p.waitForTimeout(100);
  return last(m);
}

for (const name of ["chromium", "webkit"]) {
  describe(`issue 402: pins are (project or none, item) (${name})`, () => {
    it("clause 3: a project picked, the rail shows only the pins made for it", async () => {
      const b = browsers[name];
      if (!b) return;
      const m = await mount(b, "beta");
      expect(await pinsAre(m.p, ["billing/api", "common/web"])).toEqual([
        "billing/api",
        "common/web",
      ]);
      await m.view("alpha");
      expect(await pinsAre(m.p, ["shop", "shop/db", "common/web"])).toEqual([
        "shop",
        "shop/db",
        "common/web",
      ]);
      // Viewing never writes the pins.
      expect(m.saves).toEqual([]);
      await m.p.context().close();
    });

    it("clause 3: the Agents page's ?project= is the project picked", async () => {
      const b = browsers[name];
      if (!b) return;
      const { p } = await mount(b, "all", "/agents?project=beta");
      expect(await pinsAre(p, ["billing/api", "common/web"])).toEqual([
        "billing/api",
        "common/web",
      ]);
      await p.context().close();
    });

    it("clause 4: All shows every pin of this person, whatever its project, each item once", async () => {
      const b = browsers[name];
      if (!b) return;
      const m = await mount(b, "all");
      const all = ["shop", "shop/db", "billing/api", "common/web", "loose"];
      expect(await pinsAre(m.p, all)).toEqual(all);
      await m.p.context().close();
    });

    it("clause 2: pinning records the project in view; under All, none", async () => {
      const b = browsers[name];
      if (!b) return;
      const m = await mount(b, "beta");
      await pinsAre(m.p, ["billing/api", "common/web"]);
      await pin(m.p, "shop");
      expect(await pinsAre(m.p, ["billing/api", "common/web", "shop"])).toEqual(
        ["billing/api", "common/web", "shop"],
      );
      expect(await saved(m, 1)).toEqual([
        ...PINS,
        { item: "shop", project: "beta" },
      ]);
      await m.view("all");
      await pinsAre(m.p, [
        "shop",
        "shop/db",
        "billing/api",
        "common/web",
        "loose",
      ]);
      await pin(m.p, "new/svc");
      expect(await saved(m, 2)).toEqual([
        ...PINS,
        { item: "shop", project: "beta" },
        { item: "new/svc", project: null },
      ]);
      await m.p.context().close();
    });

    it("clause 5: unpinning in one project leaves the other's pin; ☆/★ follows the project in view", async () => {
      const b = browsers[name];
      if (!b) return;
      const m = await mount(b, "alpha");
      await pinsAre(m.p, ["shop", "shop/db", "common/web"]);
      expect(await star(m.p, "true")).toBe("true");
      await unpin(m.p, "common/web");
      expect(await pinsAre(m.p, ["shop", "shop/db"])).toEqual([
        "shop",
        "shop/db",
      ]);
      expect(await saved(m, 1)).toEqual(
        PINS.filter((x) => !(x.item === "common/web" && x.project === "alpha")),
      );
      expect(await star(m.p, "false")).toBe("false");
      expect(await isPinned(m.p, "common/web")).toBe(false);
      // beta's pin of the same item is still there.
      await m.view("beta");
      expect(await pinsAre(m.p, ["billing/api", "common/web"])).toEqual([
        "billing/api",
        "common/web",
      ]);
      expect(await star(m.p, "true")).toBe("true");
      expect(await isPinned(m.p, "common/web")).toBe(true);
      // Under All, ★ for any pin.
      await m.view("all");
      expect(await star(m.p, "true")).toBe("true");
      await m.p.context().close();
    });

    it("clause 5: unpinning under All removes every pin of the item; Undo puts exactly those back", async () => {
      const b = browsers[name];
      if (!b) return;
      const m = await mount(b, "all");
      await pinsAre(m.p, [
        "shop",
        "shop/db",
        "billing/api",
        "common/web",
        "loose",
      ]);
      await unpin(m.p, "common/web");
      expect(
        await pinsAre(m.p, ["shop", "shop/db", "billing/api", "loose"]),
      ).toEqual(["shop", "shop/db", "billing/api", "loose"]);
      expect(await saved(m, 1)).toEqual(
        PINS.filter((x) => x.item !== "common/web"),
      );
      expect(await star(m.p, "false")).toBe("false");
      const undo = m.p.locator(".den-toast .den-tbtn");
      await undo.waitFor({ timeout: 5000 });
      await undo.click();
      expect(await saved(m, 2)).toEqual(PINS);
      expect(await star(m.p, "true")).toBe("true");
      await m.view("beta");
      expect(await pinsAre(m.p, ["billing/api", "common/web"])).toEqual([
        "billing/api",
        "common/web",
      ]);
      await m.p.context().close();
    });

    it("no project selected: one active project never picked shows its pins and the pins of no project", async () => {
      const b = browsers[name];
      if (!b) return;
      const m = await mount(b, "all");
      await pinsAre(m.p, [
        "shop",
        "shop/db",
        "billing/api",
        "common/web",
        "loose",
      ]);
      // X pinned under All, while two projects are active.
      await pin(m.p, "new/svc");
      expect(await saved(m, 1)).toEqual([
        ...PINS,
        { item: "new/svc", project: null },
      ]);
      // beta archived: alpha is the only project, and the person never
      // picked it. X (no project) and the old pin of none stay.
      await m.archive("beta");
      expect(
        await pinsAre(m.p, [
          "shop",
          "shop/db",
          "common/web",
          "loose",
          "new/svc",
        ]),
      ).toEqual(["shop", "shop/db", "common/web", "loose", "new/svc"]);
      expect(await isPinned(m.p, "new/svc")).toBe(true);
      // The person picks alpha: only alpha's pins.
      await m.view("alpha");
      expect(await pinsAre(m.p, ["shop", "shop/db", "common/web"])).toEqual([
        "shop",
        "shop/db",
        "common/web",
      ]);
      expect(await isPinned(m.p, "new/svc")).toBe(false);
      // Archiving never wrote the pins.
      expect(m.saves).toHaveLength(1);
      await m.p.context().close();
    });
  });
}
