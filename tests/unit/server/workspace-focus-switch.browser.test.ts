/**
 * WS-6 (0.4.3) in a real browser: focus, status and switch.
 *
 * The demo distribution (examples/distribution, product acme), with four
 * workspaces. On this machine: north (notes, api), south (blog, api) and
 * west (wiki); east (docs) is not. api is shared by north and south.
 * notes and api answer their checks (a local server this test runs); blog
 * fails its check but Den tracks it as started, so it is down; wiki fails
 * and isn't tracked, so it is stopped. Nothing is ever started: Switch is
 * only clicked through to its dialog, and `docker` is a shim that fails.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { denAuth } from "./helpers/den-auth.js";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let port = 0;
let server: ChildProcess | undefined;
let serverOut = "";
let okServer: http.Server;
let browser: Browser | null = null;
let latest = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
/** One request on its own connection (no keep-alive reuse). */
function request(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "localhost",
        port,
        path: p,
        method,
        agent: false,
        timeout: 15_000,
        headers: {
          ...(method === "GET" ? {} : denAuth(path.join(tmp, "home", ".acme"))),
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              }
            : {}),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (c: Buffer) => (out += c.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: out }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(data);
  });
}
const setFocus = (v: string) => request("POST", "/api/scope", { focus: v });

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-ws6-")));
  root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  okServer = http.createServer((_q, r) => r.end("ok"));
  await new Promise<void>((r) => okServer.listen(0, "localhost", r));
  const ok = `http://localhost:${(okServer.address() as AddressInfo).port}/health`;
  const down = `http://localhost:${await freePort()}/health`;
  const REPOS: [string, string][] = [
    ["notes", ok],
    ["api", ok],
    ["blog", down],
    ["wiki", down],
    ["docs", down],
  ];
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    REPOS.map(([r]) => `${r}:\n  gh: acme/${r}\n`).join(""),
  );
  const WS: [string, string[]][] = [
    ["north", ["notes", "api"]],
    ["south", ["blog", "api"]],
    ["west", ["wiki"]],
    ["east", ["docs"]],
  ];
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north, south, west]",
      "focus: north",
      "workspaces:",
      ...WS.flatMap(([ws, rs]) => [
        `  ${ws}:`,
        "    services:",
        ...rs.flatMap((r) => [
          `      ${r}:`,
          "        mode: dev-managed",
          `        path: ${path.join(repos, r)}`,
        ]),
      ]),
      "",
    ].join("\n"),
  );
  for (const [repo, url] of REPOS)
    write(
      path.join(repos, repo, ".acme.yml"),
      [
        `name: ${repo}`,
        "services:",
        `  ${repo}:`,
        "    commands:",
        "      local:",
        '        up: "true"',
        '        down: "true"',
        "    health:",
        `      local: { type: http, url: '${url}' }`,
        "",
      ].join("\n"),
    );
  // blog runs (Den tracks it) but fails its check: down. wiki: stopped.
  write(
    path.join(tmp, "daemons.json"),
    JSON.stringify({
      daemons: [
        {
          address: "blog",
          repoName: "blog",
          subsystem: "blog",
          repoPath: path.join(repos, "blog"),
          logPath: path.join(tmp, "blog.log"),
          startedAt: new Date().toISOString(),
          workspaces: ["south"],
        },
      ],
    }),
  );
  write(path.join(tmp, "bin", "docker"), "#!/bin/sh\nexit 1\n", 0o755);

  port = await freePort();
  const home = path.join(tmp, "home");
  server = spawnServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        HOME: home,
        PATH: `${path.join(tmp, "bin")}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
        TMPDIR: os.tmpdir(),
        LANG: "C",
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        ACME_HOME: path.join(home, ".acme"),
        DEN_HOME: path.join(home, ".den"),
        DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
        DEN_NO_OPEN: "1",
        ACME_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await request("GET", "/api/server-info")).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error(`the web server did not start:\n${serverOut}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  latest =
    (
      JSON.parse((await request("GET", "/api/changelog")).body) as {
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
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function open(route: string, width = 1440): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("acme-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${port}${route}`);
  return p;
}
/** Wait until a health round has painted the chip. */
async function healthPainted(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const t = document.querySelector("#den-status")?.textContent ?? "";
      return t !== "" && !/checking/i.test(t);
    },
    undefined,
    { timeout: 30_000 },
  );
}
/** The Workspace menu's rows: name, checked, pill, whether it has a split button. */
const menuRows = (p: Page) =>
  p.$$eval("#den-pop-ws .den-wsrow", (rows) =>
    rows.map((r) => ({
      focus: r.querySelector("[data-focus]")?.getAttribute("data-focus"),
      checked: r.querySelector("[data-focus]")?.getAttribute("aria-checked"),
      pill: r.querySelector(".den-wsp")?.textContent ?? null,
      split: !!r.querySelector(".den-split"),
    })),
  );

describe("WS-6.6: the top bar's Workspace menu", () => {
  it("the focus first (✓), then All, then the rest, each with its pill and [Switch | ▾]", async () => {
    if (!browser) return;
    await setFocus("south");
    const p = await open("/services");
    await healthPainted(p);
    await p.click("#ws-pill");
    await p.waitForSelector("#den-pop-ws .den-wsrow");
    // Health lands after the menu can open: wait for the pills.
    await p.waitForFunction(
      () =>
        !/Not checked/.test(
          document.querySelector("#den-pop-ws")?.textContent ?? "",
        ),
      undefined,
      { timeout: 30_000 },
    );
    expect(await menuRows(p)).toEqual([
      { focus: "south", checked: "true", pill: "Running 2/2", split: true },
      { focus: "all", checked: "false", pill: null, split: false },
      { focus: "north", checked: "false", pill: "Running 2/2", split: true },
      { focus: "west", checked: "false", pill: "Stopped", split: true },
    ]);
    // south's row says 1 down; the footer links to the settings.
    expect(
      await p.textContent(
        '#den-pop-ws .den-wsrow:has([data-focus="south"]) .den-downn',
      ),
    ).toBe("1 down");
    expect(await p.getAttribute("#den-pop-ws .den-foot2 a", "href")).toBe(
      "/settings#workspaces",
    );
    // The chevron is an SVG, centred in its button (±1px).
    const c = await p.$eval('#den-pop-ws [data-swmenu="north"]', (b) => {
      const r = b.getBoundingClientRect();
      const s = b.querySelector("svg")!.getBoundingClientRect();
      return [
        Math.abs(r.left + r.width / 2 - (s.left + s.width / 2)),
        Math.abs(r.top + r.height / 2 - (s.top + s.height / 2)),
      ];
    });
    expect(c[0]).toBeLessThanOrEqual(1);
    expect(c[1]).toBeLessThanOrEqual(1);
    await p.context().close();
  }, 90_000);
});

describe("WS-6.5: the status chip", () => {
  it("counts what is in focus and adds '· n down in <ws>' for a problem elsewhere", async () => {
    if (!browser) return;
    await setFocus("north");
    const p = await open("/services");
    await healthPainted(p);
    await p.waitForFunction(
      () =>
        /down in south/.test(
          document.querySelector("#den-status")?.textContent ?? "",
        ),
      undefined,
      { timeout: 30_000 },
    );
    const chip = (await p.textContent("#den-status"))
      ?.replace(/\s+/g, " ")
      .trim();
    // north (notes, api) is healthy; blog in south is down.
    expect(chip).toMatch(/2 healthy · 1 down in south$/);
    expect(await p.getAttribute("#den-status", "class")).toMatch(/\bbad\b/);
    await p.context().close();
  }, 90_000);

  it("reads 'Nothing running' when nothing in focus runs, and cuts off with … on a phone", async () => {
    if (!browser) return;
    await setFocus("west");
    const p = await open("/services", 390);
    await healthPainted(p);
    await p.waitForFunction(
      () =>
        /Nothing running/.test(
          document.querySelector("#den-status")?.textContent ?? "",
        ),
      undefined,
      { timeout: 30_000 },
    );
    const n = await p.$eval("#den-status .den-n", (e) => {
      const cs = getComputedStyle(e);
      return {
        text: e.textContent,
        overflow: cs.textOverflow,
        cut: e.scrollWidth > e.clientWidth,
      };
    });
    expect(n.text).toMatch(/^Nothing running/);
    expect(n.overflow).toBe("ellipsis");
    expect(n.cut).toBe(true);
    // No horizontal page scroll at phone width.
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await p.context().close();
  }, 90_000);
});

describe("WS-6.9: the Workspaces page", () => {
  it("All workspaces: explainer cards, the list, and the table with status, services, down, agents and [Switch | ▾]", async () => {
    if (!browser) return;
    await setFocus("all");
    const p = await open("/local-dev");
    await p.waitForSelector("#ws-all-table tbody tr[data-ws]", {
      timeout: 15_000,
    });
    await p.waitForFunction(
      () =>
        !/Not checked/.test(
          document.querySelector("#ws-all-table")?.textContent ?? "",
        ),
      undefined,
      { timeout: 30_000 },
    );
    expect(
      await p.$$eval(".ws-howto b", (b) => b.map((e) => e.textContent)),
    ).toEqual([
      "Focus · what you see",
      "Status · what's running",
      "Switch · show it and start it",
    ]);
    expect(
      await p.$$eval("#ws-all-table thead th", (h) =>
        h.map((e) => e.textContent?.trim()),
      ),
    ).toEqual(["Workspace", "Status", "Services", "Down", "Agents", "Actions"]);
    const rows = await p.$$eval("#ws-all-table tbody tr[data-ws]", (rs) =>
      rs.map((r) =>
        [...r.children].slice(0, 5).map((c) => c.textContent?.trim()),
      ),
    );
    expect(rows).toEqual([
      ["north", "Running 2/2", "2/2", "—", "—"],
      ["south", "Running 2/2", "2/2", "1 down", "—"],
      ["west", "Stopped", "0/1", "—", "—"],
    ]);
    expect(await p.$$("#ws-all-table .den-split")).toHaveLength(3);
    // The list: All first (current), then every workspace; east muted.
    const list = await p.$$eval("#ws-list .ws-item", (it) =>
      it.map((e) => ({
        name: e.querySelector(".ws-nm")?.textContent,
        current: e.getAttribute("aria-current"),
        off: e.classList.contains("off"),
        pill: e.querySelector(".den-wsp")?.textContent ?? null,
      })),
    );
    expect(list).toEqual([
      { name: "All workspaces", current: "true", off: false, pill: null },
      { name: "north", current: "false", off: false, pill: "Running 2/2" },
      { name: "south", current: "false", off: false, pill: "Running 2/2" },
      { name: "west", current: "false", off: false, pill: "Stopped" },
      { name: "east", current: "false", off: true, pill: null },
    ]);
    expect(await p.textContent("#ws-list")).not.toMatch(/\(active\)|Activate/);
    await p.context().close();
  }, 90_000);

  it("picking a workspace in the list sets the focus (workspaces.yml) and shows it in place", async () => {
    if (!browser) return;
    await setFocus("all");
    const p = await open("/local-dev");
    await p.waitForSelector("#ws-all-table", { timeout: 15_000 });
    await p.click('#ws-list .ws-item[data-pick="south"] .ws-nm');
    await p.waitForSelector("#repo-table tbody tr.repo", { timeout: 15_000 });
    expect(new URL(p.url()).searchParams.get("ws")).toBe("south");
    const ws = fs.readFileSync(
      path.join(root, "config", "local", "workspaces.yml"),
      "utf-8",
    );
    expect(ws).toMatch(/^focus: south$/m);
    // The header: pill, down count, Stop, the split button (primary),
    // Open in Graph and Open in Agents; api is shared with north.
    await p.waitForFunction(
      () =>
        /Running 2\/2/.test(
          document.querySelector("#ws-head-status")?.textContent ?? "",
        ),
      undefined,
      { timeout: 30_000 },
    );
    const head = await p.$eval("#ws-head-status", (e) => ({
      pill: e.querySelector(".den-wsp")?.textContent,
      down: e.querySelector(".den-downn")?.textContent,
      buttons: [...e.querySelectorAll("button")].map((b) =>
        (b.getAttribute("aria-label") ?? b.textContent ?? "").trim(),
      ),
      primary: e
        .querySelector(".den-split .den-btn")
        ?.classList.contains("primary"),
    }));
    expect(head).toEqual({
      pill: "Running 2/2",
      down: "1 down",
      buttons: ["Stop", "Switch", "More ways to switch to south"],
      primary: true,
    });
    expect(await p.getAttribute("#ws-open-agents", "href")).toBe(
      "/agents?ws=south",
    );
    expect(
      await p.textContent('#repo-table tr.repo[data-repo="api"] .ws-shared'),
    ).toBe("shared");
    expect(
      await p.$$('#repo-table tr.repo[data-repo="blog"] .ws-shared'),
    ).toHaveLength(0);
    await p.context().close();
  }, 90_000);

  it("Stop & Switch asks first: what stops, what starts and what keeps running", async () => {
    if (!browser) return;
    await setFocus("all");
    const p = await open("/local-dev");
    await p.waitForSelector("#ws-all-table tbody tr[data-ws]", {
      timeout: 15_000,
    });
    await p.waitForFunction(
      () =>
        /1 down/.test(
          document.querySelector("#ws-all-table")?.textContent ?? "",
        ),
      undefined,
      { timeout: 30_000 },
    );
    await p.click('#ws-all-table [data-swmenu="west"]');
    await p.waitForSelector(".den-swm");
    expect(
      await p.$$eval(".den-swm .den-mi b", (b) => b.map((e) => e.textContent)),
    ).toEqual(["Switch", "Stop & Switch"]);
    await p.click(".den-swm [data-stopswitch]");
    await p.waitForSelector(".den-dlg");
    const dlg = await p.$eval(".den-dlg", (d) => ({
      title: d.querySelector("h2")?.textContent,
      items: [...d.querySelectorAll("li")].map((l) => l.textContent?.trim()),
    }));
    // What runs outside west stops (api, which north and south share, once:
    // it isn't west's), then wiki starts.
    expect(dlg.title).toBe("Stop & Switch to west?");
    expect(dlg.items).toEqual([
      "Stops",
      "2 services in north (notes, api)",
      "1 service in south (blog)",
      "Starts",
      "1 service in west",
    ]);
    await p.click('.den-dlg [data-x="cancel"]');
    expect(await p.$$(".den-dlg")).toHaveLength(0);
    // Nothing changed: the focus is still all.
    expect(
      fs.readFileSync(
        path.join(root, "config", "local", "workspaces.yml"),
        "utf-8",
      ),
    ).toMatch(/^focus: all$/m);
    await p.context().close();
  }, 90_000);

  it("Stop & Switch keeps a shared repo's services running", async () => {
    if (!browser) return;
    await setFocus("all");
    const p = await open("/local-dev");
    await p.waitForFunction(
      () =>
        /1 down/.test(
          document.querySelector("#ws-all-table")?.textContent ?? "",
        ),
      undefined,
      { timeout: 30_000 },
    );
    await p.click('#ws-all-table [data-swmenu="north"]');
    await p.click(".den-swm [data-stopswitch]");
    await p.waitForSelector(".den-dlg");
    const items = await p.$$eval(".den-dlg li", (l) =>
      l.map((e) => e.textContent?.trim()),
    );
    expect(items).toEqual([
      "Stops",
      "1 service in south (blog)",
      "Keeps running",
      "api (shared with south)",
    ]);
    await p.keyboard.press("Escape");
    await p.context().close();
  }, 90_000);
});

describe("WS-6.10: Settings › Workspaces", () => {
  it("has When I pick a workspace and Before Stop & Switch, and stores a choice", async () => {
    if (!browser) return;
    const p = await open("/settings#workspaces");
    await p.waitForSelector("text=When I pick a workspace", {
      timeout: 15_000,
    });
    const text = (await p.textContent("body")) ?? "";
    expect(text).toContain("When I pick a workspace");
    expect(text).toContain("Before Stop & Switch");
    expect(text).toContain("Just show it");
    expect(text).toContain("Ask whether to start it");
    expect(text).toContain("Start it automatically");
    expect(text).toContain("Don't ask");
    const r = await request("POST", "/api/settings", {
      switching: { on_pick: "ask" },
    });
    expect(r.status).toBe(200);
    const s = JSON.parse((await request("GET", "/api/settings")).body) as {
      switching: unknown;
    };
    expect(s.switching).toEqual({ on_pick: "ask", confirm_stop_switch: true });
    expect(
      fs.readFileSync(path.join(root, "config", "local", "user.yml"), "utf-8"),
    ).toMatch(/switching:\n\s+on_pick: ask/);
    await request("POST", "/api/settings", { switching: null });
    await p.context().close();
  }, 90_000);
});
