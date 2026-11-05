/**
 * Local Dev's output panel takes its own room below the graph; it never
 * covers a card (a consumer's dev.18 run). The repro: a workspace with enough
 * cards to fill the height, a run's output open in the panel (~253px), the
 * graph fitted; the lowest cards' centres hit #output-panel and a real
 * click on one timed out. dev.18's check used three cards and an empty
 * panel, so every card fitted above it anyway.
 *
 * The real web server in a throwaway distribution (one workspace, two
 * repos with two services each, laid out left to right: a column of cards
 * that fits the page until the panel opens), driven by Playwright's headless Chromium.
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
import type { Browser } from "playwright";

const ENGINE = path.resolve(__dirname, "../../..");
const REPOS = ["shop", "billing"];
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
  return getBody(p).then((r) => r.status);
}
function getBody(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: p, timeout: 5_000, agent: false },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-outp-")));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    "environments: [local]\ngithub_org: acme\n",
  );
  // Left to right: the services stack in a column taller than the page.
  write(
    path.join(root, "config", "local", "user.yml"),
    "graph:\n  direction: right\n",
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
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
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

describe("Local Dev's output panel (a consumer's dev.18 run)", () => {
  it("with a run's output open, the lowest card is still the card under the pointer, and clicks", async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    // No first-visit changelog pop-up over the page: the latest is seen.
    const latest = (
      JSON.parse((await getBody("/api/changelog")).body) as {
        version: string;
      }[]
    )[0]?.version;
    await ctx.addInitScript((v) => {
      try {
        localStorage.setItem("den-changelog-seen", v);
      } catch {
        /* none */
      }
    }, latest ?? "");
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${port}/local-dev?ws=main`);
    await p.evaluate(() =>
      (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
    );
    await p.waitForSelector(".dg-card");
    await p.waitForTimeout(600);
    // A run's output tab, selected, with output in it: the panel opens to
    // its usual ~253px (tab bar, actions, 200px of output).
    await p.evaluate(() => {
      document.getElementById("tab-bar")!.innerHTML =
        '<div class="tab active" data-tab="main/shop/api">up shop/api</div>';
      document.getElementById("output")!.textContent = Array.from(
        { length: 40 },
        (_, i) => `› step ${i + 1}… ok`,
      ).join("\n");
    });
    await p.waitForTimeout(600);
    const panelH = await p.$eval(
      "#output-panel",
      (el) => el.getBoundingClientRect().height,
    );
    expect(panelH).toBeGreaterThan(240);
    expect(panelH).toBeLessThan(270);
    // The graph's viewport ends where the panel begins: they share the
    // column, the panel never sits over it.
    const [vpBottom, panelTop] = await p.evaluate(() => [
      document.querySelector(".dg-vp")!.getBoundingClientRect().bottom,
      document.getElementById("output-panel")!.getBoundingClientRect().top,
    ]);
    expect(vpBottom).toBeLessThanOrEqual(panelTop + 0.5);

    // Every card's centre is that card, not the panel.
    const hits = await p.$$eval(".dg-card", (cards) =>
      cards.map((c) => {
        const r = c.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return {
          id: (c as HTMLElement).dataset.id ?? c.textContent?.slice(0, 20),
          bottom: Math.round(r.bottom),
          hit: hit?.closest("#output-panel")
            ? "output panel"
            : hit?.closest(".dg-card") === c
              ? "card"
              : (hit?.id || hit?.className || "nothing").toString(),
        };
      }),
    );
    expect(hits.length).toBe(REPOS.length * 2);
    expect(hits.filter((h) => h.hit !== "card")).toEqual([]);

    // And a real click on the lowest card lands (no timeout).
    const lowest = await p.$$eval(".dg-card", (cards) => {
      let best = -1;
      let at = 0;
      cards.forEach((c, i) => {
        const b = c.getBoundingClientRect().bottom;
        if (b > best) {
          best = b;
          at = i;
        }
      });
      return at;
    });
    await p.locator(".dg-card").nth(lowest).click({ timeout: 3_000 });
    await ctx.close();
  }, 45_000);
});
