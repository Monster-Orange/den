/**
 * WS-6.4: health is known for every workspace, whatever is in focus. The
 * Workspaces page showed "unknown" for a workspace outside the view: the
 * view scope fed both what the health poll checked and what was shown.
 * Now the poll covers every active workspace, and the scope filters only
 * what the top bar counts.
 *
 * The demo distribution (examples/distribution, product acme): workspace
 * north (the focus, repo notes) and south (repo blog), both active, the view
 * scope north. blog's check is an HTTP probe of a local server this test
 * runs, so it is healthy; notes' probe is a closed port, so it is down.
 * Nothing else runs: `docker` is a shim that fails.
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
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
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
const api = (p: string) => `http://localhost:${port}${p}`;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-ws64-")));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  okServer = http.createServer((_q, r) => r.end("ok"));
  await new Promise<void>((r) => okServer.listen(0, "localhost", r));
  const ok = `http://localhost:${(okServer.address() as AddressInfo).port}/health`;
  const down = `http://localhost:${await freePort()}/health`;
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "notes:\n  gh: acme/notes\nblog:\n  gh: acme/blog\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north, south]",
      "focus: north",
      "workspaces:",
      ...[
        ["north", "notes"],
        ["south", "blog"],
      ].flatMap(([ws, repo]) => [
        `  ${ws}:`,
        "    services:",
        `      ${repo}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, repo)}`,
      ]),
      "",
    ].join("\n"),
  );
  // The view shows north only: south is outside it.
  write(
    path.join(root, "config", "local", "user.yml"),
    "view:\n  scope: north\n",
  );
  for (const [repo, url] of [
    ["notes", down],
    ["blog", ok],
  ])
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
      if ((await fetch(api("/api/server-info"))).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (server.exitCode !== null || Date.now() > deadline)
      throw new Error(`the web server did not start:\n${serverOut}`);
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
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The Workspaces page for `ws`, its repo table drawn. */
async function open(ws: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("acme-changelog-seen", v);
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(api(`/?ws=${ws}`));
  await p.waitForSelector("#repo-table tbody tr.repo", { timeout: 15_000 });
  return p;
}

/** A repo row's health cell, once a health round has landed: its state and text. */
async function healthOf(p: Page, repo: string) {
  const cell = `#repo-table tr.repo[data-repo="${repo}"] .tbl-health`;
  await p.waitForFunction(
    (sel) => {
      const t = document.querySelector(sel)?.textContent ?? "";
      return t !== "" && !/checking/i.test(t);
    },
    cell,
    { timeout: 30_000 },
  );
  return p.$eval(cell, (e) => ({
    cls: e.className,
    text: (e.textContent ?? "").trim(),
  }));
}

describe("WS-6.4: a workspace outside the view", () => {
  it("shows its real health on the Workspaces page (not unknown); the top bar still counts only what is in view", async () => {
    if (!browser) return;
    const p = await open("south");
    const blog = await healthOf(p, "blog");
    expect(blog.text).toBe("1/1 healthy");
    expect(blog.cls).not.toMatch(/\bunk\b/);
    // The status chip counts the view (north: notes is down), never blog.
    await p.waitForFunction(
      () =>
        /down/i.test(document.querySelector("#den-status")?.textContent ?? ""),
      undefined,
      { timeout: 30_000 },
    );
    // notes only: 0/1 (with blog it would read 1/2).
    const chip = (await p.textContent("#den-status"))?.trim() ?? "";
    expect(chip).toBe("0/1 healthy · 1 down");
    await p.context().close();
  }, 90_000);
});
