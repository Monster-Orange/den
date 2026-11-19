/**
 * Issue 207 on the Tests page, in a real browser on the real web server.
 *
 * T5: a journeys run with no specs ran nothing. The page says "Nothing
 *     ran", and neither the status dot nor the output line uses a success
 *     colour or class. (Before, `nothingRan()` read only suites, so this
 *     showed as failed with the old kind's own code.) The run also warns
 *     that the old kind is retiring and names its new form (T12).
 * T6: a cancelled run (exit 4) shows "Cancelled", never a pass.
 *
 * The distribution is the demo's (examples/distribution) with one repo and
 * no journey specs. Needs Playwright's chromium (or DEN_PW_WS);
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let port = 0;
let server: ChildProcess;
let browser: Browser | null = null;
let latest = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-outcome-")));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
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
      `        path: ${path.join(repos, "shop")}`,
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "shop", ".acme.yml"),
    "name: shop\nservices:\n  web: {}\n",
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
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        ACME_HOME: path.join(tmp, "home", ".acme"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        ACME_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
  );
  server = started.server;
  port = started.port;
  latest =
    (
      (await (
        await fetch(`http://localhost:${port}/api/changelog`)
      ).json()) as { version: string }[]
    )[0]?.version ?? "";
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    browser = process.env.DEN_PW_WS
      ? await chromium.connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server],
    after: () => fs.rmSync(tmp, { recursive: true, force: true }),
  });
});

async function testsPage(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await signIn(ctx, path.join(tmp, "home", ".den"), `http://localhost:${port}`);
  // The changelog pop-up stays shut: this version was seen.
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("acme-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  // The older test kinds' page (issue 209: /tests is now a 301 to /verify).
  await p.goto(`http://localhost:${port}/test-runs`);
  await p.waitForSelector("#run-btn");
  return p;
}

/** Run a kind and wait for the status dot to leave "running". */
async function runKind(p: Page, kind: string): Promise<void> {
  await p.click(`[data-pillar="${kind}"]`);
  await p.click("#run-btn");
  await p.waitForFunction(
    () => {
      const c = document.getElementById("run-dot")!.className;
      return c !== "dot" && !c.includes("running");
    },
    undefined,
    { timeout: 60_000 },
  );
}

const state = (p: Page) =>
  p.evaluate(() => ({
    dot: document.getElementById("run-dot")!.className,
    status: document.getElementById("run-status")!.textContent ?? "",
    out: (
      window as unknown as {
        denShell: { runs: { text: (id?: string) => string } };
      }
    ).denShell.runs.text("tests"),
    classes: [...document.querySelectorAll("#den-dock-out *, .den-dock pre *")]
      .map((e) => e.className)
      .join(" "),
  }));

describe("issue 207 on the Tests page", () => {
  it("T5: a journeys run with no specs says Nothing ran, never success", async () => {
    if (!browser) return;
    const p = await testsPage();
    await runKind(p, "journeys");
    const s = await state(p);
    expect(s.dot).toBe("dot nothing-ran");
    expect(s.status).toMatch(/^nothing ran/);
    expect(s.out).toMatch(/Nothing ran in/);
    expect(s.out).not.toMatch(/✓ Passed in/);
    expect(s.classes).not.toMatch(/done-ok|\bpassed\b/);
    // T12: the old kind still ran, and named its new form.
    expect(s.out).toMatch(
      /The test kind "journeys" is retiring\. It still runs for now\. Its new form is <layer>\/<name> with kind synthetic/,
    );
    const color = await p.$eval(
      "#run-dot",
      (e) => getComputedStyle(e).backgroundColor,
    );
    const ok = await p.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.background = "var(--ok)";
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    });
    expect(color).not.toBe(ok);
    await p.context().close();
  }, 90_000);

  it("T6: a cancelled run shows Cancelled, never a pass", async () => {
    if (!browser) return;
    const p = await testsPage();
    await p.route("**/api/run?*", (route) =>
      route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body:
          'data: {"type":"line","text":"started"}\n\n' +
          'data: {"type":"done","exitCode":4,"verdict":"cancelled","cancelled":true,"duration":1200}\n\n',
      }),
    );
    await runKind(p, "smoke");
    const s = await state(p);
    expect(s.dot).toBe("dot cancelled");
    expect(s.status).toBe("Cancelled");
    expect(s.out).toMatch(/Cancelled/);
    expect(s.out).not.toMatch(/✓ Passed in|✗ Failed in/);
    expect(s.classes).not.toMatch(/done-ok|\bpassed\b/);
    await p.context().close();
  }, 60_000);
});
