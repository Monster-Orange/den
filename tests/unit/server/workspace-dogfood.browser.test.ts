/**
 * WS-6 dogfood findings (0.4.5) in a real browser.
 *
 * The demo distribution (examples/distribution, product acme), three
 * workspaces on this machine: north (notes, api, blog), south (api, mail)
 * and west (mail, wiki). api and mail are shared. notes and api answer
 * their checks; blog was started by Den but its process died without
 * `down` (a daemon record whose process group is gone) and its check
 * fails; mail (two services) and wiki fail their checks and have no
 * record: stopped. Nothing is ever started: dialogs are only opened, and
 * `docker` is a shim that fails. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
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
import { recordProcessGroup } from "../../../src/shared/process/process-group.js";
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

/** A process group this test starts and kills: its record outlives it. */
async function deadGroup(): Promise<{ pgid: number; startedAt: string }> {
  const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
  const pid = child.pid!;
  const rec = recordProcessGroup(pid);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  process.kill(-pid, "SIGKILL");
  await exited;
  if (!rec) throw new Error("could not read the test's own process");
  return rec;
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-ws6d-")));
  root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  okServer = http.createServer((_q, r) => r.end("ok"));
  await new Promise<void>((r) => okServer.listen(0, "localhost", r));
  const ok = `http://localhost:${(okServer.address() as AddressInfo).port}/health`;
  const down = `http://localhost:${await freePort()}/health`;
  // repo → its services and their checks.
  const REPOS: [string, [string, string][]][] = [
    ["notes", [["notes", ok]]],
    ["api", [["api", ok]]],
    ["blog", [["blog", down]]],
    [
      "mail",
      [
        ["web", down],
        ["worker", down],
      ],
    ],
    ["wiki", [["wiki", down]]],
  ];
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    REPOS.map(([r]) => `${r}:\n  gh: acme/${r}\n`).join(""),
  );
  const WS: [string, string[]][] = [
    ["north", ["notes", "api", "blog"]],
    ["south", ["api", "mail"]],
    ["west", ["mail", "wiki"]],
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
  for (const [repo, svcs] of REPOS)
    write(
      path.join(repos, repo, ".acme.yml"),
      [
        `name: ${repo}`,
        "services:",
        ...svcs.flatMap(([svc, url]) => [
          `  ${svc}:`,
          "    commands:",
          "      local:",
          '        up: "true"',
          '        down: "true"',
          "    health:",
          `      local: { type: http, url: '${url}' }`,
        ]),
        "",
      ].join("\n"),
    );
  // blog: Den started it, then its process died without `down`.
  const g = await deadGroup();
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
          workspaces: ["north"],
          pgid: g.pgid,
          pgidStartedAt: g.startedAt,
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

async function open(route: string, width = 1440, height = 900): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height },
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
/** The text of `sel` once it matches `re` (whitespace collapsed). */
async function textWhen(p: Page, sel: string, re: RegExp): Promise<string> {
  await p
    .waitForFunction(
      ([s, src]) =>
        new RegExp(src).test(
          (document.querySelector(s)?.textContent ?? "").replace(/\s+/g, " "),
        ),
      [sel, re.source] as const,
      { timeout: 20_000 },
    )
    .catch(() => undefined);
  return ((await p.textContent(sel)) ?? "").replace(/\s+/g, " ").trim();
}

describe("a service whose process died without down (finding 1)", () => {
  it("/api/health: it doesn't run, and it is down", async () => {
    const rows = JSON.parse(
      (await request("GET", "/api/health?refresh=1")).body,
    ) as { repo: string; running?: boolean; down?: boolean; ok: unknown }[];
    const blog = rows.find((r) => r.repo === "blog");
    expect(blog && [blog.ok, blog.running, blog.down]).toEqual([
      false,
      false,
      true,
    ]);
  }, 60_000);

  it("the header reads Partial 2/3 · 1 down (findings 1 and 9)", async () => {
    if (!browser) return;
    await setFocus("north");
    const p = await open("/local-dev");
    await p.waitForSelector("#repo-table tbody tr.repo", { timeout: 15_000 });
    expect(await textWhen(p, "#ws-head-pill", /Partial|Running/)).toBe(
      "Partial 2/3 · 1 down",
    );
    await p.context().close();
  }, 90_000);

  it("Stop & Switch lists it under Starts", async () => {
    if (!browser) return;
    await setFocus("all");
    const p = await open("/local-dev");
    await p.waitForSelector("#ws-all-table tbody tr[data-ws]", {
      timeout: 15_000,
    });
    await textWhen(p, "#ws-all-table", /1 down/);
    await p.click('#ws-all-table [data-swmenu="north"]');
    await p.click(".den-swm [data-stopswitch]");
    await p.waitForSelector(".den-dlg", { timeout: 5_000 });
    const items = await p.$$eval(".den-dlg li", (l) =>
      l.map((e) => e.textContent?.trim()),
    );
    expect(
      items.slice(items.indexOf("Starts"), items.indexOf("Starts") + 2),
    ).toEqual(["Starts", "1 service in north"]);
    await p.keyboard.press("Escape");
    await p.context().close();
  }, 90_000);
});

describe("the repo table is never clipped (finding 3)", () => {
  for (const [w, h] of [
    [1440, 720],
    [390, 844],
  ])
    it(`shows every row at ${w}px, with the Agents section below`, async () => {
      if (!browser) return;
      await setFocus("north");
      const p = await open("/local-dev", w, h);
      await p.waitForSelector("#repo-table tbody tr.repo", {
        timeout: 15_000,
      });
      await p.waitForSelector("#agents-section");
      const box = await p.$eval("#repo-table", (t) => {
        const wrap = t.closest(".tablewrap") as HTMLElement;
        return { client: wrap.clientHeight, scroll: wrap.scrollHeight };
      });
      expect(box.client).toBe(box.scroll);
      await p.context().close();
    }, 90_000);
});

describe("Settings › Workspaces (finding 4)", () => {
  it("a click marks the choice pressed at once, and it is stored", async () => {
    if (!browser) return;
    const p = await open("/settings#workspaces");
    const ask = p.getByRole("button", { name: "Ask whether to start it" });
    const show = p.getByRole("button", { name: "Just show it" });
    await ask.waitFor({ timeout: 15_000 });
    expect(await show.getAttribute("aria-pressed")).toBe("true");
    await ask.click();
    await p.waitForFunction(
      () =>
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent === "Ask whether to start it")
          ?.getAttribute("aria-pressed") === "true",
      undefined,
      { timeout: 10_000 },
    );
    expect(await show.getAttribute("aria-pressed")).toBe("false");
    const s = JSON.parse((await request("GET", "/api/settings")).body) as {
      switching: { on_pick: string };
    };
    expect(s.switching.on_pick).toBe("ask");
    await request("POST", "/api/settings", { switching: null });
    await p.context().close();
  }, 90_000);
});

describe("one focus for the page, the top bar and the breadcrumb (finding 7)", () => {
  it("a tab left open shows the focus after it moved elsewhere and a reload", async () => {
    if (!browser) return;
    await setFocus("north");
    const p = await open("/local-dev");
    await p.waitForFunction(
      () => new URL(location.href).searchParams.get("ws") === "north",
      undefined,
      { timeout: 15_000 },
    );
    // The focus moves elsewhere (the CLI's `focus --all` writes the same).
    await setFocus("all");
    await p.reload();
    await p.waitForSelector("#ws-all-table", { timeout: 15_000 });
    const pill = await textWhen(p, "#ws-pill .den-vn", /All workspaces/);
    const crumb = await textWhen(p, ".den-ph .sub", /All workspaces/);
    expect([
      pill,
      /\bnorth\b/.test(crumb),
      /All workspaces/.test(crumb),
    ]).toEqual(["All workspaces", false, true]);
    await p.context().close();
  }, 90_000);
});

describe("a stopped shared repo reads as stopped, not failing (finding 8)", () => {
  it("grey 'stopped', no problem rows, while the pill says Stopped", async () => {
    if (!browser) return;
    await setFocus("west");
    const p = await open("/local-dev");
    await p.waitForSelector('#repo-table tr.repo[data-repo="mail"]', {
      timeout: 15_000,
    });
    expect(await textWhen(p, "#ws-head-pill", /Stopped/)).toBe("Stopped");
    const mail = await textWhen(
      p,
      '#repo-table tr.repo[data-repo="mail"] .tbl-health',
      /stopped|healthy/,
    );
    expect(mail).toBe("stopped");
    expect(
      await p.$eval(
        '#repo-table tr.repo[data-repo="mail"] .tbl-health',
        (e) => ({
          bad: e.classList.contains("bad"),
          dot: e.querySelector(".den-dot")?.className,
        }),
      ),
    ).toEqual({ bad: false, dot: "den-dot off" });
    expect(await p.$$('#repo-table tr.fix[data-repo="mail"]')).toHaveLength(0);
    await p.context().close();
  }, 90_000);
});
