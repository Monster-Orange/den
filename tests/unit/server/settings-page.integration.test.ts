/**
 * The Settings page (R21, 0.3.0-dev.19) against a real server on a fixture
 * distribution, in a real browser.
 *
 * Writes go only to per-user, gitignored state: config/local/user.yml
 * (POST /api/settings) and config/local/workspaces.yml (POST
 * /api/workspaces/settings). Nothing writes except an explicit change:
 * loading the page, searching, moving between categories, changing the
 * hash or the query, reload and back/forward write nothing at all (no
 * POST, no file). A user setting changes only user.yml; the workspace
 * editor (on change) only workspaces.yml; the distribution's tracked config
 * never.
 *
 * Also: the search is labelled and / focuses it; the categories are a nav
 * with aria-current; the count is announced; every control has a name;
 * distribution rows are read-only with their file named; the old entry
 * points land on the matching category.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import type { Browser, Page } from "playwright";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = process.cwd();
const PORT = 23876 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let tmp: string;
let dist: string;
let server: ChildProcess | null = null;
let browser: Browser | null = null;

const USER_YML = path.join("dist", "config", "local", "user.yml");
const WS_YML = path.join("dist", "config", "local", "workspaces.yml");
const TRACKED = [
  path.join("dist", "den.yml"),
  path.join("dist", "config", "den.yml"),
];

function get(p: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE}${p}`, (res) => {
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          location: res.headers.location,
        });
      })
      .on("error", reject);
  });
}

/** Every file under tmp → sha256. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile())
        out[path.relative(tmp, abs)] = createHash("sha256")
          .update(fs.readFileSync(abs))
          .digest("hex");
    }
  };
  walk(tmp);
  return out;
}
const changedSince = (before: Record<string, string>) => {
  const after = snapshot();
  return Object.keys({ ...before, ...after })
    .filter((f) => before[f] !== after[f])
    .sort();
};

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-set-")));
  dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "home"));
  fs.mkdirSync(path.join(tmp, "repos", "shop"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "repos", "shop", ".den.yml"),
    "name: shop\nservices:\n  web: {}\n",
  );
  fs.writeFileSync(
    path.join(dist, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\n",
  );
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(dist, "config", "den.yml"),
    yaml.stringify({
      brand: { name: "Acme", theme: "den" },
      github_org: "acme-corp",
      orgs: { "acme-corp": { label: "Acme" }, globex: {} },
      web: { port: 18888 },
      environments: ["local", "dev"],
      edge: { org: "acme", domain: "acme.test" },
    }),
  );
  fs.writeFileSync(
    path.join(dist, "config", "local", "user.yml"),
    yaml.stringify({ editor: "vim" }),
  );
  fs.writeFileSync(
    path.join(dist, "config", "local", "workspaces.yml"),
    yaml.stringify({
      active: ["ws-a", "ws-b"],
      focus: "ws-a",
      workspaces: {
        // One service, so the workspace view shows its tabs.
        "ws-a": {
          services: {
            shop: {
              mode: "dev-managed",
              path: path.join(tmp, "repos", "shop"),
            },
          },
          editor: "vim",
        },
        "ws-b": { services: {} },
      },
    }),
  );
  server = spawnServer(
    process.execPath,
    [
      path.join(ENGINE, "node_modules", ".bin", "tsx"),
      path.join(ENGINE, "src", "ui", "server", "index.ts"),
    ],
    {
      cwd: dist,
      env: {
        ...process.env,
        DEN_ROOT: dist,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        PORT: String(PORT),
        DEN_NO_OPEN: "1",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      if ((await get("/api/server-info")).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start within 20s");
}, 40_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server ?? undefined);
  server = null;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** A page on /settings that records every POST it sends. */
async function open(
  url = "/settings",
): Promise<{ p: Page; posts: { url: string; body: unknown }[] }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const p = await ctx.newPage();
  const posts: { url: string; body: unknown }[] = [];
  p.on("request", (r) => {
    if (r.method() !== "GET" && r.method() !== "HEAD")
      posts.push({
        url: new URL(r.url()).pathname,
        body: JSON.parse(r.postData() ?? "null"),
      });
  });
  // What's new would open over the page on a first visit.
  await p.route("**/api/changelog", (r) => r.fulfill({ json: [] }));
  await p.goto(BASE + url);
  await p.waitForSelector("#set-body section");
  return { p, posts };
}

/** Chrome's accessible names for the page's form controls. */
async function controlNames(p: Page): Promise<[string, string][]> {
  const cdp = await p.context().newCDPSession(p);
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes: {
      ignored?: boolean;
      role?: { value?: string };
      name?: { value?: string };
    }[];
  };
  await cdp.detach();
  const roles = [
    "button",
    "radio",
    "checkbox",
    "combobox",
    "spinbutton",
    "searchbox",
    "textbox",
  ];
  return nodes
    .filter((n) => !n.ignored && roles.includes(n.role?.value ?? ""))
    .map((n) => [n.role!.value!, String(n.name?.value ?? "")]);
}

const sectionIds = (p: Page) =>
  p.$$eval("#set-body section", (s) =>
    s.map((x) => (x as HTMLElement).dataset.cat),
  );

describe("the Settings page writes only what you change (R21)", () => {
  it("loading, searching, categories, hash, query, reload and back/forward write nothing", async () => {
    if (!browser) return;
    await new Promise((r) => setTimeout(r, 500)); // start-up writes settle
    const before = snapshot();
    const { p, posts } = await open();

    // The page header, the labelled search, the category nav.
    expect(await p.textContent(".ph h1")).toBe("Settings");
    const q = p.getByRole("searchbox", { name: "Search settings" });
    expect(await q.count()).toBe(1);
    const nav = p.getByRole("navigation", { name: "Settings categories" });
    expect(await nav.count()).toBe(1);
    expect(
      await nav.locator('[aria-current="true"]').getAttribute("data-cat"),
    ).toBe("appearance");
    expect(await sectionIds(p)).toEqual([
      "appearance",
      "editor",
      "navigation",
      "graph",
      "workspace",
      "agents",
      "access",
      "cli",
      "distribution",
    ]);

    // Search: matches stay under their headings, the count is announced,
    // the URL keeps ?q=.
    expect(await p.getAttribute("#set-count", "aria-live")).toBe("polite");
    await q.fill("terminal");
    expect(await sectionIds(p)).toEqual(["editor", "cli"]);
    expect(await p.textContent("#set-count")).toBe("2 settings match");
    expect(new URL(p.url()).searchParams.get("q")).toBe("terminal");
    expect(
      await p.$$eval("#cat-editor .set-row", (r) =>
        r.map((x) => (x as HTMLElement).dataset.setting),
      ),
    ).toEqual(["terminal"]);
    await q.fill("zzzz-nothing");
    expect(await p.textContent("#set-count")).toBe("No settings match");
    expect(await p.isVisible("#set-empty")).toBe(true);
    await p.click("#set-empty [data-clear]");
    expect(await q.inputValue()).toBe("");
    expect(new URL(p.url()).searchParams.has("q")).toBe(false);

    // `/` focuses the search from anywhere but a field.
    await p.click(".ph h1");
    await p.keyboard.press("/");
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("set-q");

    // Categories: the hash, aria-current, back/forward, reload.
    await nav.getByRole("link", { name: "Graph" }).click();
    expect(new URL(p.url()).hash).toBe("#graph");
    expect(
      await nav.locator('[aria-current="true"]').getAttribute("data-cat"),
    ).toBe("graph");
    await p.goto(`${BASE}/settings?q=dark#appearance`);
    await p.waitForSelector("#set-body section");
    expect(await q.inputValue()).toBe("dark");
    expect(await sectionIds(p)).toEqual(["appearance"]);
    await p.goBack();
    await p.waitForSelector("#set-body section");
    expect(new URL(p.url()).hash).toBe("#graph");
    expect(await q.inputValue()).toBe("");
    await p.goForward();
    await p.waitForSelector("#set-body section");
    expect(await q.inputValue()).toBe("dark");
    await p.evaluate(() => {
      location.hash = "#editor";
    });
    await p.waitForTimeout(100);
    await p.reload();
    await p.waitForSelector("#set-body section");
    expect(await q.inputValue()).toBe("dark");

    // The Workspace asker (View is All active) chooses, never writes.
    await q.fill("");
    await p.selectOption("#set-ws", "ws-b");
    await p.waitForTimeout(200);

    await p.waitForTimeout(300);
    expect(posts).toEqual([]);
    expect(changedSince(before)).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("a user setting changes only config/local/user.yml; the workspace editor only workspaces.yml", async () => {
    if (!browser) return;
    const { p, posts } = await open("/settings#graph");
    let before = snapshot();
    const tracked = TRACKED.map((f) => before[f]);

    // A user setting: the graph's direction (a segmented control).
    const dir = p.locator('[data-setting="graph.direction"]');
    await dir.getByRole("button", { name: "Left to right" }).click();
    await dir.locator(".set-saved", { hasText: "✓ Saved" }).waitFor();
    expect(posts).toEqual([
      { url: "/api/settings", body: { graph: { direction: "right" } } },
    ]);
    expect(changedSince(before)).toEqual([USER_YML]);
    expect(
      (
        yaml.parse(fs.readFileSync(path.join(tmp, USER_YML), "utf-8")) as {
          graph: unknown;
        }
      ).graph,
    ).toEqual(expect.objectContaining({ direction: "right" }));
    expect(
      await dir
        .getByRole("button", { name: "Left to right" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    // Navigation: hide a page (user.yml's shell block only); the rail follows.
    before = snapshot();
    posts.length = 0;
    const pages = p.locator('[data-setting="shell.pages"]');
    await pages.getByRole("button", { name: "Hide Tests" }).click();
    await pages.locator(".set-saved", { hasText: "✓ Saved" }).waitFor();
    expect(posts).toEqual([
      { url: "/api/settings", body: { shell: { hidden: ["tests"] } } },
    ]);
    expect(await p.$$('.den-rail [data-nav="tests"]')).toHaveLength(0);
    expect(changedSince(before)).toEqual([USER_YML]);

    // The workspace editor saves on change, like every other row, for
    // the workspace the asker names (the focus, ws-a). No Save button.
    before = snapshot();
    posts.length = 0;
    const ws = p.locator('[data-setting="workspace.editor"]');
    expect(await p.inputValue("#set-ws")).toBe("ws-a");
    expect(await ws.locator(".set-scope").textContent()).toBe(
      "Workspace · ws-a",
    );
    expect(await ws.getByRole("button", { name: "Save" }).count()).toBe(0);
    await ws.getByRole("radio", { name: /^Default/ }).check();
    await ws.locator(".set-saved", { hasText: "✓ Saved" }).waitFor();
    expect(posts).toEqual([
      {
        url: "/api/workspaces/settings",
        body: { workspace: "ws-a", editor: null },
      },
    ]);
    expect(changedSince(before)).toEqual([WS_YML]);
    const wsFile = yaml.parse(
      fs.readFileSync(path.join(tmp, WS_YML), "utf-8"),
    ) as { workspaces: Record<string, { editor?: string }> };
    expect(wsFile.workspaces["ws-a"].editor).toBeUndefined();

    // The distribution's tracked config never changed.
    const now = snapshot();
    expect(TRACKED.map((f) => now[f])).toEqual(tracked);
    await p.context().close();
  }, 60_000);
});

describe("the Settings page's rows (R21)", () => {
  it("distribution rows are read-only and name the file; every row shows its scope", async () => {
    if (!browser) return;
    const { p } = await open("/settings#distribution");
    const rows = p.locator('#set-body .set-row[data-scope="distribution"]');
    expect(await rows.count()).toBeGreaterThanOrEqual(6);
    // No control that could write: an <output>, never an input or a button.
    expect(await rows.locator("input, select, button, textarea").count()).toBe(
      0,
    );
    const brand = p.locator('[data-setting="distribution.brand"]');
    expect(await brand.locator("output").textContent()).toBe("Acme");
    expect(await brand.locator(".d").textContent()).toContain(
      "Set by the distribution in config/den.yml.",
    );
    expect(await brand.locator(".set-scope").textContent()).toBe(
      "Distribution · read-only",
    );
    expect(
      await p
        .locator('[data-setting="distribution.orgs"] output')
        .textContent(),
    ).toBe("acme-corp: Acme, globex: globex");
    // The org default theme is a distribution row; your pick is a user row.
    expect(
      await p
        .locator('[data-setting="appearance.org-theme"] .set-scope')
        .textContent(),
    ).toBe("Distribution · read-only");
    expect(
      await p
        .locator('[data-setting="appearance.theme"] .set-scope')
        .textContent(),
    ).toBe("User");
    const scopes = await p.$$eval("#set-body .set-row", (r) =>
      r.map((x) => (x as HTMLElement).dataset.scope),
    );
    expect(
      scopes.every((s) => ["user", "workspace", "distribution"].includes(s!)),
    ).toBe(true);
    await p.context().close();
  }, 30_000);

  it("every control is a named form element; the theme shows its swatches", async () => {
    if (!browser) return;
    const { p } = await open();
    const unnamed = (await controlNames(p)).filter(([, n]) => !n.trim());
    expect(unnamed).toEqual([]);
    expect(await p.$$("#set-body .swatches .sw")).toHaveLength(7);
    // Mode is a group of pressed buttons named by its label.
    expect(
      await p.getByRole("group", { name: "Mode" }).getByRole("button").count(),
    ).toBe(3);
    await p.context().close();
  }, 30_000);

  it("each entry point, clicked, shows its category with focus on the heading; the rail lands at the top", async () => {
    if (!browser) return;
    // Old bookmarks: redirected by the server, before any page loads.
    expect(await get("/local-dev?settings=1")).toEqual({
      status: 302,
      location: "/settings#editor",
    });
    // `null`: plain /settings. You land at the top, on the title and the
    // search box, with Appearance current and nothing scrolled or focused.
    const entries: [string, (p: Page) => Promise<void>, string | null][] = [
      [
        "the rail's Settings item",
        (p) => p.click('.den-rail [data-nav="settings"]'),
        null,
      ],
      [
        '"All settings" in the user menu (◐ ▾)',
        async (p) => {
          await p.click(".appearance-btn");
          await p
            .locator(".den-pop")
            .getByRole("menuitem", { name: "All settings" })
            .click();
        },
        "appearance",
      ],
      // (The list's ⚙ footer is gone, R24b; the workspace's Settings tab
      // moved into its ⋯ menu, R24c.)
      [
        "Workspace settings in the workspace's ⋯ menu",
        async (p) => {
          await p.click('#content .ws-more [data-action="toggle-svc-menu"]');
          await p
            .locator("#ws-more-menu")
            .getByRole("menuitem", { name: "Workspace settings" })
            .click();
        },
        "workspace",
      ],
      [
        "an old /local-dev?settings=1 link",
        async (p) => {
          await p.goto(BASE + "/local-dev?settings=1");
        },
        "editor",
      ],
    ];
    for (const [name, act, cat] of entries) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      const p = await ctx.newPage();
      await p.route("**/api/changelog", (r) => r.fulfill({ json: [] }));
      await p.goto(BASE + "/local-dev");
      await p.waitForSelector(".den-rail .den-ni");
      await p.waitForSelector("#ws-open-graph");
      await act(p);
      await p.waitForURL(/\/settings(\?|#|$)/, { timeout: 5000 });
      await p.waitForSelector("#set-body section");
      const landed = await p
        .waitForFunction(
          (c) => {
            const current = (id: string) =>
              document
                .querySelector(`#set-nav [data-cat="${id}"]`)
                ?.getAttribute("aria-current") === "true";
            if (c) return document.activeElement?.id === `h-${c}` && current(c);
            const bar = document.querySelector(".den-top")!;
            const q = document.getElementById("set-q")!;
            return (
              current("appearance") &&
              document.getElementById("den-content")!.scrollTop === 0 &&
              q.getBoundingClientRect().top >=
                bar.getBoundingClientRect().bottom &&
              !document.activeElement?.id?.startsWith("h-")
            );
          },
          cat,
          { timeout: 3000 },
        )
        .then(() => "ok")
        .catch(async () =>
          JSON.stringify(
            await p.evaluate(() => ({
              url: location.pathname + location.search + location.hash,
              scrollTop: document.getElementById("den-content")?.scrollTop,
              focus: document.activeElement?.id,
              current: document
                .querySelector('#set-nav [aria-current="true"]')
                ?.getAttribute("data-cat"),
            })),
          ),
        );
      expect({ name, landed }).toEqual({ name, landed: "ok" });
      expect(await p.locator(".ph h1").textContent()).toBe("Settings");
      await ctx.close();
    }
    // The rail marks the page; the user menu's All settings, on the page,
    // moves to Appearance.
    const { p } = await open("/settings#editor");
    expect(
      await p.getAttribute('.den-rail [data-nav="settings"]', "aria-current"),
    ).toBe("page");
    await p.click(".appearance-btn");
    await p
      .locator(".den-pop")
      .getByRole("menuitem", { name: "All settings" })
      .click();
    await p.waitForFunction(
      () => document.activeElement?.id === "h-appearance",
      undefined,
      { timeout: 3000 },
    );
    await p.context().close();
  }, 90_000);
});

describe("the current category (SA's dev.20 run)", () => {
  it("#distribution, or a click on the last short section, marks it current after the scroll settles", async () => {
    if (!browser) return;
    const current = (p: Page) =>
      p.evaluate(
        () =>
          document
            .querySelector('#set-nav [aria-current="true"]')
            ?.getAttribute("data-cat") ?? null,
      );
    const last = async (p: Page) => (await sectionIds(p)).at(-1)!;
    const { p } = await open("/settings#distribution");
    await p.waitForTimeout(600);
    expect(await current(p)).toBe(await last(p));
    // A click on the one before, then the last: each wins over the spy.
    const ids = await sectionIds(p);
    for (const id of [ids.at(-2)!, ids.at(-1)!]) {
      await p.click(`#set-nav [data-cat="${id}"]`);
      await p.waitForTimeout(900);
      expect({ id, current: await current(p) }).toEqual({ id, current: id });
    }
    await p.context().close();
  }, 30_000);
});

describe("aria-current holds your pick while the page scrolls (SA's dev.21 run)", () => {
  it("a click or Enter on a category marks only it during the smooth scroll, then the spy resumes", async () => {
    if (!browser) return;
    const { p } = await open("/settings");
    const ids = await sectionIds(p);
    // Record every category marked current from now on.
    const watch = () =>
      p.evaluate(() => {
        const w = window as unknown as { marks: string[] };
        w.marks = [];
        const nav = document.getElementById("set-nav")!;
        new MutationObserver(() => {
          const cur = nav
            .querySelector('[aria-current="true"]')
            ?.getAttribute("data-cat");
          if (cur && w.marks.at(-1) !== cur) w.marks.push(cur);
        }).observe(nav, {
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-current"],
        });
      });
    const marks = () =>
      p.evaluate(() => (window as unknown as { marks: string[] }).marks);
    const settled = () =>
      p.waitForFunction(
        () => {
          const w = window as unknown as { y?: number; still?: number };
          const y = document.getElementById("den-content")!.scrollTop;
          w.still = w.y === y ? (w.still ?? 0) + 1 : 0;
          w.y = y;
          return w.still > 6;
        },
        undefined,
        { polling: 100, timeout: 5000 },
      );
    // From the top, a click on a category far down the page: the scroll
    // passes every one between, and none of them is marked.
    const far = ids.at(-2)!;
    await watch();
    await p.click(`#set-nav [data-cat="${far}"]`);
    await settled();
    expect(await marks()).toEqual([far]);
    // Back up with Enter on the first: the same.
    await watch();
    await p.focus(`#set-nav [data-cat="${ids[0]}"]`);
    await p.keyboard.press("Enter");
    await settled();
    expect(await marks()).toEqual([ids[0]]);
    // Then the spy is back: a scroll of your own moves aria-current.
    await watch();
    await p.evaluate((id) => {
      document.getElementById(`cat-${id}`)!.scrollIntoView({ block: "start" });
    }, ids[2]);
    await settled();
    expect((await marks()).at(-1)).toBe(ids[2]);
    await p.context().close();
  }, 30_000);
});

describe("R21a (Ward QA 2026-11-05): the search and the category list stay put", () => {
  it("scrolled to the foot, the search box and the categories are still in view, below the bar, and the search still clicks", async () => {
    if (!browser) return;
    const { p } = await open("/settings");
    const at = () =>
      p.evaluate(() => {
        const r = (id: string) =>
          document.getElementById(id)!.getBoundingClientRect();
        const box = r("den-content");
        return {
          scroll: document.getElementById("den-content")!.scrollTop,
          top: Math.round(box.top),
          q: Math.round(r("set-q").top),
          qBottom: Math.round(r("set-q").bottom),
          ph: Math.round(
            document.querySelector(".ph")!.getBoundingClientRect().bottom,
          ),
          nav: Math.round(r("set-nav").top),
          navBottom: Math.round(r("set-nav").bottom),
        };
      });
    const t0 = await at();
    await p.evaluate(() => {
      const c = document.getElementById("den-content")!;
      c.scrollTop = c.scrollHeight;
    });
    await p.waitForTimeout(300);
    const t1 = await at();
    expect(t1.scroll).toBeGreaterThan(300);
    // The search: in view, below the top bar, where it was (within the
    // content's 20px padding).
    expect(t1.q).toBeGreaterThanOrEqual(t1.top);
    expect(Math.abs(t1.q - t0.q)).toBeLessThanOrEqual(20);
    // The categories: in view, below the header, not under it.
    expect(t1.nav).toBeGreaterThanOrEqual(t1.ph);
    expect(t1.navBottom).toBeLessThanOrEqual(900);
    // Nothing covers the search: a real click types into it.
    await p.click("#set-q");
    await p.keyboard.type("dock");
    await p.waitForFunction(
      () => !!document.querySelector('#set-body [data-setting="shell.dock"]'),
    );
    await p.context().close();
  }, 30_000);
});

describe("one h1 per page (the brand is not a heading)", () => {
  it("/settings and /services each have exactly one h1, the page's own, in main", async () => {
    if (!browser) return;
    for (const [url, title] of [
      ["/settings", "Settings"],
      ["/services", "Services"],
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      const p = await ctx.newPage();
      await p.route("**/api/changelog", (r) => r.fulfill({ json: [] }));
      await p.goto(BASE + url);
      await p.waitForSelector(".den-rail .den-ni");
      const h1s = await p.$$eval("h1", (hs) =>
        hs.map((h) => ({
          text: (h.textContent ?? "").trim(),
          inMain: !!h.closest("#den-content"),
        })),
      );
      expect({ url, h1s }).toEqual({
        url,
        h1s: [{ text: title, inMain: true }],
      });
      // The brand title is still drawn, as text.
      expect(await p.locator(".den-top .den-title").count()).toBe(1);
      await ctx.close();
    }
  }, 30_000);
});
