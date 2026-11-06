/**
 * 0.3.0-dev.18 in the real pages: the scope breadcrumb's menus driven by
 * header.js, and the fixes from the consumers' dev.17 runs. The real web
 * server in a throwaway distribution (three active workspaces, focus ws-a;
 * shop shared by ws-a and ws-b), driven by Playwright's headless Chromium.
 *
 * - the ORG label is the GitHub org's `orgs:` label, not the bare id;
 * - Workspace ▾ sets the view (user prefs only) and never moves the focus;
 *   "Set <ws> as focus" is the separate item that does;
 * - a Services card's ☆ follows an unpin from the rail, without a reload;
 * - every page has exactly one main landmark, #den-content;
 * - the runs dock never covers the graph's cards (since 0.3.0-dev.35 on
 *   the Graph page: Workspaces has no graph of its own, R24).
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
let root = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
let browser: Browser | null = null;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function request(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        timeout: 15_000,
        agent: false,
        headers: data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            }
          : {},
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
const getJson = async <T>(p: string): Promise<T> =>
  JSON.parse((await request("GET", p)).body) as T;
const wsFile = () =>
  fs.readFileSync(
    path.join(root, "config", "local", "workspaces.yml"),
    "utf-8",
  );

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-r4-")));
  root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "github_org: acme",
      "org:",
      "  id: acme",
      "orgs:",
      "  acme:",
      "    label: Acme Labs",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    ["shop", "billing", "search"]
      .map((n) => `${n}:\n  gh: acme/${n}\n`)
      .join(""),
  );
  const entry = (n: string): string[] => [
    `      ${n}:`,
    "        mode: dev-managed",
    `        path: ${path.join(repos, n)}`,
  ];
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [ws-a, ws-b, ws-c]",
      "focus: ws-a",
      "workspaces:",
      "  ws-a:",
      "    services:",
      ...entry("shop"),
      ...entry("billing"),
      ...entry("search"),
      "  ws-b:",
      "    services:",
      ...entry("shop"),
      ...entry("billing"),
      "  ws-c:",
      "    services:",
      ...entry("search"),
      "",
    ].join("\n"),
  );
  for (const n of ["shop", "billing", "search"])
    write(
      path.join(repos, n, ".den.yml"),
      `name: ${n}\nservices:\n  api:\n    commands:\n      local:\n        up: "true"\n`,
    );

  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
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
        DEN_HOME: path.join(tmp, "home"),
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
      if ((await request("GET", "/api/server-info")).status === 200) break;
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
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A page of the real server; records every non-GET request. */
async function open(
  url: string,
  size = { width: 1440, height: 800 },
): Promise<{ p: Page; writes: string[] }> {
  const ctx = await browser!.newContext({ viewport: size });
  // No first-visit changelog pop-up over the page: the latest is seen.
  const latest = (await getJson<{ version: string }[]>("/api/changelog"))[0]
    ?.version;
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest ?? "");
  const p = await ctx.newPage();
  const writes: string[] = [];
  p.on("request", (r) => {
    if (r.method() !== "GET")
      writes.push(
        `${r.method()} ${new URL(r.url()).pathname} ${r.postData() ?? ""}`,
      );
  });
  await p.goto(`http://127.0.0.1:${port}${url}`);
  await p.waitForSelector(".den-rail .den-ni");
  await p.evaluate(() =>
    (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
  );
  return { p, writes };
}

describe("the org label", () => {
  it("is the GitHub org's orgs: label, with where it came from (additive)", async () => {
    const cfg = await getJson<{ org: unknown }>("/api/den/config");
    expect(cfg.org).toEqual({
      id: "acme",
      title: "Acme Labs",
      title_source: "orgs",
    });
    if (!browser) return;
    const { p } = await open("/services");
    await p.waitForFunction(
      () => !document.getElementById("org-crumb")?.hidden,
    );
    expect(await p.textContent("#org-crumb")).toBe("Org Acme Labs");
    await p.context().close();
  }, 30_000);
});

describe("Workspace ▾ (R4)", () => {
  it("sets the view, a preference only; the focus moves only by its own item", async () => {
    if (!browser) return;
    const before = wsFile();
    const { p, writes } = await open("/services");
    await p.waitForSelector("#ws-pill:not([hidden])");
    expect(await p.textContent("#ws-pill")).toBe("Workspace All active ▾");
    await p.click("#ws-pill");
    expect(
      await p.$$eval(".den-pop .den-mi", (r) =>
        r.map((x) => [x.textContent, x.getAttribute("aria-checked")]),
      ),
    ).toEqual([
      ["All active (3)", "true"],
      ["ws-afocus", "false"],
      ["ws-b", "false"],
      ["ws-c", "false"],
      ["Manage workspaces…", null],
    ]);
    await Promise.all([
      p.waitForNavigation(),
      p.click('.den-pop .den-mi:has-text("ws-b")'),
    ]);
    // A view: user prefs (POST /api/scope) and nothing else.
    expect(writes).toEqual(['POST /api/scope {"scope":"ws-b"}']);
    expect(wsFile()).toBe(before);
    expect(await getJson("/api/scope")).toMatchObject({
      scope: "ws-b",
      inView: ["ws-b"],
      focus: "ws-a",
    });
    await p.waitForSelector("#ws-pill:not([hidden])");
    expect(await p.textContent("#ws-pill")).toBe("Workspace ws-b ▾");
    // The cards are the view's: shop and billing.
    await p.waitForSelector('[data-pin-toggle="billing"]');
    expect(await p.$$('[data-pin-toggle="search"]')).toHaveLength(0);

    // "Set ws-b as focus" is the one item that writes workspaces.yml.
    await p.click("#ws-pill");
    await Promise.all([
      p.waitForNavigation(),
      p.click('.den-pop .den-mi:has-text("Set ws-b as focus")'),
    ]);
    expect((await getJson<{ focus: string }>("/api/workspaces")).focus).toBe(
      "ws-b",
    );
    await p.context().close();
    // Restore.
    await request("POST", "/api/workspaces", { name: "ws-a", action: "focus" });
    await request("POST", "/api/scope", { scope: "all" });
  }, 60_000);
});

describe("pins (a consumer's dev.17 run)", () => {
  it("a Services card's ☆ follows an unpin from the rail, without a reload", async () => {
    if (!browser) return;
    const { p } = await open("/services");
    const star = '.services-pane [data-pin-toggle="shop"]';
    await p.waitForSelector(star);
    await p.click(star);
    expect(await p.getAttribute(star, "aria-pressed")).toBe("true");
    await p.waitForSelector('.den-rail [data-pin="shop"]');
    await p.click('.den-rail [data-unpin="shop"]', { force: true });
    expect(await p.getAttribute(star, "aria-pressed")).toBe("false");
    expect(await p.getAttribute(star, "aria-label")).toBe("Pin shop");
    await p.context().close();
  }, 30_000);
});

describe("one main landmark (a consumer's dev.17 run)", () => {
  it.each([
    "/local-dev",
    "/services",
    "/logs",
    "/tests",
    "/environments",
    "/release",
  ])(
    "%s has exactly one, #den-content",
    async (url) => {
      if (!browser) return;
      const { p } = await open(url);
      expect(
        await p.$$eval("main, [role=main]", (m) => m.map((e) => e.id)),
      ).toEqual(["den-content"]);
      await p.context().close();
    },
    30_000,
  );
});

describe("the Graph page (a consumer's dev.17 run, on Local Dev until dev.35)", () => {
  it("the runs dock (its output) never covers a graph card", async () => {
    if (!browser) return;
    const { p } = await open("/graph", { width: 1440, height: 640 });
    await p.waitForSelector(".dg-card");
    await p.waitForTimeout(500);
    // A run opens the dock (R16): its tab and its output.
    await p.evaluate(() =>
      (
        window as unknown as {
          denShell: { runs: { start: (id: string, l: string) => void } };
        }
      ).denShell.runs.start("shop", "up shop"),
    );
    await p.waitForTimeout(500);
    const hits = await p.$$eval(".dg-card", (cards) =>
      cards.map((c) => {
        const r = c.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return hit?.closest("#den-dock")
          ? "runs dock"
          : hit?.closest(".dg-card") === c
            ? "card"
            : (hit?.className ?? "nothing");
      }),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toEqual(hits.map(() => "card"));
    await p.context().close();
  }, 30_000);
});
