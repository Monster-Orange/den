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
    REPOS.map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [main]",
      "focus: main",
      "workspaces:",
      "  main:",
      "    services:",
      ...REPOS.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  for (const n of REPOS)
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

async function open(o: { keep?: boolean } = {}): Promise<Page> {
  if (!o.keep)
    await fetch(api("/api/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph: { workspaces: "open" } }),
    });
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(api("/local-dev?ws=main"));
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
