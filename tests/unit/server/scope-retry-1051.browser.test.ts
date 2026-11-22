/**
 * Issue 1051: one failed load of the top bar's project menu
 * (/api/workspaces) no longer hides it until a reload. The page tries
 * again, and the next answer shows the menu.
 *
 *  - The first /api/workspaces fails (a dropped connection): the project
 *    button shows once a later try answers, with no reload.
 *  - A failed refresh after a good load keeps the menu it had.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { startDenServer } from "../../child-servers.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let port = 0;
let server: ChildProcess;
let browser: Browser | null = null;
const base = () => `http://localhost:${port}`;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1051-")));
  const root = path.join(tmp, "dist");
  const repo = path.join(tmp, "repos", "shop");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    "environments: [local]\norg:\n  id: acme\n",
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [ws-a, ws-b]",
      "focus: ws-a",
      "workspaces:",
      "  ws-a:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${repo}`,
      "  ws-b:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${repo}`,
      "",
    ].join("\n"),
  );
  write(path.join(repo, ".den.yml"), "name: shop\n");
  const started = await startDenServer(
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
      },
    },
  );
  server = started.server;
  port = started.port;
  try {
    const { webkit } = await import("playwright");
    browser = await launchBrowser(webkit);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [server] });
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A signed-in page whose first `fail` loads of /api/workspaces are cut
 * off; the ones after answer. Counts every load.
 */
async function openFailing(
  fail: number,
): Promise<{ p: Page; loads: () => number }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await signIn(ctx, path.join(tmp, "home"), base());
  let n = 0;
  await ctx.route(/\/api\/workspaces(\?|$)/, async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    n++;
    if (n <= fail) return r.abort("connectionreset");
    return r.continue();
  });
  const p = await ctx.newPage();
  await p.goto(`${base()}/services`);
  return { p, loads: () => n };
}

describe("issue 1051: the project menu after a failed load", () => {
  it("the first load fails: the project button shows once a later try answers, no reload", async () => {
    if (!browser) return;
    const { p, loads } = await openFailing(1);
    let navs = 0;
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) navs++;
    });
    await p.waitForSelector("#ws-pill:not([hidden])", { timeout: 15_000 });
    expect(loads()).toBeGreaterThanOrEqual(2);
    expect(navs).toBe(0);
    await p.context().close();
  }, 40_000);

  it("a failed refresh after a good load keeps the menu it had", async () => {
    if (!browser) return;
    const { p } = await openFailing(0);
    await p.waitForSelector("#ws-pill:not([hidden])");
    const label = await p.locator("#ws-pill").innerText();
    // Every load from now on fails; the page refreshes its menu.
    await p.context().unroute(/\/api\/workspaces(\?|$)/);
    await p
      .context()
      .route(/\/api\/workspaces(\?|$)/, (r) => r.abort("connectionreset"));
    await p.evaluate(async () => {
      const h = (await import("/header.js")) as {
        refreshWorkspacePill: () => Promise<void>;
      };
      await h.refreshWorkspacePill();
    });
    expect(await p.locator("#ws-pill").isHidden()).toBe(false);
    expect(await p.locator("#ws-pill").innerText()).toBe(label);
    await p.context().close();
  }, 40_000);
});
