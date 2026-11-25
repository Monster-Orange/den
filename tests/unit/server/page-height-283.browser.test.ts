/**
 * Issue 283 (follow-up): no page is taller than the window. The pages keep
 * the body to the window's height (overflow hidden) and scroll inside
 * #den-content, so the document itself never scrolls. Settings' visually
 * hidden labels (.den-sr, position: absolute) had no positioned ancestor,
 * so they were placed against the page and stretched it by 9,000 to
 * 17,000 px; Home at 390 px by about 100 px. A wheel can't scroll it (the
 * body's overflow is hidden), but find-in-page or a focus can, and then
 * the window shows empty space with no Runs bar. Measured in Chromium and
 * WebKit: the document's scroll height equals the window's height.
 *
 * The distribution is the demo's (examples/distribution); nothing runs.
 * Needs Playwright's chromium and webkit; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
const BROWSERS = ["chromium", "webkit"] as const;
// [page, width, height]: Home in a short window puts its agents table's
// hidden caption below the window's edge, as a real install's longer Home
// does at 800.
const CASES: [page: string, width: number, height: number][] = [
  ["/settings", 1280, 800],
  ["/settings", 390, 800],
  ["/", 390, 800],
  ["/", 390, 480],
  ["/", 1280, 480],
  ["/services", 390, 800],
  ["/agents", 390, 800],
];
const browsers: Partial<Record<(typeof BROWSERS)[number], Browser>> = {};
let tmp = "";
let port = 0;
let server: ChildProcess | undefined;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const b of BROWSERS) browsers[b] = await launchBrowser(pw[b]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-283h-")));
  const root = path.join(tmp, "dist");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  // A project with one service, so Home draws its services and agents
  // tables (as a real install's does).
  const repos = path.join(tmp, "repos");
  const write = (f: string, c: string) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c);
  };
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
    'name: shop\nservices:\n  web:\n    commands:\n      local:\n        down: "echo stopped"\n',
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
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: server ? [server] : [],
    after: () => fs.rmSync(tmp, { recursive: true, force: true }),
  });
});

/** The page, settled: its scroll height, and what reaches below the window. */
async function heightOf(
  b: Browser,
  url: string,
  width: number,
  height: number,
): Promise<{ over: number; past: string[] }> {
  const ctx = await b.newContext({ viewport: { width, height } });
  try {
    await signIn(
      ctx,
      path.join(tmp, "home", ".acme"),
      `http://localhost:${port}`,
    );
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${port}${url}`);
    await p.waitForSelector("#den-dock");
    await p.waitForLoadState("networkidle");
    if (url === "/")
      await p.waitForSelector("#agent-table", { state: "attached" });
    return await p.evaluate(() => {
      const s = document.scrollingElement as HTMLElement;
      const past: string[] = [];
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (r.bottom > window.innerHeight + 0.5 && past.length < 5) {
          const st = getComputedStyle(el);
          // Only an element that isn't inside a scrolling or clipping box.
          let clipped = false;
          for (
            let a = el.parentElement;
            a && a !== document.body;
            a = a.parentElement
          ) {
            const o = getComputedStyle(a).overflowY;
            if (o !== "visible") {
              clipped = true;
              break;
            }
          }
          if (!clipped)
            past.push(
              `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} ${st.position} bottom=${Math.round(r.bottom)}`,
            );
        }
      }
      return { over: s.scrollHeight - window.innerHeight, past };
    });
  } finally {
    await ctx.close();
  }
}

describe("issue 283: no page is taller than the window", () => {
  for (const b of BROWSERS)
    it(`${b}: the document's scroll height is the window's`, async () => {
      const browser = browsers[b];
      if (!browser) return;
      const seen: Record<string, number> = {};
      const why: Record<string, string[]> = {};
      for (const [url, w, h] of CASES) {
        const m = await heightOf(browser, url, w, h);
        seen[`${url} @${w}x${h}`] = m.over;
        if (m.over) why[`${url} @${w}x${h}`] = m.past;
      }
      if (Object.keys(why).length)
        console.log("past the window:", JSON.stringify(why, null, 1));
      expect(seen).toEqual(
        Object.fromEntries(CASES.map(([u, w, h]) => [`${u} @${w}x${h}`, 0])),
      );
    }, 240_000);
});
