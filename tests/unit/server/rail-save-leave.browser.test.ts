/**
 * Issue 394: a rail change survives leaving the page at once. On a real
 * Den, the person unpins and, in the same tick, clicks a rail link. Before
 * the fix, shell.js saved with a plain fetch that the navigation could
 * cancel; the next page then applied the server's older copy and the pin
 * came back after a flash. Now shell.js saves with the kit's saveShell
 * (keepalive, then a beacon if the page hides first), at
 * /api/settings/shell. After the next page has settled (the server's copy
 * applied), the pin is still gone, on the page and on the server.
 *
 * In Chromium and WebKit. DEN_PW_WS: Den's own Playwright server instead
 * of a local browser. DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser } from "playwright";
import { denAuth } from "./helpers/den-auth.js";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let port = 0;
let server: ChildProcess;
const browsers: Record<string, Browser> = {};

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-rail-save-")),
  );
  const root = path.join(tmp, "dist");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
  );
  server = started.server;
  port = started.port;
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [server],
    after: () => fs.rmSync(tmp, { recursive: true, force: true }),
  });
}, 60_000);

async function setPins(pins: string[]): Promise<void> {
  const r = await fetch(`http://localhost:${port}/api/settings`, {
    method: "POST",
    headers: {
      ...denAuth(path.join(tmp, "home", ".den")),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ shell: { pins } }),
  });
  expect(r.status).toBe(200);
}
async function serverPins(): Promise<string[]> {
  const s = (await (
    await fetch(`http://localhost:${port}/api/settings`)
  ).json()) as { shell: { pins: string[] } };
  return s.shell.pins;
}

describe.each(["chromium", "webkit"])("the rail in %s", (engine) => {
  it("unpin, then a link in the same tick: after the next page settles, the pin is still gone", async () => {
    if (!browsers[engine]) return;
    await setPins(["shop", "billing"]);
    const ctx = await browsers[engine]!.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const p = await ctx.newPage();
    const base = `http://localhost:${port}`;
    await p.goto(`${base}/settings`);
    await p.waitForSelector('.den-rail [data-pin="shop"]');
    const settled = p.waitForResponse(
      (r) =>
        r.request().method() === "GET" &&
        new URL(r.url()).pathname === "/api/settings" &&
        new URL(r.request().frame().url()).pathname === "/logs",
    );
    await p.evaluate(() => {
      (
        window as unknown as { denShell: { unpin(id: string): void } }
      ).denShell.unpin("shop");
      (
        document.querySelector('.den-rail [data-nav="logs"]') as HTMLElement
      ).click();
    });
    await p.waitForURL(`${base}/logs`);
    await settled;
    // The server's copy has been applied (setState runs in its .then).
    await p.waitForTimeout(300);
    expect(await p.$$('.den-rail [data-pin="shop"]')).toHaveLength(0);
    expect(await p.$$('.den-rail [data-pin="billing"]')).toHaveLength(1);
    expect(await serverPins()).toEqual(["billing"]);
    await ctx.close();
  }, 60_000);
});
