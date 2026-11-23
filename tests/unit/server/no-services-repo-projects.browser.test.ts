/**
 * Issue 277: on the project page, a repo that runs nothing has no Start,
 * Stop, Restart or Logs: buttons that would do nothing (a release gate
 * found Stop and Logs enabled). Its row still says "no runtime", and its
 * ⋯ menu (remove) stays. A repo that runs something keeps its buttons.
 *
 * A real Den server over a throwaway distribution: project north holds
 * shop (one service) and cfg (services: {}). Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import { startDenServer, stopServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let port = 0;
let server: ChildProcess | null = null;
let browser: Browser | null = null;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-norunp-")));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    ["shop", "cfg"].map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  const entry = (n: string): string[] => [
    `      ${n}:`,
    "        mode: dev-managed",
    `        path: ${path.join(repos, n)}`,
  ];
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north]",
      "focus: north",
      "workspaces:",
      "  north:",
      "    services:",
      ...entry("shop"),
      ...entry("cfg"),
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "shop", ".den.yml"),
    'name: shop\nservices:\n  shop:\n    commands:\n      local:\n        up: "true"\n',
  );
  write(path.join(repos, "cfg", ".den.yml"), "name: cfg\nservices: {}\n");
  const home = path.join(tmp, "home");
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: home,
        HOME: home,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        PORT: "0",
      },
    },
  );
  server = started.server;
  port = started.port;
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [] });
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 277: the project page has no buttons that would do nothing", () => {
  it("cfg (runs nothing): no Start, Stop, Restart or Logs; its ⋯ stays; shop keeps its buttons", async () => {
    if (!browser) return;
    const base = `http://127.0.0.1:${port}`;
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await signInPage(p, path.join(tmp, "home"), base, "/local-dev");
    const cfg = p.locator('tr.repo[data-repo="cfg"]');
    const shop = p.locator('tr.repo[data-repo="shop"]');
    await cfg.waitFor({ timeout: 30_000 });
    await shop.waitFor({ timeout: 30_000 });
    expect(await cfg.textContent()).toContain("no runtime");
    for (const act of ["up", "down", "restart", "logs"]) {
      expect([
        act,
        await cfg.locator(`[data-action="tbl-${act}"]`).count(),
      ]).toEqual([act, 0]);
      expect([
        act,
        await shop.locator(`[data-action="tbl-${act}"]`).count(),
      ]).toEqual([act, 1]);
    }
    expect(await cfg.locator('[data-action="toggle-svc-menu"]').count()).toBe(
      1,
    );
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);
});
