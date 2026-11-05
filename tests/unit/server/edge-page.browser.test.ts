/**
 * The Edge page (0.3.0-dev.30, PL-SPEC §10) in a real browser on the real
 * web server: a built-in page in the rail's Ship group, there only when
 * /api/edge reports the edge configured. A click on it lands on /edge,
 * which shows the routes (Den's own, then the routers in the included
 * dynamic files, each marked by its source file), the domains, the TLS
 * strategy and CA trust. Read-only: no trust/untrust, no up/down.
 *
 * The distribution is the demo's (examples/distribution: edge org acme,
 * tls none) with `include: edge/dynamic` and one VPN routes file. The
 * edge's state dir is a temp dir; nothing is started.
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
let tmp = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
let browser: Browser | null = null;

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

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-edgep-")));
  const root = path.join(tmp, "dist");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  const conf = path.join(root, "config", "acme.yml");
  fs.writeFileSync(
    conf,
    fs
      .readFileSync(conf, "utf-8")
      .replace("  tls: none\n", "  tls: none\n  include: edge/dynamic\n"),
  );
  fs.mkdirSync(path.join(root, "edge", "dynamic"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "edge", "dynamic", "vpn-routes.yml"),
    "http:\n  routers:\n    vpn-web:\n      rule: Host(`web.acme.vpn.example`)\n      service: vpn-web\n",
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

async function open(url: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 800 },
  });
  // No first-visit changelog pop-up over the page: the latest is seen.
  const latest = (
    (await (await fetch(`http://localhost:${port}/api/changelog`)).json()) as {
      version: string;
    }[]
  )[0]?.version;
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("acme-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest ?? "");
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${port}${url}`);
  await p.evaluate(() =>
    (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
  );
  return p;
}

describe("the Edge page (PL-SPEC §10)", () => {
  it("is in the rail's Ship group once the edge is configured, and a click lands on it", async () => {
    if (!browser) return;
    const p = await open("/services");
    const item = '.den-rail .den-ni[data-nav="edge"]';
    await p.waitForSelector(item);
    // In Ship, after Releases.
    expect(
      await p.$eval(
        item,
        (a) =>
          a.closest(".den-rail-group")!.querySelector(".den-gh")!.textContent,
      ),
    ).toBe("Ship");
    expect(
      await p.$$eval('.den-rail-group:has([data-nav="edge"]) .den-ni', (as) =>
        as.map((a) => (a as HTMLElement).dataset.nav),
      ),
    ).toEqual(["environments", "release", "edge"]);
    await Promise.all([p.waitForURL(/\/edge$/), p.click(item)]);
    expect(new URL(p.url()).pathname).toBe("/edge");
    expect(await p.getAttribute(item, "aria-current")).toBe("page");
    expect(await p.textContent(".ph h1")).toBe("Edge");
    await p.waitForSelector("#edge-body:not([aria-busy])");
    expect(await p.textContent("#edge-sub")).toMatch(/^acme \/ acme-edge · /);
    // Den's own route, then the included router with its source file.
    const rows = await p.$$eval("#edge-body table.svc tbody tr", (trs) =>
      trs.map((tr) =>
        [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim()),
      ),
    );
    expect(rows).toContainEqual([
      "vpn-web",
      "web.acme.vpn.example",
      "vpn-web",
      "vpn-routes.yml",
    ]);
    expect(rows[0][3]).toBe("den");
    // TLS: none, set in edge.tls; no CA.
    const tiles = await p.$$eval("#edge-body .tile", (ts) =>
      ts.map((t) => t.textContent!),
    );
    expect(tiles.find((t) => t.startsWith("TLS"))).toMatch(
      /^TLSnoneset in edge\.tls$/,
    );
    expect(tiles.find((t) => t.startsWith("CA trust"))).toMatch(/no CA/);
    // Read-only: no buttons on the page.
    expect(await p.$$("#den-content button")).toEqual([]);
    // Nothing started or written: no edge state dir.
    expect(fs.existsSync(path.join(tmp, "edge-state"))).toBe(false);
    await p.context().close();
  }, 45_000);

  it("is not in the rail when /api/edge says no edge is configured", async () => {
    if (!browser) return;
    const ctx = await browser.newContext();
    await ctx.route(/\/api\/edge\?probe=1$/, (r) =>
      r.fulfill({ json: { configured: false, error: "no edge block" } }),
    );
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${port}/services`);
    await p.waitForSelector('.den-rail .den-ni[data-nav="release"]');
    await p.waitForFunction(() => {
      const raw = localStorage.getItem("acme-shell");
      return !!raw && JSON.parse(raw).edge === false;
    });
    expect(await p.$$('.den-rail .den-ni[data-nav="edge"]')).toEqual([]);
    await ctx.close();
  }, 30_000);
});
