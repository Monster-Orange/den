/**
 * Room for the graph (R23, 0.3.0-dev.30, Ward QA 2026-11-05): the
 * workspace list (260px), the output and two toolbar rows left Local
 * Dev's graph at 40% Fit. The workspace list collapses to a 40px strip,
 * remembered per user (/api/settings graph.workspaces); Maximize (the
 * graph's button, or F with focus outside a field) gives the graph the
 * whole content area, and Esc restores. Fit uses the whole area, so its
 * zoom rises once maximized. The runs dock starts collapsed here too (R16a).
 *
 * Since 0.3.0-dev.35 (R24) Local Dev is Workspaces, an ops page with no
 * graph of its own: the graph checks run on the Graph page (/graph?ws=),
 * and the list's collapse is measured against the Workspaces repo table.
 *
 * The real web server in a throwaway distribution (one workspace, three
 * repos with two services each), driven by Playwright's headless
 * Chromium, clicked as an engineer would.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { denAuth } from "./helpers/den-auth.js";
import { spawnServer, stopServer } from "../../child-servers.js";

/** SEC-1a: the CLI's credential for the test server. */
const auth = () => denAuth(path.join(tmp, "home", ".den"));

const ENGINE = path.resolve(__dirname, "../../..");
const REPOS = ["shop", "billing", "search"];
// A bigger workspace (a consumer's dev.30 finding): its Fit at 1440×900 is
// below 35%, where Fit used to stop, so Fit read 35% maximized or not.
const BIG = Array.from({ length: 10 }, (_, i) => `svc${i + 1}`);
let tmp = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
let browser: Browser | null = null;
let latest = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function get(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "localhost", port, path: p, timeout: 5_000, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
const api = (p: string) => `http://localhost:${port}${p}`;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-room-")));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    "environments: [local]\ngithub_org: acme\n",
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    [...REPOS, ...BIG].map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [main, big]",
      "focus: main",
      "workspaces:",
      "  main:",
      "    services:",
      ...REPOS.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "  big:",
      "    services:",
      ...BIG.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  for (const n of [...REPOS, ...BIG])
    write(
      path.join(repos, n, ".den.yml"),
      `name: ${n}\nservices:\n` +
        ["api", "worker"]
          .map(
            (s) => `  ${s}:\n    commands:\n      local:\n        up: "true"\n`,
          )
          .join(""),
    );

  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  server = spawnServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await get("/api/server-info")) === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error(`server did not start:\n${serverOut}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  latest =
    (
      (await (await fetch(api("/api/changelog"))).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A page for a workspace: /graph (the graph drawn) or / (the table). */
async function open(
  o: {
    keep?: boolean;
    ws?: string;
    width?: number;
    height?: number;
    path?: "/graph" | "/";
  } = {},
): Promise<Page> {
  if (!o.keep)
    await fetch(api("/api/settings"), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ graph: { workspaces: "open" } }),
    });
  const ctx = await browser!.newContext({
    viewport: { width: o.width ?? 1280, height: o.height ?? 800 },
  });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  const where = o.path ?? "/graph";
  await p.goto(api(`${where}?ws=${o.ws ?? "main"}`));
  await p.waitForSelector(where === "/" ? "#repo-table tr.repo" : ".dg-card");
  await p.waitForTimeout(500);
  return p;
}

/** Drawn with a size; false when hidden or not on the page at all. */
const visible = async (p: Page, sel: string) =>
  (await p.$(sel))
    ? p.$eval(sel, (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
    : false;
const vpArea = (p: Page) =>
  p.$eval(".dg-vp", (e) => {
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
const zoom = async (p: Page) =>
  parseInt((await p.textContent('[data-z="100"]'))!, 10);
/** Fit, then the zoom it settled on. */
async function fit(p: Page): Promise<number> {
  await p.click('[data-z="fit"]');
  await p.waitForTimeout(150);
  return zoom(p);
}

describe("room for the graph (R23, Ward QA 2026-11-05; on /graph since dev.35)", () => {
  it("Maximize hides the page header; the graph grows and Fit zooms higher; Esc restores", async () => {
    if (!browser) return;
    const p = await open();
    // R16a: the dock is just its bar here too.
    expect(await p.$("#den-dock-out")).toBeNull();
    const before = await vpArea(p);
    const z0 = await fit(p);
    // Fit is bound by the area here, not by its 35% floor or 100%.
    expect(z0).toBeGreaterThan(35);
    expect(z0).toBeLessThan(100);
    const PH = "#den-content > .ph";
    expect(await visible(p, PH)).toBe(true);

    await p.click('[data-z="max"]');
    await p.waitForTimeout(300);
    expect(await p.getAttribute('[data-z="max"]', "aria-pressed")).toBe("true");
    expect(await visible(p, PH)).toBe(false);
    const max = await vpArea(p);
    expect(max.w).toBeGreaterThan(before.w + 20);
    expect(max.h).toBeGreaterThan(before.h + 60);
    const z1 = await fit(p);
    expect(z1).toBeGreaterThan(z0);

    // Esc restores (focus on the graph, nothing else open to close).
    await p.focus(".dg-vp");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    expect(await visible(p, PH)).toBe(true);
    expect(await p.getAttribute('[data-z="max"]', "aria-pressed")).toBe(
      "false",
    );
    expect(await vpArea(p)).toEqual(before);
    await p.context().close();
  }, 45_000);

  it("F maximizes with focus outside a field, and types an F in one", async () => {
    if (!browser) return;
    const p = await open();
    await p.click("[data-find]");
    await p.keyboard.press("F");
    const PH = "#den-content > .ph";
    expect(await p.inputValue("[data-find]")).toBe("F");
    expect(await visible(p, PH)).toBe(true);
    await p.fill("[data-find]", "");
    await p.focus(".dg-vp");
    await p.keyboard.press("f");
    await p.waitForTimeout(200);
    expect(await visible(p, PH)).toBe(false);
    expect(await p.getAttribute('[data-z="max"]', "aria-pressed")).toBe("true");
    await p.keyboard.press("f");
    await p.waitForTimeout(200);
    expect(await visible(p, PH)).toBe(true);
    await p.context().close();
  }, 30_000);

  it("the workspace list collapses to a 40px strip, the Workspaces table gets the width, and a reload and a fresh browser keep it", async () => {
    if (!browser) return;
    const tableW = (p: Page) =>
      p.$eval(".tablewrap", (e) => Math.round(e.getBoundingClientRect().width));
    const p = await open({ path: "/" });
    const w0 = await tableW(p);
    expect(
      await p.$eval(".sidebar", (e) => e.getBoundingClientRect().width),
    ).toBe(260);
    await p.click("#ws-toggle");
    await p.waitForTimeout(300);
    expect(
      await p.$eval(".sidebar", (e) => e.getBoundingClientRect().width),
    ).toBe(40);
    expect(await p.getAttribute("#ws-toggle", "aria-expanded")).toBe("false");
    expect(await visible(p, "#ws-list")).toBe(false);
    expect(await tableW(p)).toBe(w0 + 220);
    await p.waitForFunction(
      async (u) =>
        (await (await fetch(u)).json()).graph?.workspaces === "collapsed",
      api("/api/settings"),
    );
    await p.reload();
    await p.waitForSelector("#repo-table tr.repo");
    expect(
      await p.$eval(".sidebar", (e) => e.getBoundingClientRect().width),
    ).toBe(40);
    await p.context().close();

    // A fresh browser: the user's pref, from the server.
    const q = await open({ keep: true, path: "/" });
    await q.waitForFunction(
      () =>
        document.querySelector(".sidebar")!.getBoundingClientRect().width ===
        40,
    );
    // And open again, with the expand button.
    await q.click("#ws-toggle");
    await q.waitForTimeout(300);
    expect(
      await q.$eval(".sidebar", (e) => e.getBoundingClientRect().width),
    ).toBe(260);
    expect(await visible(q, "#ws-list")).toBe(true);
    await q.context().close();
  }, 45_000);
});

describe("Fit follows the size on maximize and restore (a consumer's dev.30 finding)", () => {
  // (On the Graph page Maximize gains the page header's height and a little
  // padding, so the stage is wide and short: Fit is bound by the height.)
  it("a big graph at 1920×640: Fit fits it (below 35%), maximized Fit zooms higher, and the fitted view refits on maximize and restore", async () => {
    if (!browser) return;
    const p = await open({ ws: "big", width: 1920, height: 640 });
    const z0 = await fit(p);
    // The whole graph fits: no 35% floor in the way.
    expect(z0).toBeLessThan(35);
    const fits = () =>
      p.evaluate(() => {
        const vp = document.querySelector(".dg-vp")!.getBoundingClientRect();
        const w = document.querySelector(".dg-world")!.getBoundingClientRect();
        const ok =
          w.right <= vp.right + 1 &&
          w.bottom <= vp.bottom + 1 &&
          w.left >= vp.left - 1 &&
          w.top >= vp.top - 1;
        return ok
          ? true
          : JSON.stringify({
              vp: vp.toJSON(),
              w: w.toJSON(),
              st: (document.querySelector(".dg-world") as HTMLElement).style
                .cssText,
            });
      });
    expect(await fits()).toBe(true);

    // Maximize: the fitted view refits for the bigger area by itself.
    await p.click('[data-z="max"]');
    await p.waitForTimeout(400);
    const zMax = await zoom(p);
    expect(zMax).toBeGreaterThan(z0);
    expect(await fits()).toBe(true);
    // And Fit there agrees.
    expect(await fit(p)).toBe(zMax);

    // Restore: back to the smaller fit.
    await p.click('[data-z="max"]');
    await p.waitForTimeout(400);
    expect(await zoom(p)).toBe(z0);
    expect(await fits()).toBe(true);
    await p.context().close();
  }, 45_000);
});

/** The scope line the top bar shows: org / workspace / env, as drawn. */
const scopeLine = (p: Page) =>
  p.evaluate(() =>
    ["#org-crumb", "#ws-pill", "#env-btn"]
      .map((s) => document.querySelector<HTMLElement>(s))
      .filter((e): e is HTMLElement => !!e && !e.hidden)
      .map(
        (e) =>
          (e.querySelector(".den-org-name") ?? e.querySelector(".den-vn"))
            ?.textContent ?? "",
      )
      .filter(Boolean)
      .join(" / "),
  );

describe("R20 page headers (0.3.0-dev.32)", () => {
  it.each([
    ["/?ws=main", "Workspaces"],
    ["/local-dev?ws=main", "Workspaces"],
    ["/graph?ws=main", "Graph"],
    ["/services", "Services"],
    ["/logs", "Logs"],
    ["/tests", "Tests"],
    ["/environments", "Environments"],
    ["/release", "Releases"],
  ])(
    "%s: one visible h1 in the prototype's .ph (600 22px/1.2), a 13px muted scope line under it",
    async (url, title) => {
      if (!browser) return;
      const ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
      });
      await ctx.addInitScript((v) => {
        try {
          localStorage.setItem("den-changelog-seen", v);
        } catch {
          /* none */
        }
      }, latest);
      const p = await ctx.newPage();
      await p.goto(api(url));
      await p.waitForSelector("#den-content > .ph h1");
      // The line settles once the scope (and the workspace shown) is known.
      const oneWs = /^\/(\?|local-dev|graph)/.test(url);
      await p.waitForFunction((oneWs) => {
        const sub =
          document.querySelector("#den-content > .ph .sub")?.textContent ?? "";
        if (oneWs) return /(^|\/ )main \/ local$/.test(sub);
        const line = ["#org-crumb", "#ws-pill", "#env-btn"]
          .map((s) => document.querySelector<HTMLElement>(s))
          .filter((e): e is HTMLElement => !!e && !e.hidden)
          .map(
            (e) =>
              (e.querySelector(".den-org-name") ?? e.querySelector(".den-vn"))
                ?.textContent ?? "",
          )
          .filter(Boolean)
          .join(" / ");
        return sub !== "" && sub === line && line.includes(" / ");
      }, oneWs);
      const h = await p.evaluate(() => {
        const main = document.getElementById("den-content")!;
        const ph = main.querySelector<HTMLElement>(":scope > .ph")!;
        const h1 = ph.querySelector("h1")!;
        const sub = ph.querySelector<HTMLElement>(".sub")!;
        const cs = getComputedStyle(h1);
        const ss = getComputedStyle(sub);
        const r = h1.getBoundingClientRect();
        const m = main.getBoundingClientRect();
        return {
          h1s: document.querySelectorAll("h1").length,
          first: main.firstElementChild === ph,
          text: h1.textContent,
          visible: r.width > 0 && r.height > 0,
          font: [cs.fontWeight, cs.fontSize, cs.lineHeight],
          sub: sub.textContent,
          subFont: [ss.fontSize, ss.marginTop],
          // .main's inset: 20px from the top, 24px from the left.
          inset: [Math.round(r.top - m.top), Math.round(r.left - m.left)],
        };
      });
      expect(h).toEqual({
        h1s: 1,
        first: true,
        text: title,
        visible: true,
        font: ["600", "22px", "26.4px"],
        sub: expect.any(String),
        subFont: ["13px", "4px"],
        inset: [20, 24],
      });
      // Workspaces and Graph show one workspace, locally: their line names
      // it. Every other page's line is the top bar's scope.
      if (oneWs) expect(h.sub).toMatch(/(^|\/ )main \/ local$/);
      else expect(h.sub).toBe(await scopeLine(p));
      await ctx.close();
    },
    30_000,
  );
});

describe("R22: the Graph page (Ward 2026-11-05)", () => {
  it("the rail's Graph lands on /graph: the graph alone, full width; Workspaces keeps its list, actions and table, and no graph (R24)", async () => {
    if (!browser) return;
    const p = await open({ width: 1440, height: 900, path: "/" });
    // Workspaces: the list, the action row and the repo table; no graph.
    for (const sel of [
      ".sidebar",
      ".cmd-bar",
      ".content-header",
      "#repo-table",
    ])
      expect([sel, await visible(p, sel)]).toEqual([sel, true]);
    expect(await p.$$eval("#dep-graph-wrap, .dg-card", (e) => e.length)).toBe(
      0,
    );
    const localW = await p.$eval(
      ".tablewrap",
      (e) => e.getBoundingClientRect().width,
    );

    // The rail item, clicked.
    await p.click('.den-ni[data-nav="graph"]');
    await p.waitForURL(/\/graph/);
    await p.waitForSelector(".dg-card");
    expect(new URL(p.url()).pathname).toBe("/graph");
    expect(
      await p.getAttribute('.den-ni[data-nav="graph"]', "aria-current"),
    ).toBe("page");
    expect(await p.title()).toMatch(/ · Graph$/);
    expect(await p.textContent("#den-content > .ph h1")).toBe("Graph");
    for (const sel of [
      ".sidebar",
      ".cmd-bar",
      "#repo-table",
      ".content-header",
    ])
      expect([sel, await visible(p, sel)]).toEqual([sel, false]);
    // Full width: the content column, less the 24px insets.
    const g = await p.evaluate(() => {
      const vp = document.querySelector(".dg-vp")!.getBoundingClientRect();
      const m = document.getElementById("den-content")!.getBoundingClientRect();
      return { w: vp.width, main: m.width };
    });
    expect(g.w).toBeGreaterThan(localW + 200);
    expect(g.w).toBeGreaterThan(g.main - 60);
    // Maximize there hides the page header too; Esc restores it.
    await p.click('[data-z="max"]');
    await p.waitForTimeout(200);
    expect(await visible(p, "#den-content > .ph")).toBe(false);
    await p.focus(".dg-vp");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    expect(await visible(p, "#den-content > .ph")).toBe(true);
    await p.context().close();
  }, 45_000);
});

/** A page at 1440×900, the changelog seen. */
async function page(url: string, w = 1440, h = 900): Promise<Page> {
  const ctx = await browser!.newContext({ viewport: { width: w, height: h } });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(api(url));
  return p;
}
const setScope = (scope: string) =>
  fetch(api("/api/scope"), {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ scope }),
  });

// A consumer's dev.32 dogfood finding: ArrowRight, Home and End left focus
// on Graph. The WAI-ARIA tabs pattern, from one shell helper (Local Dev's
// workspace tabs used it until dev.35, R24; the shell's page tabs still do).
describe("page tabs: the WAI-ARIA tabs pattern (0.3.0-dev.33)", () => {
  it("no empty tablist stub: the shell makes page tabs only when a page asks, wired the same way", async () => {
    if (!browser) return;
    const p = await page("/services");
    await p.waitForSelector("#den-content > .ph h1");
    // No .ptabs tablist (the old hidden, unlabelled, empty stub) until a
    // page asks for tabs.
    const lists = () =>
      p.$$eval('[role="tablist"]', (els) =>
        els.map((e) => ({
          cls: e.className,
          label:
            !!e.getAttribute("aria-label") ||
            !!e.getAttribute("aria-labelledby"),
          tabs: e.querySelectorAll('[role="tab"]').length,
        })),
      );
    expect((await lists()).filter((l) => /ptabs/.test(l.cls))).toEqual([]);
    expect(await p.$(".den-ptabs")).toBeNull();

    // A page asks for tabs: a .ptabs tablist below the header.
    await p.evaluate(() => {
      const main = document.getElementById("den-content")!;
      for (const id of ["one", "two", "three"]) {
        const d = document.createElement("div");
        d.id = "demo-" + id;
        d.textContent = id;
        main.appendChild(d);
      }
      (
        window as unknown as {
          denShell: {
            pageHeader(): { tabs(spec: unknown): unknown };
          };
        }
      ).denShell
        .pageHeader()
        .tabs({
          label: "Demo",
          tabs: ["one", "two", "three"].map((id) => ({
            id,
            label: id,
            panel: document.getElementById("demo-" + id),
          })),
          selected: "two",
        });
    });
    const made = await p.evaluate(() => {
      const list = document.querySelector<HTMLElement>(".ptabs.den-ptabs")!;
      const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
      return {
        afterHeader: list.previousElementSibling?.classList.contains("ph"),
        label: list.getAttribute("aria-label"),
        tabs: tabs.map((t) => {
          const pnl = document.getElementById(
            t.getAttribute("aria-controls")!,
          )!;
          return [
            t.textContent,
            t.getAttribute("aria-selected"),
            t.getAttribute("tabindex"),
            pnl.getAttribute("role"),
            pnl.getAttribute("aria-labelledby") === t.id,
            pnl.hidden,
          ];
        }),
      };
    });
    expect(made).toEqual({
      afterHeader: true,
      label: "Demo",
      tabs: [
        ["one", "false", "-1", "tabpanel", true, true],
        ["two", "true", "0", "tabpanel", true, false],
        ["three", "false", "-1", "tabpanel", true, true],
      ],
    });
    await p.focus('.den-ptabs [aria-selected="true"]');
    for (const [key, want] of [
      ["End", "three"],
      ["ArrowRight", "one"],
      ["ArrowLeft", "three"],
      ["Home", "one"],
    ]) {
      await p.keyboard.press(key);
      expect([
        key,
        await p.evaluate(() => [
          document.activeElement?.textContent,
          document.querySelector('.den-ptabs [aria-selected="true"]')
            ?.textContent,
          [...document.querySelectorAll<HTMLElement>("[id^='demo-']")]
            .filter((e) => !e.hidden)
            .map((e) => e.id),
        ]),
      ]).toEqual([key, [want, want, ["demo-" + want]]]);
    }
    await p.context().close();
  }, 30_000);
});

// A consumer's dev.32 dogfood finding: the top bar said "All active", but
// /graph showed (and named) the focused workspace only.
describe("the Graph page follows the top bar's workspace scope (0.3.0-dev.33)", () => {
  const sub = (p: Page) =>
    p.textContent("#den-content > .ph .sub").then((s) => s ?? "");
  const repos = (p: Page) =>
    p.$$eval(".dg-card", (els) => [
      ...new Set(
        els.map(
          (e) =>
            (e as HTMLElement).dataset.id?.split("/")[0] ??
            (e as HTMLElement).dataset.repo,
        ),
      ),
    ]);

  it("All active: every active workspace, its line naming All active; one picked: that one; ?ws= still wins; Workspaces keeps its one", async () => {
    if (!browser) return;
    await setScope("all");
    try {
      let p = await page("/graph");
      await p.waitForSelector(".dg-card");
      await p.waitForFunction(() =>
        /All active \/ local$/.test(
          document.querySelector("#den-content > .ph .sub")?.textContent ?? "",
        ),
      );
      expect(await sub(p)).toMatch(/(^|\/ )All active \/ local$/);
      expect(await p.textContent("#ws-pill .den-vn")).toBe("All active");
      expect((await repos(p)).sort()).toEqual([...REPOS, ...BIG].sort());
      await p.context().close();

      // ?ws= wins over the picker.
      p = await page("/graph?ws=main");
      await p.waitForSelector(".dg-card");
      await p.waitForFunction(() =>
        /(^|\/ )main \/ local$/.test(
          document.querySelector("#den-content > .ph .sub")?.textContent ?? "",
        ),
      );
      expect((await repos(p)).sort()).toEqual([...REPOS].sort());
      await p.context().close();

      // Workspaces keeps the list's one workspace (its actions and table
      // are per workspace), and its line names it.
      p = await page("/local-dev");
      await p.waitForSelector("#repo-table tr.repo");
      await p.waitForFunction(() =>
        /(^|\/ )main \/ local$/.test(
          document.querySelector("#den-content > .ph .sub")?.textContent ?? "",
        ),
      );
      expect(
        (
          await p.$$eval("#repo-table tr.repo", (rs) =>
            rs.map((r) => (r as HTMLElement).dataset.repo!),
          )
        ).sort(),
      ).toEqual([...REPOS].sort());
      await p.context().close();

      // One workspace picked in the top bar: that one.
      await setScope("big");
      p = await page("/graph");
      await p.waitForSelector(".dg-card");
      await p.waitForFunction(() =>
        /(^|\/ )big \/ local$/.test(
          document.querySelector("#den-content > .ph .sub")?.textContent ?? "",
        ),
      );
      expect((await repos(p)).sort()).toEqual([...BIG].sort());
      expect(await p.textContent("#ws-pill .den-vn")).toBe("big");
      await p.context().close();
    } finally {
      await setScope("all");
    }
  }, 60_000);
});

// A consumer's dev.32 finding: on /graph a repo box with one row of cards
// drew about twice the height it needs. Measured in the page.
describe("group boxes fit their content (0.3.0-dev.33)", () => {
  it("each repo box ends its padding below its lowest card; each org box likewise", async () => {
    if (!browser) return;
    const p = await page("/graph?ws=main");
    await p.waitForSelector(".dg-grp.dg-repo");
    await p.waitForTimeout(300);
    // World coordinates (style), so the zoom doesn't matter.
    const boxes = await p.evaluate(() => {
      const px = (e: HTMLElement, k: "top" | "left" | "width" | "height") =>
        parseFloat(e.style[k]);
      const cards = [...document.querySelectorAll<HTMLElement>(".dg-card")];
      return [...document.querySelectorAll<HTMLElement>(".dg-grp")].map((g) => {
        const top = px(g, "top"),
          left = px(g, "left"),
          bottom = top + px(g, "height"),
          right = left + px(g, "width");
        const inside = cards.filter(
          (c) =>
            px(c, "top") >= top &&
            px(c, "left") >= left &&
            px(c, "top") + px(c, "height") <= bottom &&
            px(c, "left") + px(c, "width") <= right,
        );
        const rows = new Set(inside.map((c) => px(c, "top")));
        const lowest = Math.max(
          ...inside.map((c) => px(c, "top") + px(c, "height")),
        );
        return {
          kind: g.classList.contains("dg-repo") ? "repo" : "org",
          rows: rows.size,
          slack: Math.round(bottom - lowest),
        };
      });
    });
    const repo = boxes.filter((b) => b.kind === "repo");
    expect(repo.length).toBe(REPOS.length);
    for (const b of repo)
      expect(b).toEqual({ kind: "repo", rows: 1, slack: 14 });
    for (const b of boxes.filter((x) => x.kind === "org"))
      expect(b.slack).toBe(14 + 18);
    await p.context().close();
  }, 30_000);
});

// A consumer's dev.32 finding: after Fit the legend covered the last
// group's bottom ~10px. Fit keeps the graph above the legend and the zoom
// group, measured (a legend on several lines reserves its real height).
describe("Fit reserves the legend and the zoom group (0.3.0-dev.33)", () => {
  it("a tall graph, a legend on several lines: after Fit no card or group sits under them", async () => {
    if (!browser) return;
    const p = await page("/graph?ws=big", 1280, 800);
    await p.waitForSelector(".dg-card");
    try {
      // Left-right stacks the big workspace's repos: Fit is bound by height.
      await p.click('[data-seg="dir"] [data-v="right"]');
      await p.waitForTimeout(600);
      // One line's height on this machine (fonts differ across platforms).
      const oneLineH = await p.evaluate(
        () =>
          document.querySelector(".dg-legend")!.getBoundingClientRect().height,
      );
      await p.addStyleTag({ content: ".dg-legend { max-width: 64px; }" });
      await p.click('[data-z="fit"]');
      await p.waitForTimeout(200);
      const r = await p.evaluate(() => {
        const top = Math.min(
          document.querySelector(".dg-legend")!.getBoundingClientRect().top,
          document.querySelector(".dg-zoom")!.getBoundingClientRect().top,
        );
        const under = [
          ...document.querySelectorAll<HTMLElement>(".dg-grp, .dg-card"),
        ]
          .map((e) => e.getBoundingClientRect().bottom)
          .filter((b) => b > top - 0.5);
        const legendH = document
          .querySelector(".dg-legend")!
          .getBoundingClientRect().height;
        return { under: under.length, legendH };
      });
      // The legend wrapped (taller than its one line, measured above, not a
      // pixel count: the Linux CI fonts set it shorter than macOS's).
      expect(r.legendH).toBeGreaterThan(oneLineH + 8);
      expect(r.under).toBe(0);
    } finally {
      await p.click('[data-seg="dir"] [data-v="down"]');
      await p.waitForTimeout(300);
      await p.context().close();
    }
  }, 30_000);
});
