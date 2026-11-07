/**
 * A service's command runs in the workspace its row belongs to, from the
 * Services page and the tests page's services view alike, in a real
 * browser on the real web server. Two active workspaces: north (focus)
 * with shop, south with bank. bank's `setup` used to run against the
 * focused workspace and fail: `Command "setup" not found for bank/bank …
 * Active workspace: north`. Every command here is an `echo`.
 *
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
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
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
      {
        host: "localhost",
        port,
        path: p,
        timeout: 5_000,
        agent: false,
        headers: { Connection: "close" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

const manifest = (name: string) =>
  [
    `name: ${name}`,
    "services:",
    `  ${name}:`,
    "    commands:",
    "      local:",
    `        setup: "echo ${name}-setup-ran"`,
    "",
  ].join("\n");

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-svcws-")));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\nbank:\n  gh: acme/bank\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north, south]",
      "focus: north",
      "workspaces:",
      "  north:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${path.join(repos, "shop")}`,
      "  south:",
      "    services:",
      "      bank:",
      "        mode: dev-managed",
      `        path: ${path.join(repos, "bank")}`,
      "",
    ].join("\n"),
  );
  write(path.join(repos, "shop", ".acme.yml"), manifest("shop"));
  write(path.join(repos, "bank", ".acme.yml"), manifest("bank"));
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
        ACME_HOME: path.join(tmp, "home", ".acme"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
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
      (await (
        await fetch(`http://localhost:${port}/api/changelog`, {
          headers: { Connection: "close" },
        })
      ).json()) as { version: string }[]
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

async function open(url: string): Promise<{ p: Page; execs: string[] }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 800 },
  });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("acme-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  const execs: string[] = [];
  p.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname === "/api/service/exec") execs.push(u.search);
  });
  await p.goto(`http://localhost:${port}${url}`);
  return { p, execs };
}

/** The dock's text for the latest run, once it has finished. */
async function runOutput(p: Page): Promise<string> {
  await p.waitForFunction(
    () =>
      /(Done|done|Failed|failed) in/.test(
        (
          window as unknown as { denShell: { runs: { text: () => string } } }
        ).denShell.runs.text(),
      ),
    undefined,
    { timeout: 20_000 },
  );
  return p.evaluate(() =>
    (
      window as unknown as { denShell: { runs: { text: () => string } } }
    ).denShell.runs.text(),
  );
}

describe("a service's command runs in its own workspace", () => {
  it("the Services page: bank's setup runs in south, the focus's shop in north", async () => {
    if (!browser) return;
    const { p, execs } = await open("/services");
    const bank = '.cmd-btn[data-repo="bank"][data-cmd="setup"]';
    await p.waitForSelector(bank);
    expect(await p.getAttribute(bank, "data-workspace")).toBe("south");
    expect(
      await p.getAttribute(
        '.cmd-btn[data-repo="shop"][data-cmd="setup"]',
        "data-workspace",
      ),
    ).toBe("north");
    await p.click(bank);
    const out = await runOutput(p);
    expect(out).toContain("bank-setup-ran");
    expect(out).not.toMatch(/not found/);
    expect(new URLSearchParams(execs[0]).get("workspace")).toBe("south");
    await p.context().close();
  }, 60_000);

  it("the tests page's services view: the same", async () => {
    if (!browser) return;
    const { p, execs } = await open("/tests#services");
    const bank = '.cmd-btn[data-repo="bank"][data-cmd="setup"]';
    await p.waitForSelector(bank);
    await p.click(bank);
    const out = await runOutput(p);
    expect(out).toContain("bank-setup-ran");
    expect(new URLSearchParams(execs[0]).get("workspace")).toBe("south");
    await p.context().close();
  }, 60_000);
});
