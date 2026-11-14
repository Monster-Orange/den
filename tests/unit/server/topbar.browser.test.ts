/**
 * The top bar (0.3.0-dev.20; R5, R6, R7, R8, R10, R15, R17, R18) in a real
 * browser: shell.js and header.js (with topbar.js and appearance.js) from
 * disk, on a bare page served by a stub origin whose API answers are
 * fixed, and every request recorded.
 *
 * - the status chip: one paint per first cycle, never a partial red;
 * - the status drawer: a modal dialog, focus on ✕, Escape back to the
 *   chip; Start through the page's runner, Pin through the shell's prefs;
 * - the ⌘K palette: a modal combobox (aria-activedescendant), ranking,
 *   registered commands (a "setting" row too), focus returned;
 * - the lock chip and its popover (the admin-password form);
 * - the user menu (.pop) and the Runs chip;
 * - criterion 5: opening any of them, or switching appearance from the
 *   palette, writes nothing but the appearance prefs, and never reaches a
 *   service, workspace or edge route. Start and Restart are tested with
 *   stubs only.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Health = {
  repo: string;
  service: string;
  ok: boolean | null;
  url?: string;
  status?: number;
  error?: string;
  ms?: number;
  idx?: number;
  workspaces?: string[];
};
const ROWS: Health[] = [
  {
    repo: "shop",
    service: "shop",
    ok: true,
    url: "http://shop/healthz",
    status: 200,
    ms: 31,
    idx: 0,
  },
  {
    repo: "shop",
    service: "db",
    ok: true,
    url: "http://shop/db",
    status: 200,
    ms: 9,
    idx: 1,
  },
  {
    repo: "billing",
    service: "billing",
    ok: false,
    url: "http://billing/healthz",
    error: "connect ECONNREFUSED",
    idx: 2,
    workspaces: ["ws-a"],
  },
];
const sse = (msgs: unknown[]) =>
  msgs.map((m) => `data: ${JSON.stringify(m)}\n\n`).join("");

interface Opts {
  page?: string;
  rows?: Health[];
  /** The stream breaks after these results (no "done"); /api/health completes. */
  partial?: Health[];
  healthDelay?: number;
  /** The admin password is set (elsewhere, before the page asks). */
  unlocked?: boolean;
  before?: string;
  after?: string;
  width?: number;
  vaultStored?: boolean;
  /** Fields of the vault status to replace (LK-4: no ref, canSave). */
  vault?: Record<string, unknown>;
  /** /api/server-info reports a stale server (the ⚠ pill shows). */
  stale?: boolean;
  /**
   * D64: POST /api/web/restart "restarts" the stub: server-info then fails
   * `down` times (503), then answers as a new server (pid 2).
   */
  restart?: { down: number; waitSeconds?: number };
}

/** A page on a stub origin; records every request. */
async function mount(o: Opts = {}): Promise<{
  p: Page;
  reqs: string[];
  posts: { path: string; body: unknown }[];
  /** The password is set elsewhere (another tab, another device). */
  unlockElsewhere: () => void;
  /** D64: when the stub first answered as the new server (ms), or 0. */
  backAt: () => number;
}> {
  const page = o.page ?? "services";
  const rows = o.rows ?? ROWS;
  const ctx = await browser!.newContext({
    viewport: { width: o.width ?? 1440, height: 800 },
  });
  const p = await ctx.newPage();
  const reqs: string[] = [];
  const posts: { path: string; body: unknown }[] = [];
  let unlocked = o.unlocked ?? false;
  let restarted = false;
  let down = o.restart?.down ?? 0;
  let backAt = 0;
  let prefs = { shell: { pins: [] as string[], collapsed: false } };
  p.on("request", (r) => {
    const u = new URL(r.url());
    if (u.host === "den.test") reqs.push(`${r.method()} ${u.pathname}`);
  });
  await p.route("http://den.test/**", async (r) => {
    const url = new URL(r.request().url());
    const method = r.request().method();
    const body =
      method === "POST" ? JSON.parse(r.request().postData() ?? "null") : null;
    if (method === "POST") posts.push({ path: url.pathname, body });
    const json = (j: unknown, status = 200) => r.fulfill({ status, json: j });
    const file = /^\/([\w-]+\.js)$/.exec(url.pathname);
    if (file && fs.existsSync(path.join(PUBLIC, file[1])))
      return r.fulfill({
        contentType: "text/javascript; charset=utf-8",
        body: fs.readFileSync(path.join(PUBLIC, file[1]), "utf-8"),
      });
    switch (url.pathname) {
      case "/api/health/stream":
        return r.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: o.partial
            ? sse(o.partial.map((x) => ({ type: "result", result: x })))
            : sse([
                ...rows.map((x) => ({ type: "result", result: x })),
                { type: "done" },
              ]),
        });
      case "/api/health":
        if (o.healthDelay)
          await new Promise((res) => setTimeout(res, o.healthDelay));
        return json(rows);
      case "/api/environments":
        return json(["local"]);
      case "/api/applications":
        return json({ applications: [] });
      case "/api/settings":
        if (method === "POST" && (body as { shell?: object }).shell)
          prefs = {
            shell: { ...prefs.shell, ...(body as { shell: object }).shell },
          };
        return json(method === "POST" ? { ok: true } : prefs);
      case "/api/themes":
        return json({
          themes: [
            { id: "den", name: "Den", ok: true },
            { id: "paper", name: "Paper", ok: true },
          ],
          active: {
            id: "den",
            name: "Den",
            default_mode: "dark",
            mark: { text: "D" },
          },
          prefs: { theme: null, mode: "system" },
          org_default: { id: "den", name: "Den" },
        });
      case "/theme.css":
        return r.fulfill({ contentType: "text/css", body: "" });
      case "/api/sudo-password/status":
        return json({ set: unlocked, passwordless: false });
      case "/api/sudo-password/vault-status":
        // The neutral payload (0.3.0-dev.23): the UI reads backend /
        // backendAvailable / label, never the deprecated opAvailable alias.
        return json({
          backend: "1password",
          label: "1Password",
          configured: true,
          backendAvailable: true,
          hasStored: !!o.vaultStored,
          ...o.vault,
        });
      case "/api/sudo-password/load-from-vault":
        if (o.vaultStored) unlocked = true;
        return json({ ok: !!o.vaultStored });
      case "/api/sudo-password": {
        const ok = (body as { password: string }).password === "right";
        if (ok) unlocked = true;
        return ok
          ? json({ ok: true })
          : json({ error: "Incorrect password — try again" }, 401);
      }
      case "/api/service/exec":
        return r.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            url.searchParams.get("cmd") === "done-now"
              ? sse([
                  { type: "line", text: "x" },
                  { type: "done", exitCode: 0 },
                ])
              : sse([{ type: "line", text: "x" }]),
        });
      case "/api/web/restart":
        restarted = true;
        return json({ restarting: true, pid: 1 });
      case "/api/server-info":
        if (restarted && down > 0) {
          down--;
          return json({ error: "down" }, 503);
        }
        if (restarted && !backAt) backAt = Date.now();
        return json({
          version: "0.3.0-dev.20",
          pid: restarted ? 2 : 1,
          startedAt: restarted ? 2 : 1,
          stale: restarted ? false : (o.stale ?? false),
          ...(o.restart?.waitSeconds
            ? { restartWaitSeconds: o.restart.waitSeconds }
            : {}),
        });
      case "/api/changelog":
        return json([]);
      // SEC-1a: the shell's CSRF token, as the server hands it out.
      case "/api/session":
        return json({ csrf: "stub-csrf", actor: null });
    }
    if (url.pathname.startsWith("/api/")) return json({});
    const which =
      url.pathname === "/local-dev"
        ? "local-dev"
        : url.pathname === "/logs"
          ? "logs"
          : page;
    return r.fulfill({
      contentType: "text/html; charset=utf-8",
      body:
        `<!doctype html><html><head><style>:root { --mono: monospace; --sans: sans-serif; --display: sans-serif; --accent: blue; --bad: red; --ok: green; --faint: gray; --border: #888; }</style></head><body>` +
        `${o.before ?? ""}<div id="den-shell" data-page="${which}"></div><script src="/shell.js"></script>` +
        `<main id="den-content"><button id="before">before</button>${o.after ?? ""}</main>` +
        `<script type="module">window.__hdr = await import("/header.js"); window.__hdr.initHealth();</script></body></html>`,
    });
  });
  await p.goto(`http://den.test/${page}`);
  await p.waitForSelector(".den-rail .den-ni");
  await p.waitForFunction(
    () => (window as unknown as { __hdr?: object }).__hdr,
  );
  return {
    p,
    reqs,
    posts,
    unlockElsewhere: () => {
      unlocked = true;
    },
    backAt: () => backAt,
  };
}

/**
 * Palette rows' words, read from their parts: the label, the sub line and
 * the kind, upper-cased here as the stylesheet shows it. innerText follows
 * the CSS, so a row read before the sheet applied read "WorkspacesPage"
 * one run and "Projects PAGE" the next.
 */
const palRows = (p: Page, sel = "#den-pal-list [role=option]") =>
  p.$$eval(sel, (o) =>
    o.map((x) =>
      [...x.querySelectorAll(".den-pal-l, .den-sub, .den-kind")]
        .map((s) => {
          const w = (s.textContent ?? "").replace(/\s+/g, " ").trim();
          return s.classList.contains("den-kind") ? w.toUpperCase() : w;
        })
        .filter(Boolean)
        .join(" "),
    ),
  );
const palRow = async (p: Page, sel: string) => (await palRows(p, sel))[0];
const text = (p: Page, sel: string) =>
  p.$eval(sel, (e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim());
const focused = (p: Page) =>
  p.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a ? a.id || a.getAttribute("aria-label") || a.tagName : null;
  });

describe("narrow (SA's dev.20 run)", () => {
  it("at 400px the bar never scrolls the page sideways: a long name truncates, the stale pill keeps its ⚠", async () => {
    if (!browser) return;
    const { p } = await mount({ width: 400, stale: true });
    await p.waitForSelector("#stale-pill", { state: "visible" });
    await p.$eval(
      ".den-title",
      (e) => (e.textContent = "A Rather Long Platform Name"),
    );
    await p.waitForTimeout(100);
    const m = await p.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      right: Math.round(
        Math.max(
          ...[...document.querySelectorAll(".den-top *")].map(
            (e) => e.getBoundingClientRect().right,
          ),
        ),
      ),
      pill: (
        document.getElementById("stale-pill") as HTMLElement
      ).innerText.trim(),
      name: document.getElementById("stale-pill")!.getAttribute("aria-label"),
    }));
    expect(m).toEqual({
      scroll: 400,
      right: expect.any(Number),
      pill: "⚠",
      name: "Stale server: restart",
    });
    expect(m.right).toBeLessThanOrEqual(400);
    await p.context().close();
  }, 30_000);
});

describe("the status chip (R6)", () => {
  it("paints once, complete: Checking… then the count, never a partial red", async () => {
    if (!browser) return;
    // The stream breaks after one result (billing down, the only one in);
    // /api/health then answers, slowly, with everyone up.
    const all = ROWS.map((r) => ({ ...r, ok: true, error: undefined }));
    const ctx = await mount({
      rows: all,
      partial: [ROWS[2]],
      healthDelay: 600,
      before: `<script>window.__chip = []; new MutationObserver(() => { const c = document.getElementById("den-status"); if (c) window.__chip.push(c.innerText + (c.classList.contains("bad") ? " [bad]" : "")); }).observe(document, { subtree: true, childList: true, characterData: true });</script>`,
    });
    const { p } = ctx;
    await p.waitForFunction(() =>
      /healthy/.test(document.getElementById("den-status")!.innerText),
    );
    const seen = await p.evaluate(() => [
      ...new Set((window as unknown as { __chip: string[] }).__chip),
    ]);
    expect(seen).toEqual(["Checking…", "All 3 healthy"]);
    expect(await p.getAttribute("#den-status", "aria-busy")).toBe("false");
    await p.context().close();
  }, 30_000);

  it('reads "ok/N healthy · k down" with the bad tint, as the rail badge counts', async () => {
    if (!browser) return;
    const { p } = await mount();
    await p.waitForSelector("#den-status.bad");
    expect(await text(p, "#den-status")).toBe("2/3 healthy · 1 down");
    expect(await text(p, '.den-ni[data-nav="services"] .den-bdg')).toBe("1");
    expect(await p.getAttribute("#den-status", "aria-haspopup")).toBe("dialog");
    await p.context().close();
  }, 30_000);

  it("below 860px the chip labels hide and the dots stay", async () => {
    if (!browser) return;
    const { p } = await mount({ width: 820 });
    await p.waitForSelector("#den-status.bad");
    expect(await text(p, "#den-status")).toBe("1 down");
    expect(await text(p, "#den-runs")).toBe("");
    // LK-0: no lock chip; the sudo chip shows only while an ask waits.
    expect(await p.isHidden("#den-lock")).toBe(true);
    expect(await p.isVisible("#den-runs .den-dot")).toBe(true);
    await p.context().close();
  }, 30_000);
});

describe("the status drawer (R15)", () => {
  it("is a modal dialog: focus on ✕, Tab stays in, Escape returns to the chip", async () => {
    if (!browser) return;
    const { p } = await mount();
    await p.waitForSelector("#den-status.bad");
    await p.click("#den-status");
    await p.waitForSelector(".den-drawer");
    expect(await p.getAttribute(".den-drawer", "role")).toBe("dialog");
    expect(await p.getAttribute(".den-drawer", "aria-modal")).toBe("true");
    expect(await p.getAttribute("#den-status", "aria-expanded")).toBe("true");
    expect(await p.isVisible(".den-scrim")).toBe(true);
    expect(await focused(p)).toBe("Close");
    expect(
      await p.$$eval(".den-sec", (h) => h.map((x) => x.textContent)),
    ).toEqual(["Needs attention", "Everything"]);
    expect(await text(p, ".den-prob-card")).toBe(
      "billing billing http://billing/healthz — connect ECONNREFUSED · failed at " +
        (await p.evaluate(() =>
          new Intl.DateTimeFormat(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date()),
        )) +
        " Start Logs Pin",
    );
    expect(
      await p.$$eval(".den-grp", (g) =>
        g.map((x) => (x as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      ),
    ).toEqual([
      // Health order; the heading is upper-cased by CSS.
      "SHOP 2/2 shop/shop 31 ms shop/db 9 ms",
      "BILLING 0/1 billing/billing down",
    ]);
    // What the check said, as the old row's tooltip did.
    expect(
      await p.getAttribute('.den-svl [data-k="svc:shop/db"]', "title"),
    ).toBe("http://shop/db → 200");
    // Named by service, state and latency; the check is the description.
    const named = (id: string) =>
      p.$eval(`.den-svl [data-k="svc:${id}"]`, (b) => [
        b.getAttribute("aria-label"),
        b.getAttribute("aria-description"),
      ]);
    expect(await named("shop/db")).toEqual([
      "shop/db, healthy, 9 ms",
      "http://shop/db → 200",
    ]);
    expect((await named("billing/billing"))[0]).toBe("billing/billing, down");
    for (let i = 0; i < 12; i++) await p.keyboard.press("Tab");
    expect(
      await p.evaluate(() => !!document.activeElement?.closest(".den-drawer")),
    ).toBe(true);
    await p.keyboard.press("Escape");
    expect(await p.$(".den-drawer")).toBeNull();
    expect(await p.$(".den-scrim")).toBeNull();
    expect(await focused(p)).toBe("den-status");
    await p.context().close();
  }, 30_000);

  it("Start goes through the page's runner; Pin through the shell's prefs", async () => {
    if (!browser) return;
    const { p, posts } = await mount({ page: "local-dev" });
    await p.evaluate(() => {
      const w = window as unknown as {
        __runs: unknown[];
        __hdr: { setServiceRunner: (f: unknown) => void };
      };
      w.__runs = [];
      w.__hdr.setServiceRunner((cmd: string, s: unknown) =>
        w.__runs.push([cmd, s]),
      );
    });
    await p.waitForSelector("#den-status.bad");
    await p.click("#den-status");
    await p.click('.den-prob-card [data-pin="billing/billing"]');
    await p.waitForSelector('.den-rail [data-pin="billing/billing"]');
    expect(await text(p, '.den-prob-card [data-pin="billing/billing"]')).toBe(
      "Unpin",
    );
    expect(posts).toContainEqual({
      path: "/api/settings",
      body: { shell: { pins: ["billing/billing"] } },
    });
    await p.click('.den-prob-card [data-start="billing/billing"]');
    expect(await p.$(".den-drawer")).toBeNull();
    expect(
      await p.evaluate(
        () => (window as unknown as { __runs: unknown[] }).__runs,
      ),
    ).toEqual([
      [
        "up",
        {
          repo: "billing",
          service: "billing",
          address: "billing/billing",
          workspaces: ["ws-a"],
        },
      ],
    ]);
    await p.context().close();
  }, 30_000);
});

describe("the ⌘K palette (R17)", () => {
  it("is a modal combobox; ranks; arrows move; Escape gives focus back", async () => {
    if (!browser) return;
    const { p } = await mount();
    await p.waitForSelector("#den-status.bad");
    await p.focus("#before");
    await p.keyboard.press("Control+k");
    await p.waitForSelector(".den-pal");
    expect(await p.getAttribute(".den-pal", "role")).toBe("dialog");
    expect(await p.getAttribute(".den-pal", "aria-modal")).toBe("true");
    const q = "#den-pal-q";
    expect(await focused(p)).toBe("den-pal-q");
    expect(await p.getAttribute(q, "role")).toBe("combobox");
    expect(await p.getAttribute(q, "aria-controls")).toBe("den-pal-list");
    expect(await p.getAttribute("#den-pal-list", "role")).toBe("listbox");
    expect(await p.getAttribute(q, "aria-activedescendant")).toBe(
      "den-pal-o-0",
    );
    // Empty: the pages first.
    expect(await palRow(p, "#den-pal-o-0")).toBe("Projects PAGE");
    await p.keyboard.type("shop");
    expect(await palRows(p)).toEqual([
      "shop/shop SERVICE",
      "shop/db SERVICE",
      "Restart shop/shop ACTION",
      "Logs of shop/shop ACTION",
      "Restart shop/db ACTION",
      "Logs of shop/db ACTION",
      // #80 (0.4.45): a fuzzy match, last ("Sh…o…p" in its label).
      "Show up to this many helpers under an agent SETTING",
    ]);
    await p.keyboard.press("ArrowDown");
    expect(await p.getAttribute(q, "aria-activedescendant")).toBe(
      "den-pal-o-1",
    );
    expect(await p.getAttribute("#den-pal-o-1", "aria-selected")).toBe("true");
    await p.keyboard.press("Tab");
    expect(await focused(p)).toBe("den-pal-q");
    await p.keyboard.press("Escape");
    expect(await p.$(".den-pal")).toBeNull();
    expect(await focused(p)).toBe("before");
    // The search field opens it too.
    await p.click("#den-search");
    await p.waitForSelector(".den-pal");
    await p.keyboard.press("Escape");
    expect(await focused(p)).toBe("den-search");
    await p.context().close();
  }, 30_000);

  it("lists registered commands (denShellQueue, kind setting) and runs one with Enter", async () => {
    if (!browser) return;
    const { p } = await mount({
      before: `<script>window.denShellQueue = [function (sh) { sh.registerCommand({ id: "ide", label: "Default IDE", keywords: ["editor"], kind: "setting", run: function () { window.__ran = "ide"; } }); }];</script>`,
    });
    await p.keyboard.press("Meta+k");
    await p.waitForSelector(".den-pal");
    await p.keyboard.type("editor");
    expect(await palRow(p, "#den-pal-o-0")).toBe("Default IDE SETTING");
    await p.keyboard.press("Enter");
    expect(
      await p.evaluate(() => (window as unknown as { __ran: string }).__ran),
    ).toBe("ide");
    expect(await p.$(".den-pal")).toBeNull();
    // Appearance and Theme are commands too (appearance.js).
    await p.keyboard.press("Control+k");
    await p.keyboard.type("theme paper");
    expect(await palRow(p, "#den-pal-o-0")).toBe("Theme: Paper ACTION");
    await p.context().close();
  }, 30_000);

  it('every SETTINGS row is a palette row: "terminal" finds Default terminal; Enter opens it on /settings', async () => {
    if (!browser) return;
    const { p } = await mount();
    await p.keyboard.press("Meta+k");
    await p.waitForSelector(".den-pal");
    await p.keyboard.type("terminal");
    const opts = () => palRows(p);
    expect(await opts()).toContain("Default terminal SETTING");
    // A distribution's or plugin's own row is one too.
    await p.evaluate(() =>
      (
        window as unknown as {
          denShell: { registerSetting: (r: object) => void };
        }
      ).denShell.registerSetting({
        id: "acme.region",
        category: "distribution",
        label: "Acme region",
        keywords: ["globex", "datacenter"],
        scope: "distribution",
        read: () => "eu",
      }),
    );
    await p.fill("#den-pal-q", "datacenter");
    expect(await palRow(p, "#den-pal-o-0")).toBe("Acme region SETTING");
    await p.fill("#den-pal-q", "default terminal");
    expect(await palRow(p, "#den-pal-o-0")).toBe("Default terminal SETTING");
    await p.keyboard.press("Enter");
    await p.waitForURL(/\/settings\?q=Default%20terminal#editor$/, {
      timeout: 5000,
    });
    await p.context().close();
  }, 30_000);

  it("H4: ⌘/Ctrl-Enter opens any page row in a new tab (pages, settings, a command with an href); a row that only acts just runs; the footer says so", async () => {
    if (!browser) return;
    const { p } = await mount({
      before: `<script>window.denShellQueue = [function (sh) { sh.registerCommand({ id: "h4-act", label: "Zap now", keywords: ["zzap"], run: function () { window.__ran = "act"; } }); sh.registerCommand({ id: "h4-page", label: "Plugin page", keywords: ["qqpage"], href: "/plugin-page", run: function () { location.assign("/plugin-page"); } }); }];</script>`,
    });
    const ctx = p.context();
    // The new tabs' pages, answered here.
    await ctx.route("http://den.test/**", (r) =>
      new URL(r.request().url()).pathname.endsWith(".js") ||
      new URL(r.request().url()).pathname.startsWith("/api/")
        ? r.fallback()
        : r.fulfill({ contentType: "text/html", body: "<title>t</title>t" }),
    );
    const here = p.url();
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    const open = async (q: string) => {
      await p.keyboard.press(`${mod}+k`);
      await p.waitForSelector(".den-pal");
      await p.fill("#den-pal-q", q);
    };
    await open("");
    expect(await p.locator(".den-pal .den-foot").textContent()).toContain(
      `${process.platform === "darwin" ? "⌘" : "Ctrl+"}↵ new tab`,
    );
    const wsHref = await p.evaluate(
      () =>
        (
          window as unknown as {
            denShell: { nav: () => { id: string; href: string }[] };
          }
        ).denShell
          .nav()
          .find((n) => n.id === "local-dev")!.href,
    );
    const cases: [string, string, RegExp][] = [
      [
        "workspaces",
        "Projects PAGE",
        new RegExp(`${wsHref.replace(/[?]/g, "\\?")}$`),
      ],
      [
        "default terminal",
        "Default terminal SETTING",
        /\/settings\?q=Default%20terminal#editor$/,
      ],
      ["qqpage", "Plugin page ACTION", /\/plugin-page$/],
    ];
    for (const [q, row, url] of cases) {
      if (!(await p.$(".den-pal"))) await open(q);
      else await p.fill("#den-pal-q", q);
      expect(await palRow(p, "#den-pal-o-0")).toBe(row);
      const opened = ctx.waitForEvent("page");
      await p.keyboard.press(`${mod}+Enter`);
      const tab = await opened;
      await tab.waitForLoadState();
      expect(tab.url()).toMatch(url);
      await tab.close();
      expect(p.url()).toBe(here);
      expect(await p.$(".den-pal")).toBeNull();
    }
    // A row that only acts: ⌘/Ctrl-Enter runs it, here.
    await open("zzap");
    expect(await palRow(p, "#den-pal-o-0")).toBe("Zap now ACTION");
    await p.keyboard.press(`${mod}+Enter`);
    expect(
      await p.evaluate(() => (window as unknown as { __ran: string }).__ran),
    ).toBe("act");
    expect(ctx.pages()).toHaveLength(1);
    expect(p.url()).toBe(here);
    await ctx.close();
  }, 60_000);

  it("Restart hands the action to Local Dev, asking for nothing first (LK-0)", async () => {
    if (!browser) return;
    const { p, reqs } = await mount();
    await p.waitForSelector("#den-status.bad");
    await p.keyboard.press("Control+k");
    await p.keyboard.type("restart shop/db");
    await Promise.all([
      p.waitForURL("http://den.test/local-dev"),
      p.keyboard.press("Enter"),
    ]);
    await p.waitForFunction(
      () => (window as unknown as { __hdr?: object }).__hdr,
    );
    // No password asked: the server says when sudo needs one.
    expect(reqs.filter((r) => r.includes("/api/sudo-password"))).toEqual([]);
    expect(
      await p.evaluate(() =>
        JSON.parse(sessionStorage.getItem("__DEN_CLI__-pending-action")!),
      ),
    ).toMatchObject({ cmd: "restart", address: "shop/db" });
    expect(
      await p.evaluate(() =>
        (
          window as unknown as { __hdr: { takePendingAction: () => unknown } }
        ).__hdr.takePendingAction(),
      ),
    ).toEqual({ cmd: "restart", address: "shop/db" });
    // Taken once.
    expect(
      await p.evaluate(() =>
        (
          window as unknown as { __hdr: { takePendingAction: () => unknown } }
        ).__hdr.takePendingAction(),
      ),
    ).toBeNull();
    expect(reqs.filter((r) => /\/api\/(service|workspace)/.test(r))).toEqual(
      [],
    );
    await p.context().close();
  }, 30_000);
});

type Need = { command?: string; step?: string };
type Hdr = {
  askSudo: (need?: Need) => Promise<boolean>;
  sudoRun: () => {
    see: (msg: unknown) => boolean;
    done: (retry: () => unknown) => Promise<unknown>;
  };
};
const NEED: Need = { command: "sudo touch /etc/acme-test", step: "shop/db" };

describe("the admin password, asked only when sudo needs it (R8, LK-0)", () => {
  it("no chip on a page view, and no vault; a needs-sudo ask shows the chip and the prompt naming the command", async () => {
    if (!browser) return;
    const { p, posts, reqs } = await mount();
    await p.waitForSelector("#den-status.bad");
    await p.waitForTimeout(200);
    expect(await p.isHidden("#den-lock")).toBe(true);
    // A page view never wakes 1Password, nor asks about the password.
    expect(reqs.filter((r) => r.includes("/api/sudo-password"))).toEqual([]);
    await p.evaluate((n) => {
      const w = window as unknown as { __hdr: Hdr; __asked?: unknown };
      void w.__hdr.askSudo(n).then((ok) => (w.__asked = ok));
    }, NEED);
    await p.waitForSelector("#den-lock-pop form");
    await p.waitForSelector("#den-lock-pop .den-lock-save:not([hidden])");
    expect(reqs.filter((r) => r.includes("vault-status"))).toHaveLength(1);
    expect(await p.isVisible("#den-lock")).toBe(true);
    expect(await text(p, "#den-lock")).toBe("🔑 Admin password needed");
    expect(await p.getAttribute("#den-lock-pop", "role")).toBe("dialog");
    expect(await text(p, "#den-lock-pop")).toBe(
      "sudo touch /etc/acme-test needs your admin password shop/db Save to 1Password Continue Den uses it only for sudo. Agents can't enter it.",
    );
    expect(await focused(p)).toBe("den-lock-pw");
    await p.fill("#den-lock-pw", "wrong");
    await p.click("#den-lock-go");
    await p.waitForSelector("#den-lock-err:not([hidden])");
    expect(await text(p, "#den-lock-err")).toBe(
      "Incorrect password — try again",
    );
    // Escape says no: the ask ends false, and the chip goes.
    await p.keyboard.press("Escape");
    expect(await p.$("#den-lock-pop")).toBeNull();
    await p.waitForFunction(
      () => (window as unknown as { __asked?: unknown }).__asked === false,
    );
    expect(await p.isHidden("#den-lock")).toBe(true);
    // Asked again: the right one, saved to the vault, ends it true.
    await p.evaluate((n) => {
      const w = window as unknown as { __hdr: Hdr; __asked?: unknown };
      void w.__hdr.askSudo(n).then((ok) => (w.__asked = ok));
    }, NEED);
    await p.waitForSelector("#den-lock-pop form");
    await p.check("#den-lock-vault");
    await p.fill("#den-lock-pw", "right");
    await p.keyboard.press("Enter");
    await p.waitForFunction(
      () => (window as unknown as { __asked?: unknown }).__asked === true,
    );
    expect(await p.$("#den-lock-pop")).toBeNull();
    expect(await p.isHidden("#den-lock")).toBe(true);
    expect(
      posts.filter((x) => x.path === "/api/sudo-password").map((x) => x.body),
    ).toEqual([
      { password: "wrong", saveToVault: false },
      { password: "right", saveToVault: true },
    ]);
    await p.context().close();
  }, 30_000);

  it("a run's needs-sudo asks, and after the password the action runs again; a run without one asks nothing", async () => {
    if (!browser) return;
    const { p, reqs } = await mount();
    await p.waitForSelector("#den-status.bad");
    // No needs-sudo: done never retries, nothing is asked.
    expect(
      await p.evaluate(async () => {
        const r = (window as unknown as { __hdr: Hdr }).__hdr.sudoRun();
        r.see({ type: "line", text: "x" });
        return (await r.done(() => "again")) ?? "not again";
      }),
    ).toBe("not again");
    expect(reqs.filter((r) => r.includes("/api/sudo-password"))).toEqual([]);
    // needs-sudo: asked, then run again once the password is in.
    await p.evaluate((n) => {
      const w = window as unknown as { __hdr: Hdr; __again?: unknown };
      const r = w.__hdr.sudoRun();
      r.see({ type: "needs-sudo", ...n });
      void r.done(() => "again").then((v) => (w.__again = v));
    }, NEED);
    await p.waitForSelector("#den-lock-pop #den-lock-pw");
    await p.fill("#den-lock-pw", "right");
    await p.keyboard.press("Enter");
    await p.waitForFunction(
      () => (window as unknown as { __again?: unknown }).__again === "again",
    );
    await p.context().close();
  }, 30_000);
});

describe("the prompt is always reachable, and asks the server first (LK-1..3, 0.4.3)", () => {
  it("LK-1: over an open modal dialog, the prompt is on top and takes the password", async () => {
    if (!browser) return;
    const { p } = await mount();
    await p.waitForSelector("#den-status.bad");
    // A page's modal is open when a run asks.
    await p.evaluate((n) => {
      const d = document.createElement("dialog");
      d.id = "some-modal";
      d.innerHTML = "<p>a modal</p><button>ok</button>";
      document.body.appendChild(d);
      d.showModal();
      const w = window as unknown as { __hdr: Hdr; __asked?: unknown };
      void w.__hdr.askSudo(n).then((ok) => (w.__asked = ok));
    }, NEED);
    await p.waitForSelector("#den-lock-pop #den-lock-pw");
    const hit = await p.evaluate(() => {
      const r = document.getElementById("den-lock-pw")!.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        ?.id;
    });
    expect(hit).toBe("den-lock-pw");
    expect(await p.evaluate(() => document.activeElement?.id)).toBe(
      "den-lock-pw",
    );
    await p.fill("#den-lock-pw", "right");
    await p.keyboard.press("Enter");
    await p.waitForFunction(
      () => (window as unknown as { __asked?: unknown }).__asked === true,
    );
    // The page's modal is still open: nothing was closed to get there.
    expect(
      await p.evaluate(
        () => (document.getElementById("some-modal") as HTMLDialogElement).open,
      ),
    ).toBe(true);
    await p.context().close();
  }, 30_000);

  it("LK-2: set elsewhere, an ask asks the server again before asking the person", async () => {
    if (!browser) return;
    const { p, reqs, unlockElsewhere } = await mount();
    await p.waitForSelector("#den-status.bad");
    unlockElsewhere();
    expect(
      await p.evaluate(
        (n) => (window as unknown as { __hdr: Hdr }).__hdr.askSudo(n),
        NEED,
      ),
    ).toBe(true);
    expect(
      reqs.filter((r) => r === "GET /api/sudo-password/status").length,
    ).toBe(1);
    expect(await p.$("#den-lock-pop")).toBeNull();
    expect(await p.isHidden("#den-lock")).toBe(true);
    await p.context().close();
  }, 30_000);

  it("LK-3: with a password in the vault, an ask loads it before showing the field", async () => {
    if (!browser) return;
    const { p, reqs } = await mount({ vaultStored: true });
    await p.waitForSelector("#den-status.bad");
    // A page view alone never wakes the vault.
    expect(reqs).not.toContain("POST /api/sudo-password/load-from-vault");
    expect(
      await p.evaluate(
        (n) => (window as unknown as { __hdr: Hdr }).__hdr.askSudo(n),
        NEED,
      ),
    ).toBe(true);
    expect(reqs).toContain("POST /api/sudo-password/load-from-vault");
    expect(await p.$("#den-lock-pop")).toBeNull();
    expect(await p.isHidden("#den-lock")).toBe(true);
    await p.context().close();
  }, 30_000);
});

describe("LK-4: the prompt's save option with no secrets.refs.sudo", () => {
  /** A run needs sudo: the prompt opens (askSudo), as a real run's would. */
  async function ask(p: Page): Promise<void> {
    await p.waitForSelector("#den-status.bad");
    await p.evaluate((n) => {
      void (window as unknown as { __hdr: Hdr }).__hdr.askSudo(n);
    }, NEED);
    await p.waitForSelector("#den-lock-pop #den-lock-pw");
  }

  it("offers Save to 1Password with no note to edit YAML when saving can write the ref (canSave)", async () => {
    if (!browser) return;
    const { p } = await mount({
      vault: { configured: false, canSave: true, configFile: "config/den.yml" },
    });
    await ask(p);
    await p.waitForSelector("#den-lock-pop .den-lock-save:not([hidden])");
    expect(await p.isVisible("#den-lock-pop .den-lock-cfg")).toBe(false);
    expect(await text(p, "#den-lock-pop .den-lock-save")).toBe(
      "Save to 1Password",
    );
    await p.context().close();
  }, 30_000);

  it("a backend that keeps nothing (canSave false): no save option, and the note says where the ref goes", async () => {
    if (!browser) return;
    const { p } = await mount({
      vault: {
        configured: false,
        canSave: false,
        configFile: "config/den.yml",
      },
    });
    await ask(p);
    await p.waitForSelector("#den-lock-pop .den-lock-cfg:not([hidden])");
    expect(await p.isVisible("#den-lock-pop .den-lock-save")).toBe(false);
    await p.context().close();
  }, 30_000);
});

describe("Local Dev (LK-0)", () => {
  it("doesn't wake the vault on load: the password is asked for only when sudo needs it", async () => {
    if (!browser) return;
    const { p, reqs } = await mount({ page: "local-dev", vaultStored: true });
    await p.waitForSelector(".den-rail .den-ni");
    await p.waitForTimeout(300);
    expect(reqs.filter((r) => r.includes("/api/sudo-password"))).toEqual([]);
    expect(await p.isHidden("#den-lock")).toBe(true);
    await p.context().close();
  }, 30_000);
});

describe("the user menu (R10) and Runs (R7)", () => {
  it("a language pick stores the user's language and reloads the page in it", async () => {
    if (!browser) return;
    const { p, posts } = await mount();
    await p.click("#appearance-btn");
    await p.waitForSelector(".den-pop");
    const reloaded = p.waitForEvent("framenavigated");
    await p.click('.den-pop .den-mi:has-text("日本語")');
    await reloaded;
    expect(posts.at(-1)).toEqual({
      path: "/api/settings",
      body: { language: "ja" },
    });
    await p.context().close();
  }, 30_000);

  it("◐ ▾ opens a .pop: Appearance, Theme, All settings; a pick switches live", async () => {
    if (!browser) return;
    const { p, posts } = await mount();
    await p.waitForSelector("#appearance-btn");
    await p.click("#appearance-btn");
    await p.waitForSelector(".den-pop");
    expect(await p.getAttribute("#appearance-btn", "aria-expanded")).toBe(
      "true",
    );
    expect(
      await p.$$eval(".den-pop .den-ml, .den-pop .den-mi", (r) =>
        r.map(
          (x) =>
            `${x.textContent}${x.getAttribute("aria-checked") === "true" ? " ✓" : ""}`,
        ),
      ),
    ).toEqual([
      "Appearance",
      "System ✓",
      "Dark",
      "Light",
      "Theme",
      "Org default (Den) ✓",
      "Den",
      "Paper",
      // R10's Language (R19, dev.39): each language named in itself.
      "Language",
      "English ✓",
      "日本語",
      "Español",
      "Restart Den…",
      "All settings",
    ]);
    await p.click('.den-pop .den-mi:has-text("Light")');
    await p.waitForFunction(
      () => document.documentElement.dataset.mode === "light",
    );
    expect(posts.at(-1)).toEqual({
      path: "/api/settings",
      body: { appearance: { mode: "light" } },
    });
    expect(await focused(p)).toBe("appearance-btn");
    await p.context().close();
  }, 30_000);

  it("Runs counts a run's stream until it ends, and toggles the runs dock (R16)", async () => {
    if (!browser) return;
    const { p } = await mount();
    expect(await text(p, "#den-runs")).toBe("Runs");
    await p.evaluate(() => {
      (window as unknown as { __es: EventSource }).__es = new EventSource(
        "/api/service/exec?repo=shop&service=web&cmd=restart",
      );
      // A log tail is not a run.
      new EventSource("/api/service/logs?repo=shop&service=web");
    });
    await p.waitForSelector("#den-runs .den-dot.run");
    expect(await text(p, "#den-runs")).toBe("1 running");
    await p.evaluate(() =>
      (window as unknown as { __es: EventSource }).__es.close(),
    );
    await p.waitForSelector("#den-runs .den-dot.off");
    expect(await text(p, "#den-runs")).toBe("Runs");
    // A stream the server ends with "done" ends the run too.
    await p.evaluate(
      () =>
        new EventSource("/api/service/exec?repo=shop&service=web&cmd=done-now"),
    );
    await p.waitForFunction(
      () =>
        document.getElementById("den-runs")!.title ===
        "Last run: done-now shop/web",
    );
    expect(await text(p, "#den-runs")).toBe("Runs");
    // The chip opens the dock and closes it again (aria-expanded says so).
    expect(await p.getAttribute("#den-runs", "aria-expanded")).toBe("false");
    await p.click("#den-runs");
    await p.waitForSelector("#den-dock #den-dock-out");
    expect(await p.getAttribute("#den-runs", "aria-expanded")).toBe("true");
    expect(await p.getAttribute("#den-runs", "aria-controls")).toBe("den-dock");
    expect(await text(p, "#den-dock-out")).toMatch(
      /^Nothing has run yet\. Output from any page lands here\./,
    );
    await p.click("#den-runs");
    await p.waitForSelector("#den-dock-out", { state: "detached" });
    // An empty dock links to the page that ran the last run; the link lands.
    await p.evaluate(() =>
      sessionStorage.setItem(
        "__DEN_CLI__-last-run",
        JSON.stringify({ label: "up shop", page: "/local-dev", at: 1 }),
      ),
    );
    await p.click("#den-runs");
    await p.waitForSelector('#den-dock-out a[href="/local-dev"]');
    expect(await text(p, "#den-dock-out a")).toBe("Last run: up shop ↗");
    await Promise.all([
      p.waitForURL("http://den.test/local-dev"),
      p.click("#den-dock-out a"),
    ]);
    await p.waitForSelector(
      '.den-ni[data-nav="local-dev"][aria-current="page"]',
    );
    await p.context().close();
  }, 30_000);
});

describe("criterion 5: the overlays only read", () => {
  it("palette, drawer, lock and user menu, and appearance from the palette, write appearance only", async () => {
    if (!browser) return;
    const { p, reqs, posts } = await mount();
    await p.waitForSelector("#den-status.bad");
    await p.click("#den-status");
    await p.keyboard.press("Escape");
    // The admin-password prompt, opened and declined.
    await p.evaluate(
      () => void (window as unknown as { __hdr: Hdr }).__hdr.askSudo({}),
    );
    await p.waitForSelector("#den-lock-pop");
    await p.keyboard.press("Escape");
    await p.click("#appearance-btn");
    await p.keyboard.press("Escape");
    await p.keyboard.press("Control+k");
    await p.keyboard.type("appearance light");
    await p.keyboard.press("Enter");
    await p.waitForFunction(
      () => document.documentElement.dataset.mode === "light",
    );
    await p.keyboard.press("Control+k");
    await p.keyboard.type("theme paper");
    await p.keyboard.press("Enter");
    await p.waitForFunction(
      () => !!document.querySelector('link[href^="/theme.css?t="]'),
    );
    expect(posts).toEqual([
      { path: "/api/settings", body: { appearance: { mode: "light" } } },
      { path: "/api/settings", body: { appearance: { theme: "paper" } } },
    ]);
    // Nothing reached a service, workspace, edge or restart route. The
    // shell's one read of /api/edge (GET, the rail's Edge page asks whether
    // an edge is configured, dev.30) is a page load's, and only reads.
    expect(reqs.filter((r) => r.startsWith("GET /api/edge"))).toEqual([
      "GET /api/edge",
    ]);
    expect(
      reqs.filter(
        (r) =>
          r !== "GET /api/edge" &&
          /\/api\/(service|workspace|workspaces|edge|web\/restart|run|release|local-dev)\b/.test(
            r,
          ),
      ),
    ).toEqual([]);
    await p.context().close();
  }, 30_000);
});

describe("D64: Restart Den from the browser, in place", () => {
  const dlgOpen = (p: Page) =>
    p.evaluate(
      () =>
        (document.getElementById("rd-dlg") as HTMLDialogElement | null)?.open ??
        false,
    );

  it("the header menu's Restart Den asks first, then waits in a dialog that closes by itself; no reload, a typed draft stays", async () => {
    if (!browser) return;
    const { p, posts, backAt } = await mount({
      restart: { down: 2 },
      after: '<textarea id="draft"></textarea>',
    });
    await p.evaluate(() => {
      (window as unknown as { __mark: number }).__mark = 7;
      (window as unknown as { __backs: number }).__backs = 0;
      window.addEventListener("den:server-back", () => {
        (window as unknown as { __backs: number }).__backs++;
      });
    });
    await p.fill("#draft", "half a thought");
    await p.click("#appearance-btn");
    await p.click('.den-pop .den-mi:has-text("Restart Den…")');
    await p.waitForSelector('#rd-dlg[data-state="confirm"]');
    expect(await text(p, "#rd-dlg")).toContain("Agents and their terminals");
    // Cancel: nothing asked of the server.
    await p.click('[data-rd="cancel"]');
    expect(await dlgOpen(p)).toBe(false);
    expect(posts.some((x) => x.path === "/api/web/restart")).toBe(false);

    await p.click("#appearance-btn");
    await p.click('.den-pop .den-mi:has-text("Restart Den…")');
    await p.click('[data-rd="go"]');
    await p.waitForSelector('#rd-dlg[data-state="waiting"]');
    expect(await text(p, "#rd-dlg .rd-msg")).toMatch(/^Restarting Den… \d+s$/);
    // Keep waiting and the CLI line only after restart_wait_seconds.
    expect(await p.isVisible('[data-rd="keep"]')).toBe(false);
    expect(await p.isVisible("#rd-dlg .rd-slow")).toBe(false);
    // BUSY-1: it says the page reconnects by itself, then Back and the version.
    expect(await text(p, "#rd-dlg .rd-sub")).toBe(
      "This page reconnects by itself when Den is back.",
    );
    await p.waitForFunction(
      () =>
        document.querySelector("#rd-dlg .rd-msg")?.textContent ===
        "Den is back.",
      undefined,
      { timeout: 15_000 },
    );
    expect(await text(p, "#rd-dlg .rd-sub")).toMatch(/^Version \S+\.$/);
    await p.waitForFunction(
      () => !(document.getElementById("rd-dlg") as HTMLDialogElement).open,
      undefined,
      { timeout: 5_000 },
    );
    const closedIn = Date.now() - backAt();
    expect(backAt()).toBeGreaterThan(0);
    expect(closedIn).toBeLessThan(2_500);
    expect(posts.filter((x) => x.path === "/api/web/restart")).toHaveLength(1);
    // In place: same page, same draft, and the page was told.
    expect(
      await p.evaluate(() => (window as unknown as { __mark: number }).__mark),
    ).toBe(7);
    expect(await p.inputValue("#draft")).toBe("half a thought");
    expect(
      await p.evaluate(
        () => (window as unknown as { __backs: number }).__backs,
      ),
    ).toBe(1);
    await p.context().close();
  }, 40_000);

  it("the stale pill restarts with the same dialog, without asking", async () => {
    if (!browser) return;
    const { p } = await mount({ stale: true, restart: { down: 1 } });
    await p.evaluate(() => {
      (window as unknown as { __mark: number }).__mark = 9;
    });
    await p.waitForSelector("#stale-pill", { state: "visible" });
    await p.click("#stale-pill");
    await p.waitForSelector('#rd-dlg[data-state="waiting"]');
    await p.waitForFunction(
      () => !(document.getElementById("rd-dlg") as HTMLDialogElement).open,
      undefined,
      { timeout: 15_000 },
    );
    expect(
      await p.evaluate(() => (window as unknown as { __mark: number }).__mark),
    ).toBe(9);
    await p.waitForSelector("#stale-pill", { state: "hidden" });
    await p.context().close();
  }, 40_000);

  it("a slow restart shows the command line and Keep waiting, and never closes while the server is down", async () => {
    if (!browser) return;
    const { p } = await mount({ restart: { down: 1000, waitSeconds: 2 } });
    await p.click("#appearance-btn");
    await p.click('.den-pop .den-mi:has-text("Restart Den…")');
    await p.click('[data-rd="go"]');
    await p.waitForSelector("#rd-dlg .rd-slow:not([hidden])", {
      timeout: 10_000,
    });
    expect(await text(p, "#rd-dlg .rd-slow")).toContain("web restart");
    // BUSY-1: "Den didn't come back.", and Check again waits on.
    expect(await text(p, "#rd-dlg .rd-msg")).toBe("Den didn't come back.");
    expect(await text(p, '[data-rd="keep"]')).toBe("Check again");
    expect(await p.isVisible('[data-rd="keep"]')).toBe(true);
    await p.click('[data-rd="keep"]');
    expect(await p.isHidden("#rd-dlg .rd-slow")).toBe(true);
    expect(await text(p, "#rd-dlg .rd-msg")).toMatch(/^Restarting Den…/);
    expect(await p.isVisible('[data-rd="keep"]')).toBe(false);
    await p.keyboard.press("Escape");
    expect(await dlgOpen(p)).toBe(true);
    await p.context().close();
  }, 40_000);
});
