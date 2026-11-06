/**
 * Workspaces (R24, 0.3.0-dev.35, Ward 2026-11-05): Local Dev becomes an ops
 * page. One job, run your workspaces: the rail item and the page are
 * "Workspaces" (R24a; / and /local-dev still serve it, "Local Dev" stays a
 * palette alias); the list has no ⚙ Settings footer (R24b); the selected
 * workspace's header has "Open in Graph →", a ⋯ menu and, when its stacks
 * run under another namespace, a "stacks: <ns>" chip (R24c); one repo
 * table replaces the Graph, Applications and Config tabs (R24d); the runs
 * dock shows this workspace's runs, "All runs" every one (R24e).
 *
 * The distribution is the demo's (examples/distribution, product acme)
 * with neutral repos: queue (api healthy, worker down: two services),
 * web (application store, depends on queue/api), notes (standalone) in
 * workspace main, and blog and shop (a compose stack, 0.3.0-dev.37) in
 * workspace side. The checks are HTTP probes
 * against a local server this test runs (and a closed port for the down
 * one). Nothing else runs: `docker` is a shim that fails, so shop's stack
 * health never reaches a real daemon.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, BrowserContext, Page } from "playwright";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
let okServer: http.Server;
let browser: Browser | null = null;
let latest = "";
let envBase: NodeJS.ProcessEnv = {};

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
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
const api = (p: string) => `http://localhost:${port}${p}`;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wsp-")));
  root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  okServer = http.createServer((_q, r) => r.end("ok"));
  await new Promise<void>((r) => okServer.listen(0, "127.0.0.1", r));
  const ok = `http://127.0.0.1:${(okServer.address() as AddressInfo).port}/health`;
  const down = `http://127.0.0.1:${await freePort()}/health`;
  const all = ["queue", "web", "notes", "blog", "shop"];
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    all.map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  const member = (n: string) => [
    `      ${n}:`,
    "        mode: dev-managed",
    `        path: ${path.join(repos, n)}`,
  ];
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [main, side]",
      "focus: main",
      "workspaces:",
      "  main:",
      "    services:",
      ...["queue", "web", "notes"].flatMap(member),
      "  side:",
      // Its stacks share main's namespace (0.3.0-dev.36): the chip and the
      // Stacks column show it; main's own (its default suffix) shows nothing.
      "    stack_namespace: main",
      "    services:",
      ...member("blog"),
      ...member("shop"),
      "",
    ].join("\n"),
  );
  const svc = (s: string, o: { url?: string; deps?: string[] } = {}) =>
    [
      `  ${s}:`,
      ...(o.deps ? [`    depends_on: [${o.deps.join(", ")}]`] : []),
      "    commands:",
      "      local:",
      '        up: "true"',
      '        down: "true"',
      ...(o.url
        ? ["    health:", `      local: { type: http, url: '${o.url}' }`]
        : []),
      "    logs:",
      `      local: "echo ${s}-log-line"`,
    ].join("\n") + "\n";
  write(
    path.join(repos, "queue", ".acme.yml"),
    "name: queue\napplication: store\nservices:\n" +
      svc("api", { url: ok }) +
      svc("worker", { url: down }),
  );
  write(
    path.join(repos, "web", ".acme.yml"),
    "name: web\napplication: store\nservices:\n" +
      svc("web", { url: ok, deps: ["queue/api"] }),
  );
  write(
    path.join(repos, "notes", ".acme.yml"),
    "name: notes\nservices:\n" + svc("notes"),
  );
  write(
    path.join(repos, "blog", ".acme.yml"),
    "name: blog\nservices:\n" + svc("blog"),
  );
  // A compose stack: no up of its own; Den supplies the stack's.
  write(
    path.join(repos, "shop", ".acme.yml"),
    [
      "name: shop",
      "entrypoint: api",
      "compose:",
      "  name: shop",
      "services:",
      "  api: {}",
      "  worker: {}",
      "",
    ].join("\n"),
  );
  write(path.join(repos, "shop", "docker-compose.yml"), "services: {}\n");
  const shim = path.join(tmp, "bin");
  write(path.join(shim, "docker"), "#!/bin/sh\nexit 1\n");
  fs.chmodSync(path.join(shim, "docker"), 0o755);

  port = await freePort();
  envBase = {
    ...process.env,
    PATH: `${path.join(tmp, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    DEN_ROOT: root,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_EDGE_DIR: path.join(tmp, "edge-state"),
    ACME_HOME: path.join(tmp, "home", ".acme"),
    DEN_HOME: path.join(tmp, "home", ".den"),
    HOME: path.join(tmp, "home"),
    DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
    DEN_NO_OPEN: "1",
    ACME_NO_OPEN: "1",
    NO_COLOR: "1",
  };
  server = spawn(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: { ...envBase, PORT: String(port) },
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
  okServer?.close();
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

/** Workspaces for a workspace, at a size; the table drawn. */
async function open(
  ws = "main",
  url = "/",
  viewport = { width: 1440, height: 900 },
  before?: (ctx: BrowserContext) => Promise<void>,
): Promise<Page> {
  const ctx = await browser!.newContext({ viewport });
  await before?.(ctx);
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
      localStorage.setItem("acme-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(api(`${url}${url.includes("?") ? "&" : "?"}ws=${ws}`));
  await p.waitForSelector("#repo-table tbody tr.repo", { timeout: 15_000 });
  return p;
}
/** The table's repo rows, top to bottom. */
const repoOrder = (p: Page) =>
  p.$$eval("#repo-table tr.repo", (rs) =>
    rs.map((r) => (r as HTMLElement).dataset.repo),
  );
/** Wait for the health to land in the table (queue's worker reads down). */
const healthLanded = (p: Page) =>
  p.waitForSelector('#repo-table tr.fix[data-repo="queue"]', {
    timeout: 25_000,
  });

describe("R24a/b: the page is Workspaces", () => {
  it("names the rail item, the title and the header Workspaces; / and /local-dev serve it; no tabs, no ⚙ Settings footer", async () => {
    if (!browser) return;
    const p = await open();
    expect(await p.title()).toMatch(/· Workspaces$/);
    expect(
      (await p.textContent('.den-rail [data-nav="local-dev"]'))?.trim(),
    ).toBe("Workspaces");
    expect(
      (await p.textContent("#den-page-header h1, .den-ph h1"))?.trim(),
    ).toBe("Workspaces");
    // R24d: the Graph, Applications and Config tabs are gone.
    expect(
      await p.$$eval(".ctab, [data-ctab], #ctab-list", (e) => e.length),
    ).toBe(0);
    expect(await p.$$eval('#content [role="tablist"]', (e) => e.length)).toBe(
      0,
    );
    // R24b: no ⚙ Settings under the list; + new workspace stays.
    expect(await p.$("#sidebar-settings-btn")).toBeNull();
    expect(await p.$(".new-ws-form")).not.toBeNull();
    // The old route still serves the page.
    await p.goto(api("/local-dev?ws=main"));
    await p.waitForSelector("#repo-table tbody tr.repo");
    expect(await p.title()).toMatch(/· Workspaces$/);
    await p.context().close();
  }, 45_000);

  it('"Local Dev" still finds it in the palette', async () => {
    if (!browser) return;
    const p = await open();
    await p.keyboard.press("Meta+k");
    await p.keyboard.press("Control+k");
    await p.waitForSelector('[role="dialog"] input, .den-pal input', {
      timeout: 5_000,
    });
    await p.keyboard.type("Local Dev");
    await p.waitForTimeout(150);
    const options = await p.$$eval(
      '[role="listbox"] [role="option"], .den-pal [role="option"]',
      (es) => es.map((e) => e.textContent ?? ""),
    );
    expect(options.some((o) => /^Workspaces/.test(o.trim()))).toBe(true);
    await p.context().close();
  }, 30_000);
});

describe("R24c: the workspace header", () => {
  it('"Open in Graph →" lands on /graph?ws=<name> with that workspace\'s cards', async () => {
    if (!browser) return;
    const p = await open();
    expect(await p.getAttribute("#ws-open-graph", "href")).toBe(
      "/graph?ws=main",
    );
    await p.click("#ws-open-graph");
    await p.waitForURL(/\/graph\?ws=main$/);
    await p.waitForSelector(".dg-card", { timeout: 15_000 });
    const ids = await p.$$eval(".dg-card", (cs) =>
      [
        ...new Set(cs.map((c) => (c as HTMLElement).dataset.id!.split("/")[0])),
      ].sort(),
    );
    expect(ids).toEqual(["notes", "queue", "web"]);
    await p.context().close();
  }, 45_000);

  it("the ⋯ menu holds Workspace settings (to /settings?ws=<name>#workspace), Rename and Delete", async () => {
    if (!browser) return;
    const p = await open();
    const more = '#content .ws-more [data-action="toggle-svc-menu"]';
    expect(await p.getAttribute(more, "aria-label")).toBe("More for main");
    await p.click(more);
    const items = await p.$$eval("#ws-more-menu [role=menuitem]", (es) =>
      es.map((e) => ({
        text: e.textContent!.trim(),
        href: e.getAttribute("href"),
      })),
    );
    expect(items).toEqual([
      { text: "Workspace settings", href: "/settings?ws=main#workspace" },
      { text: "Rename…", href: null },
      { text: "Delete…", href: null },
    ]);
    await p.context().close();
  }, 30_000);
});

describe("stack_namespace: the header chip, /api/workspaces and workspace list", () => {
  it("/api/workspaces gives each workspace's stack namespace, its source and whether it differs", async () => {
    const body = (await (await fetch(api("/api/workspaces"))).json()) as {
      stackNamespaces: Record<string, Record<string, unknown>>;
    };
    expect(body.stackNamespaces.side).toEqual({
      workspace: "side",
      stack_namespace: "main",
      source: "workspace",
      default: "side",
      differs: true,
      warnings: [],
    });
    expect(body.stackNamespaces.main).toMatchObject({
      stack_namespace: "main",
      source: "default",
      differs: false,
    });
  });

  it('the header shows "stacks: main" for side, and no chip for main', async () => {
    if (!browser) return;
    const p = await open("side");
    await p.waitForSelector('#repo-table tr.repo[data-repo="blog"]');
    expect((await p.textContent("#content #ws-stack-ns"))?.trim()).toBe(
      "stacks: main",
    );
    await p.click('.ws-item[data-name="main"]');
    await p.waitForSelector('#repo-table tr.repo[data-repo="notes"]');
    expect(await p.$("#content #ws-stack-ns")).toBeNull();
    await p.context().close();
  }, 45_000);

  it("workspace list has a Stacks column naming side's namespace and source", () => {
    const r = spawnSync(
      path.join(ENGINE, "bin", "den"),
      ["workspace", "list"],
      {
        cwd: root,
        encoding: "utf-8",
        env: { ...envBase, FORCE_COLOR: "0" },
        timeout: 60_000,
      },
    );
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/│\s*Stacks\s*│/);
    expect(out).toMatch(/│\s*side\s*│.*│\s*main \(workspace\)\s*│/);
    expect(out).toMatch(/│\s*main\s*│.*│\s*main\s*│/);
  }, 60_000);
});

describe("R24d: one repo table", () => {
  it("is a real table: th scope, sub-rows expand by keyboard, buttons named with the repo or service", async () => {
    if (!browser) return;
    const p = await open();
    expect(
      await p.$$eval("#repo-table thead th", (t) =>
        t.map((e) => e.getAttribute("scope")),
      ),
    ).toEqual(["col", "col", "col", "col", "col", "col"]);
    expect(
      await p.$$eval("#repo-table tr.repo > th", (t) =>
        t.map((e) => e.getAttribute("scope")),
      ),
    ).toEqual(["row", "row", "row"]);
    // queue has two services: collapsed, then expanded from the keyboard.
    const exp = '#repo-table [data-action="tbl-exp"][data-repo="queue"]';
    expect(await p.getAttribute(exp, "aria-expanded")).toBe("false");
    expect(
      await p.$$eval('#repo-table tr.sub[data-repo="queue"]', (r) =>
        r.map((e) => (e as HTMLElement).hidden),
      ),
    ).toEqual([true, true]);
    await p.focus(exp);
    await p.keyboard.press("Enter");
    await p.waitForSelector(`${exp}[aria-expanded="true"]`);
    expect(
      await p.evaluate(() => document.activeElement?.getAttribute("data-repo")),
    ).toBe("queue");
    expect(
      await p.$$eval('#repo-table tr.sub[data-repo="queue"]', (r) =>
        r.map((e) => ({
          id: (e as HTMLElement).dataset.id,
          hidden: (e as HTMLElement).hidden,
        })),
      ),
    ).toEqual([
      { id: "queue/api", hidden: false },
      { id: "queue/worker", hidden: false },
    ]);
    // The sub-rows' action columns line up with the repo rows' (a sub-row
    // has no ⋯ of its own; a spacer keeps its place).
    const lefts = await p.$$eval(
      '#repo-table tr.repo [data-action="tbl-up"], #repo-table tr.sub [data-action="tbl-up"]',
      (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().left)),
    );
    expect(lefts.length).toBe(5);
    expect(new Set(lefts).size).toBe(1);
    await p.keyboard.press("Space");
    await p.waitForSelector(`${exp}[aria-expanded="false"]`);
    // Each action names what it acts on.
    const names = await p.$$eval(
      '#repo-table tr.repo[data-repo="notes"] button[data-k]',
      (b) => b.map((e) => e.getAttribute("aria-label")),
    );
    expect(names).toEqual([
      "notes: use managed",
      "Start notes",
      "Stop notes",
      "Restart notes",
      "Logs of notes",
      "More for notes",
    ]);
    expect(
      await p.$$eval('#repo-table tr.sub[data-id="queue/worker"] button', (b) =>
        b.map((e) => e.getAttribute("aria-label")),
      ),
    ).toEqual([
      "Start queue/worker",
      "Stop queue/worker",
      "Restart queue/worker",
      "Logs of queue/worker",
    ]);
    await p.context().close();
  }, 45_000);

  it("a down service sorts first, with the status drawer's fix text and buttons", async () => {
    if (!browser) return;
    const p = await open();
    await healthLanded(p);
    expect((await repoOrder(p))[0]).toBe("queue");
    const fix = await p.$eval('#repo-table tr.fix[data-repo="queue"]', (e) => ({
      text: e.querySelector(".fix-t")!.textContent!.replace(/\s+/g, " ").trim(),
      buttons: [...e.querySelectorAll("button")].map((b) =>
        b.getAttribute("aria-label"),
      ),
    }));
    expect(fix.buttons).toEqual(["Start queue/worker", "Logs of queue/worker"]);
    // The drawer's card for the same service says the same thing.
    await p.click("#den-status, .den-status-chip, [data-status-chip]");
    await p.waitForSelector('[data-start="queue/worker"]', { timeout: 8_000 });
    const card = await p.$eval('[data-start="queue/worker"]', (b) =>
      (b.closest("li, .card, [class*='prob']") ?? b.parentElement!)
        .textContent!.replace(/\s+/g, " ")
        .trim(),
    );
    const said = fix.text
      .replace(/^queue\/worker · /, "")
      .split(" · failed at")[0];
    expect(said).toMatch(/127\.0\.0\.1:\d+\/health/);
    expect(card).toContain(said);
    // A repo of several services summarises, in the problem colour; the
    // failing check is in its tooltip, its problem row and its sub-row.
    expect(
      await p.$eval(
        '#repo-table tr.repo[data-repo="queue"] .tbl-health',
        (e) => ({
          text: e.textContent,
          bad: e.classList.contains("bad"),
          title: e.getAttribute("title"),
        }),
      ),
    ).toEqual({
      text: "1/2 healthy",
      bad: true,
      title: expect.stringContaining(said),
    });
    expect(
      await p.$eval(
        '#repo-table tr.sub[data-id="queue/worker"] .tbl-health',
        (e) => e.textContent,
      ),
    ).toContain(said);
    // A healthy one reads its rollup.
    expect(
      await p.$eval(
        '#repo-table tr.repo[data-repo="web"] .tbl-health',
        (e) => e.textContent,
      ),
    ).toBe("1/1 healthy");
    await p.context().close();
  }, 60_000);

  it("Group by Application matches `acme apps`, and is kept as a user pref", async () => {
    if (!browser) return;
    const p = await open();
    await p.click('#tbl-group [data-group="app"]');
    await p.waitForSelector('#repo-table tbody[data-group^="app:"]');
    const groups = await p.$$eval("#repo-table tbody", (bs) =>
      bs.map((b) => ({
        title: b.querySelector("tr.g th")!.childNodes[0].textContent!.trim(),
        repos: [...b.querySelectorAll("tr.repo")]
          .map((r) => (r as HTMLElement).dataset.repo!)
          .sort(),
      })),
    );
    // `acme apps` (bin/acme runs Den from node_modules; this is that Den).
    const cli = spawnSync(path.join(ENGINE, "bin", "den"), ["apps", "--json"], {
      cwd: root,
      encoding: "utf-8",
      env: envBase,
    });
    const apps = (
      JSON.parse(cli.stdout) as {
        applications: { title?: string; name: string; repos: string[] }[];
      }
    ).applications.filter((a) => a.repos.length);
    const declared = apps.filter(
      (a) => a.repos.length > 1 || a.name === "store",
    );
    expect(groups[0]).toEqual({
      title: declared[0].title ?? declared[0].name,
      repos: [...declared[0].repos].sort(),
    });
    // Every repo `acme apps` lists is in the group it lists it under.
    for (const a of apps)
      for (const r of a.repos)
        expect(groups.find((g) => g.repos.includes(r))!.title).toBe(
          groups.find((g) => g.title === (a.title ?? a.name))
            ? (a.title ?? a.name)
            : "Not in an application",
        );
    // Kept: the user's settings say so, and a fresh page opens grouped.
    await p.waitForTimeout(300);
    const s = (await (await fetch(api("/api/settings"))).json()) as {
      graph?: { groupBy?: string };
    };
    expect(s.graph?.groupBy).toBe("app");
    await p.context().close();
    const q = await open();
    expect(
      await q.getAttribute('#tbl-group [data-group="app"]', "aria-pressed"),
    ).toBe("true");
    await q.click('#tbl-group [data-group="none"]');
    await q.waitForTimeout(300);
    await q.context().close();
  }, 45_000);

  it("Find filters with the Graph page's matcher", async () => {
    if (!browser) return;
    const p = await open();
    await p.fill("#tbl-find", "WORK");
    await p.waitForTimeout(100);
    expect(await repoOrder(p)).toEqual(["queue"]);
    // A match on a service opens its repo's sub-rows: only the ones it
    // matches (0.3.0-dev.37).
    expect(
      await p.$$eval('#repo-table tr.sub[data-repo="queue"]', (r) =>
        r.map((e) => ({
          id: (e as HTMLElement).dataset.id,
          hidden: (e as HTMLElement).hidden,
        })),
      ),
    ).toEqual([
      { id: "queue/api", hidden: true },
      { id: "queue/worker", hidden: false },
    ]);
    // A match on the repo shows every one of its services.
    await p.fill("#tbl-find", "queue");
    await p.waitForTimeout(100);
    expect(
      await p.$$eval('#repo-table tr.sub[data-repo="queue"]', (r) =>
        r.map((e) => (e as HTMLElement).hidden),
      ),
    ).toEqual([false, false]);
    await p.fill("#tbl-find", "nothing-like-it");
    await p.waitForTimeout(100);
    expect(await p.textContent("#repo-table .tbl-none")).toMatch(
      /No repo matches/,
    );
    await p.fill("#tbl-find", "");
    await p.waitForTimeout(100);
    expect((await repoOrder(p)).sort()).toEqual(["notes", "queue", "web"]);
    await p.context().close();
  }, 30_000);

  it('health cells say "checking…" until the first health round lands', async () => {
    if (!browser) return;
    // Hold every health request: the first round never lands.
    const p = await open("main", "/", undefined, async (ctx) => {
      await ctx.route("**/api/health**", () => {
        /* never answered */
      });
    });
    await p.click('#repo-table [data-action="tbl-exp"][data-repo="queue"]');
    const cells = await p.$$eval(
      "#repo-table tr.repo .tbl-health, #repo-table tr.sub .tbl-health",
      (es) =>
        es.map((e) => ({
          text: e.textContent,
          bad: e.classList.contains("bad"),
          pending: !!e.querySelector(".den-dot.pending"),
        })),
    );
    expect(cells.length).toBe(5);
    for (const c of cells)
      expect(c).toEqual({ text: "checking…", bad: false, pending: true });
    await p.context().close();
  }, 30_000);

  it("a compose-stack repo's Start and Restart run what `up <repo>` starts", async () => {
    if (!browser) return;
    // The decision `up shop` makes (resolveUpTargets): the stack's up,
    // through its entry service.
    const list = (await (
      await fetch(api("/api/services?env=local&workspace=side"))
    ).json()) as {
      address: string;
      commands: string[];
      upTargets?: string[];
    }[];
    const shop = list.filter((s) => s.address.startsWith("shop/"));
    expect(shop.map((s) => s.upTargets)).toEqual([["shop/api"], ["shop/api"]]);
    expect(shop.find((s) => s.address === "shop/api")!.commands).toEqual(
      expect.arrayContaining(["up", "down", "restart"]),
    );
    const asked: { cmd: string | null; addresses: string | null }[] = [];
    for (const k of ["up", "restart"]) {
      // The run itself is held: only what the row asks for is checked.
      const p = await open("side", "/", undefined, async (ctx) => {
        // Unlocked (passwordless), so the row's action is not held for sudo.
        await ctx.route("**/api/sudo-password/status", (route) =>
          route.fulfill({ json: { set: false, passwordless: true } }),
        );
        await ctx.route("**/api/workspace/exec**", (route) => {
          const q = new URL(route.request().url()).searchParams;
          asked.push({ cmd: q.get("cmd"), addresses: q.get("addresses") });
          return route.abort();
        });
      });
      const sel = `#repo-table tr.repo[data-repo="shop"] [data-action="tbl-${k}"]`;
      await p.waitForSelector(sel);
      expect(
        await p.$eval(sel, (b) => ({
          disabled: (b as HTMLButtonElement).disabled,
          title: b.getAttribute("title"),
        })),
      ).toEqual({ disabled: false, title: null });
      const before = asked.length;
      await p.click(sel);
      for (let i = 0; i < 50 && asked.length === before; i++)
        await p.waitForTimeout(100);
      await p.context().close();
    }
    expect(asked).toEqual([
      { cmd: "up", addresses: "shop/api" },
      { cmd: "restart", addresses: "shop/api" },
    ]);
  }, 60_000);

  it("+ Add repo sits under the table; at 1440×900 nothing scrolls sideways", async () => {
    if (!browser) return;
    const p = await open();
    expect((await p.textContent(".tbl-foot .add-svc-open-btn"))?.trim()).toBe(
      "+ Add repo",
    );
    const w = await p.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      view: window.innerWidth,
      wrap: (() => {
        const t = document.querySelector(".tablewrap")!;
        return t.scrollWidth - t.clientWidth;
      })(),
    }));
    expect(w.doc).toBeLessThanOrEqual(w.view);
    expect(w.wrap).toBe(0);
    await p.context().close();
  }, 30_000);
});

describe("R24e: the runs dock follows the workspace", () => {
  it("shows only this workspace's runs; All runs shows every one", async () => {
    if (!browser) return;
    const p = await open();
    const tabs = () =>
      p.$$eval("#den-dock .den-rtab", (t) =>
        t.map((e) => e.textContent!.replace(/,.*$/, "").trim()),
      );
    await p.click('#repo-table [aria-label="Logs of notes"]');
    await p.waitForFunction(() =>
      [...document.querySelectorAll("#den-dock .den-rtab")].some((e) =>
        e.textContent!.includes("notes"),
      ),
    );
    // To side: its own run, not main's.
    await p.click('.ws-item[data-name="side"]');
    await p.waitForSelector('#repo-table tr.repo[data-repo="blog"]');
    await p.click('#repo-table [aria-label="Logs of blog"]');
    await p.waitForFunction(() =>
      [...document.querySelectorAll("#den-dock .den-rtab")].some((e) =>
        e.textContent!.includes("blog"),
      ),
    );
    expect(await tabs()).toEqual(["blog"]);
    const all = '#den-dock [data-dock="all"]';
    expect(await p.getAttribute(all, "aria-pressed")).toBe("false");
    await p.click(all);
    expect((await tabs()).sort()).toEqual(["blog", "notes"]);
    expect(await p.getAttribute(all, "aria-pressed")).toBe("true");
    // Back to main: its run only (a new scope starts filtered).
    await p.click('.ws-item[data-name="main"]');
    await p.waitForSelector('#repo-table tr.repo[data-repo="notes"]');
    expect(await tabs()).toEqual(["notes"]);
    await p.context().close();
  }, 60_000);
});
