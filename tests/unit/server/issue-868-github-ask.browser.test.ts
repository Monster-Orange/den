/**
 * Issue 868 (ruling 11-21) in a browser: on an install with no GitHub
 * sign-in client, the signed-out page's "Ask to turn on Sign in with
 * GitHub" holds one request for a person signed in to this Den, and the
 * page says it asked. Nothing is set until that person allows it.
 *
 * Real chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. No code or key is
 * printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let browser: Browser | null = null;
let tmp = "";
let port = 0;
let server: ChildProcess;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-ghask-")));
  const root = path.join(tmp, "dist");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  // An explicit empty client id: no Sign in with GitHub on this install.
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    'web:\n  github_client_id: ""\n',
  );
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 60_000 },
  );
  server = started.server;
  port = started.port;
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
});

const base = () => `http://localhost:${port}`;
const waiting = async () =>
  (
    (await (await fetch(`${base()}/api/approvals?count=1`)).json()) as {
      waiting: number;
    }
  ).waiting;

describe("issue 868: ask to turn on Sign in with GitHub, from the sign-in page", () => {
  it("the GitHub row offers the ask; it holds one request and the page says so", async () => {
    if (!browser) return;
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${base()}/signin?next=%2F`);
    await p.waitForSelector(
      '#den-signin-methods [data-method="github"][data-ready="0"]',
      { timeout: 15_000 },
    );
    expect(await waiting()).toBe(0);
    await p.click("#den-signin-gh-ask");
    await p.waitForSelector('#den-signin-gh-asked[data-state="asked"]', {
      timeout: 15_000,
    });
    expect(await p.isVisible("#den-signin-gh-asked")).toBe(true);
    expect(await waiting()).toBe(1);
    // A second click answers the same request: never a second one.
    await p.click("#den-signin-gh-ask");
    await p.waitForFunction(
      () =>
        !(document.getElementById("den-signin-gh-ask") as HTMLButtonElement)
          .disabled,
    );
    expect(await waiting()).toBe(1);
    await ctx.close();
  }, 90_000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
