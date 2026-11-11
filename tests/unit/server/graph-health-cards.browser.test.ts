/**
 * DOC-1's graph and Services findings (0.3.0-dev.40):
 *
 *   - before the first health round a card says "checking…", as the
 *     Workspaces table does (dev.37), not "no health check";
 *   - a service card's red "down" border goes when it recovers (graphHealth
 *     toggled the class on repo cards only);
 *   - preflight run as the Services page runs it (/api/service/exec) is
 *     one-shot: the run finishes (`done`, exit 0) instead of detaching.
 *
 * The real web server in a throwaway distribution (one workspace, repo
 * shop: api and worker, worker with a preflight), a minimal env (HOME,
 * PATH, DEN_*), driven by Playwright's headless Chromium. The page's
 * health is held back (routed, never answered) so the test decides each
 * round through graph.js's own graphHealth.
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

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
let browser: Browser | null = null;

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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-gh-")));
  const root = path.join(tmp, "dist");
  const repo = path.join(tmp, "repos", "shop");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [main]",
      "focus: main",
      "workspaces:",
      "  main:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${repo}`,
      "",
    ].join("\n"),
  );
  write(
    path.join(repo, ".den.yml"),
    [
      "name: shop",
      "services:",
      "  api:",
      "    commands:",
      "      local:",
      '        up: "true"',
      "  worker:",
      "    commands:",
      "      local:",
      '        up: "true"',
      '        preflight: "echo preflight-ok"',
      "",
    ].join("\n"),
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
      // A minimal env: nothing of the developer's beyond PATH.
      env: {
        HOME: path.join(tmp, "home"),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
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

const CARD = (id: string) => `.dg-card[data-id="${id}"]`;

/** The Graph page with no health round answered yet. */
async function graph(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  // What's new stays shut: it would cover the cards.
  const latest =
    (
      (await (await fetch(api("/api/changelog"))).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  // Health is held back: the test plays each round.
  await p.route(/\/api\/health(\/stream)?(\?|$)/, () => {
    /* never answered */
  });
  await p.goto(api("/graph?ws=main"));
  await p.waitForSelector(CARD("shop/api"));
  return p;
}
/** One health round, through graph.js's own graphHealth. */
async function round(p: Page, rows: object[]): Promise<void> {
  // A string: ts-jest would rewrite a dynamic import in a function.
  await p.evaluate(
    `import("/graph.js").then((g) => g.graphHealth(${JSON.stringify(rows)}))`,
  );
}

describe("graph cards and health", () => {
  it('say "checking…" before the first health round', async () => {
    if (!browser) return;
    const p = await graph();
    expect(await p.textContent(`${CARD("shop/api")} .h`)).toBe("checking…");
    expect(await p.textContent(`${CARD("shop/worker")} .h`)).toBe("checking…");
    await round(p, [{ repo: "shop", service: "api", ok: null }]);
    expect(await p.textContent(`${CARD("shop/api")} .h`)).toBe(
      "no health check",
    );
    await p.context().close();
  }, 45_000);

  it("a service card loses its red down border when it recovers", async () => {
    if (!browser) return;
    const p = await graph();
    const down = () =>
      p.$eval(CARD("shop/api"), (e) => e.classList.contains("down"));
    await round(p, [{ repo: "shop", service: "api", ok: false }]);
    expect(await down()).toBe(true);
    await round(p, [{ repo: "shop", service: "api", ok: true }]);
    expect(await down()).toBe(false);
    expect(await p.textContent(`${CARD("shop/api")} .h`)).toContain("healthy");
    await p.context().close();
  }, 45_000);

  it("0.4.17: a card's favourite star sits top-right and only pins; it's the shell's pins, kept on reload", async () => {
    if (!browser) return;
    const p = await graph();
    const star = `${CARD("shop/api")} [data-pin-toggle="shop/api"]`;
    await p.waitForSelector(star);
    const at = await p.$eval(star, (b) => {
      const c = b.closest(".dg-card")!.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return { right: c.right - r.right, top: r.top - c.top };
    });
    expect(at.right).toBeLessThan(16);
    expect(at.top).toBeLessThan(16);
    expect(await p.getAttribute(star, "aria-pressed")).toBe("false");
    const [saved] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/settings",
      ),
      p.click(star),
    ]);
    expect(saved.status()).toBe(200);
    expect(await p.getAttribute(star, "aria-pressed")).toBe("true");
    // Pinning doesn't open the card's details.
    expect(await p.$(".dg-card.sel")).toBeNull();
    // A health round repaints the card: the star stays on.
    await round(p, [{ repo: "shop", service: "api", ok: true }]);
    expect(await p.getAttribute(star, "aria-pressed")).toBe("true");
    await p.reload();
    await p.waitForSelector(star);
    expect(await p.getAttribute(star, "aria-pressed")).toBe("true");
    await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/settings",
      ),
      p.click(star),
    ]);
    expect(await p.getAttribute(star, "aria-pressed")).toBe("false");
    await p.context().close();
  }, 45_000);

  it("0.4.17: a card with a URL has Visit ↗, which opens it in a new tab; one without has none", async () => {
    if (!browser) return;
    const p = await graph();
    await round(p, [
      {
        repo: "shop",
        service: "api",
        ok: true,
        openUrl: "http://shop.example.test/",
      },
      { repo: "shop", service: "worker", ok: true },
    ]);
    // D35: a real link (Safari blocks window.open from a delegated click).
    const visit = (id: string) =>
      `${CARD(id)} .dg-acts a[data-action-link="open"]`;
    await p.waitForSelector(visit("shop/api"), { state: "attached" });
    expect((await p.textContent(visit("shop/api")))?.trim()).toBe("Visit ↗");
    expect(await p.$(visit("shop/worker"))).toBeNull();
    expect(await p.getAttribute(visit("shop/api"), "target")).toBe("_blank");
    expect(await p.getAttribute(visit("shop/api"), "rel")).toBe(
      "noopener noreferrer",
    );
    expect(await p.$(`${CARD("shop/worker")} [data-action="open"]`)).toBeNull();
    await p
      .context()
      .route("http://shop.example.test/**", (r) => r.fulfill({ body: "shop" }));
    await p.hover(CARD("shop/api"));
    const [tab] = await Promise.all([
      p.context().waitForEvent("page"),
      p.click(visit("shop/api")),
    ]);
    await tab.waitForLoadState();
    expect(tab.url()).toBe("http://shop.example.test/");
    await p.context().close();
  }, 45_000);
});

describe("preflight from the Services page", () => {
  it("runs to completion: its output, then done with exit 0", async () => {
    const q = new URLSearchParams({
      repo: "shop",
      service: "worker",
      cmd: "preflight",
      env: "local",
    });
    const events: { type: string; text?: string; exitCode?: number }[] = [];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      // SEC-1a: a GET that runs something carries the CLI's credential.
      const r = await fetch(api(`/api/service/exec?${q}`), {
        signal: ctl.signal,
        headers: denAuth(path.join(tmp, "home", ".den")),
      });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
          const line = buf.slice(0, i).replace(/^data: /, "");
          buf = buf.slice(i + 2);
          events.push(JSON.parse(line) as (typeof events)[number]);
        }
        if (events.some((e) => e.type === "done")) break;
      }
    } catch {
      /* aborted: no done within the time */
    } finally {
      clearTimeout(timer);
    }
    expect(events.find((e) => e.type === "cmd")).toMatchObject({
      detached: false,
    });
    expect(events.some((e) => e.text === "preflight-ok")).toBe(true);
    expect(events.find((e) => e.type === "done")).toMatchObject({
      exitCode: 0,
    });
  }, 30_000);
});
