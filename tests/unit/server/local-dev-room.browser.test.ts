/**
 * Room for Local Dev's graph (R23, 0.3.0-dev.30, Ward QA 2026-11-05): the
 * workspace list (260px), the output and two toolbar rows left the graph at
 * 40% Fit. The workspace list collapses to a 40px strip, remembered per
 * user (/api/settings graph.workspaces); Maximize (the graph's button, or
 * F with focus outside a field) hides the list, the header, the action row
 * and the tabs, and Esc restores. Fit uses the whole area, so its zoom
 * rises once maximized. The runs dock starts collapsed here too (R16a).
 *
 * The real web server in a throwaway distribution (one workspace, three
 * repos with two services each), driven by Playwright's headless
 * Chromium, clicked as an engineer would.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";

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
  server = spawn(
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
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((r) => setTimeout(r, 5_000).unref()),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(
  o: { keep?: boolean; ws?: string; width?: number; height?: number } = {},
): Promise<Page> {
  if (!o.keep)
    await fetch(api("/api/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  await p.goto(api(`/local-dev?ws=${o.ws ?? "main"}`));
  await p.waitForSelector(".dg-card");
  await p.waitForTimeout(500);
  return p;
}

const visible = (p: Page, sel: string) =>
  p.$eval(sel, (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
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

describe("Local Dev: room for the graph (R23, Ward QA 2026-11-05)", () => {
  it("Maximize hides the list, the action row and the tabs; the graph grows and Fit zooms higher; Esc restores", async () => {
    if (!browser) return;
    const p = await open();
    // R16a: the dock is just its bar here too.
    expect(await p.$("#den-dock-out")).toBeNull();
    const before = await vpArea(p);
    const z0 = await fit(p);
    // Fit is bound by the area here, not by its 35% floor or 100%.
    expect(z0).toBeGreaterThan(35);
    expect(z0).toBeLessThan(100);
    for (const sel of [".sidebar", ".cmd-bar", ".ctab-bar"])
      expect([sel, await visible(p, sel)]).toEqual([sel, true]);

    await p.click('[data-z="max"]');
    await p.waitForTimeout(300);
    expect(await p.getAttribute('[data-z="max"]', "aria-pressed")).toBe("true");
    for (const sel of [".sidebar", ".cmd-bar", ".ctab-bar", ".content-header"])
      expect([sel, await visible(p, sel)]).toEqual([sel, false]);
    const max = await vpArea(p);
    expect(max.w).toBeGreaterThan(before.w + 200);
    expect(max.h).toBeGreaterThan(before.h + 60);
    const z1 = await fit(p);
    expect(z1).toBeGreaterThan(z0);

    // Esc restores (focus on the graph, nothing else open to close).
    await p.focus(".dg-vp");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    for (const sel of [".sidebar", ".cmd-bar", ".ctab-bar"])
      expect([sel, await visible(p, sel)]).toEqual([sel, true]);
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
    expect(await p.inputValue("[data-find]")).toBe("F");
    expect(await visible(p, ".sidebar")).toBe(true);
    await p.fill("[data-find]", "");
    await p.focus(".dg-vp");
    await p.keyboard.press("f");
    await p.waitForTimeout(200);
    expect(await visible(p, ".sidebar")).toBe(false);
    expect(await visible(p, ".ctab-bar")).toBe(false);
    await p.keyboard.press("f");
    await p.waitForTimeout(200);
    expect(await visible(p, ".sidebar")).toBe(true);
    await p.context().close();
  }, 30_000);

  it("the workspace list collapses to a 40px strip, the graph gets the width, and a reload and a fresh browser keep it", async () => {
    if (!browser) return;
    const p = await open();
    const w0 = (await vpArea(p)).w;
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
    expect((await vpArea(p)).w).toBe(w0 + 220);
    await p.waitForFunction(
      async (u) =>
        (await (await fetch(u)).json()).graph?.workspaces === "collapsed",
      api("/api/settings"),
    );
    await p.reload();
    await p.waitForSelector(".dg-card");
    expect(
      await p.$eval(".sidebar", (e) => e.getBoundingClientRect().width),
    ).toBe(40);
    await p.context().close();

    // A fresh browser: the user's pref, from the server.
    const q = await open({ keep: true });
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
  it("a big graph at 1440×900: Fit fits it (below 35%), maximized Fit zooms higher, and the fitted view refits on maximize and restore", async () => {
    if (!browser) return;
    const p = await open({ ws: "big", width: 1440, height: 900 });
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
    ["/local-dev?ws=main", "Local Dev"],
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
      // The line settles once the scope (and Local Dev's workspace) is known.
      const oneWs = url.startsWith("/local-dev") || url.startsWith("/graph");
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
      // Local Dev and Graph show one workspace, locally: their line names
      // it. Every other page's line is the top bar's scope.
      if (oneWs) expect(h.sub).toMatch(/(^|\/ )main \/ local$/);
      else expect(h.sub).toBe(await scopeLine(p));
      await ctx.close();
    },
    30_000,
  );
});

describe("R22: the Graph page (Ward 2026-11-05)", () => {
  it("the rail's Graph lands on /graph: the graph alone, full width; Local Dev keeps its list, actions and tabs", async () => {
    if (!browser) return;
    const p = await open({ width: 1440, height: 900 });
    // Local Dev: the list, the action row and the page tabs (.ptabs).
    for (const sel of [".sidebar", ".cmd-bar", ".ctab-bar", "#dep-graph-wrap"])
      expect([sel, await visible(p, sel)]).toEqual([sel, true]);
    const tabs = await p.$$eval(".ctab-bar [role='tab']", (els) =>
      els.map((e) => {
        const cs = getComputedStyle(e);
        return [
          e.textContent,
          e.getAttribute("aria-selected"),
          cs.fontSize,
          cs.paddingTop,
          cs.paddingLeft,
          cs.borderBottomWidth,
        ];
      }),
    );
    expect(tabs).toEqual([
      ["Graph", "true", "14px", "8px", "12px", "2px"],
      ["Applications", "false", "14px", "8px", "12px", "2px"],
      ["Config", "false", "14px", "8px", "12px", "2px"],
    ]);
    await p.click(".ctab-bar [data-ctab='apps']");
    expect(
      await p.getAttribute(".ctab-bar [data-ctab='apps']", "aria-selected"),
    ).toBe("true");
    await p.click(".ctab-bar [data-ctab='graph']");
    await p.waitForSelector(".dg-card");
    const localW = (await vpArea(p)).w;

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
    for (const sel of [".sidebar", ".cmd-bar", ".ctab-bar", ".content-header"])
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
    // The Graph page never shows another tab, whatever Local Dev had open.
    await p.context().close();
  }, 45_000);
});
