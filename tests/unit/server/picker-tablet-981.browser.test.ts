/**
 * Issue 981: on a tablet the top bar's Search box must never cover the
 * project picker. A tap on the picker (#ws-pill) opens the project
 * drop-down, not Search, in WebKit, with touch: at 768 x 1024, at 820 x 1180,
 * and at 820 x 1180 with 125% page zoom (iPad Safari's larger text). The
 * picker shows whole ("All active") at the default text size. Screenshots
 * and the bar's boxes go to $DEN_PROBE_DIR when it is set.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { startDenServer } from "../../child-servers.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let port = 0;
let server: ChildProcess;
let browser: Browser | null = null;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const base = () => `http://127.0.0.1:${port}`;
const stateDir = () => path.join(tmp, "home");
function request(
  method: string,
  p: string,
  body?: unknown,
  extra: Record<string, string> = {},
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
        headers: {
          ...extra,
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(data)),
              }
            : {}),
        },
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
      "active: [ws-a, ws-b, ws-c, a-project-whose-name-is-far-too-long-for-the-menu-row]",
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
      "  a-project-whose-name-is-far-too-long-for-the-menu-row:",
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
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [server] });
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A page of the real server; records every non-GET request. */
async function open(
  url: string,
  size = { width: 1440, height: 800 },
  touch = false,
): Promise<{ p: Page; writes: string[] }> {
  // An iPad is a touch screen: (pointer: coarse) styles apply.
  const ctx = await browser!.newContext({
    viewport: size,
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  // A signed-in browser: its picks write (a write needs a sign-in on this
  // machine too, 0.4.71).
  await signIn(ctx, stateDir(), base());
  // No first-visit changelog pop-up over the page: the latest is seen.
  const [newest] = await getJson<{ version: string }[]>("/api/changelog");
  const latest = newest?.version;
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
  await p.waitForSelector("#ws-pill", { state: "attached" });
  await p.evaluate(() =>
    (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
  );
  return { p, writes };
}

/** The picker's and the search's boxes, and what sits at the picker's centre. */
async function bar(p: Page) {
  return p.evaluate(() => {
    const box = (id: string) => {
      const r = document.getElementById(id)!.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
      };
    };
    const pill = box("ws-pill");
    const search = box("den-search");
    const at = document.elementFromPoint(
      (pill.left + pill.right) / 2,
      (pill.top + pill.bottom) / 2,
    );
    return {
      pill,
      search,
      atPill: !!at?.closest("#ws-pill"),
      pillText: document.getElementById("ws-pill")!.textContent ?? "",
      // The picker's parts that show and are cut short ("…").
      cut: Array.from(document.querySelectorAll("#ws-pill, #ws-pill *"))
        .filter((e) => {
          const h = e as HTMLElement;
          return h.offsetWidth > 0 && h.scrollWidth > h.clientWidth + 1;
        })
        .map((e) => (e as HTMLElement).className || e.tagName),
      zoom: parseFloat(getComputedStyle(document.documentElement).zoom || "1"),
      coarse: matchMedia("(pointer: coarse)").matches,
    };
  });
}

describe.each([
  [768, 1024, 1],
  [820, 1180, 1],
  [820, 1180, 1.25],
])("top bar at %i x %i, text %f, touch, in WebKit", (width, height, zoom) => {
  it("a tap on the project picker opens the projects, not Search", async () => {
    if (!browser) return;
    const { p } = await open("/services", { width, height }, true);
    if (zoom !== 1) {
      await p.addInitScript((z) => {
        document.addEventListener("DOMContentLoaded", () => {
          const st = document.createElement("style");
          st.textContent = `html { zoom: ${z}; }`;
          document.head.appendChild(st);
        });
      }, zoom);
      await p.reload();
    }
    await p.waitForSelector("#ws-pill:not([hidden])");
    const b = await bar(p);
    const dir = process.env.DEN_PROBE_DIR;
    const tag = `981-${width}x${height}-t${zoom}-touch`;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${tag}.json`),
        JSON.stringify(b, null, 2),
      );
      await p.screenshot({ path: path.join(dir, `${tag}.png`) });
    }
    expect(b.coarse).toBe(true);
    expect(b.zoom).toBeCloseTo(zoom, 2);
    // The picker is the thing under its own centre, and the search ends
    // before it starts.
    expect(b.atPill).toBe(true);
    expect(b.pill.right).toBeLessThanOrEqual(b.search.left);
    // And at the default text size it isn't squeezed: its words ("All
    // active") show whole. At 125% the bar is a phone's width (656px of
    // page), the search is its icon, and the value may end in "…", as
    // any crumb's does.
    if (zoom === 1) expect(b.cut).toEqual([]);
    // A real tap (hit-tested, no forcing): the projects open, Search doesn't.
    await p.tap("#ws-pill", { timeout: 5_000 });
    await p.waitForSelector('[role="menuitemradio"]', { timeout: 5_000 });
    expect(await p.getAttribute("#den-search", "aria-expanded")).not.toBe(
      "true",
    );
    if (dir) await p.screenshot({ path: path.join(dir, `${tag}-open.png`) });
    await p.context().close();
  });
});
