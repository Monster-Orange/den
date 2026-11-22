/**
 * The project and company drop-downs at tablet sizes, in WebKit: the picked
 * row is one line, with its ✓ at the end, for a short and a long name, with
 * touch and without, and at 125% page zoom. (An earlier report of the mark
 * wrapping turned out to be another app's menu; this keeps Den's right.)
 * Screenshots and row sizes go to $DEN_PROBE_DIR when it is set.
 *
 * Touch at 768 and touch at 820 with 125% zoom are left to issue 981's test:
 * there the Search box covers the project picker. The company crumb is
 * hidden below about 1000px wide, so its cases start at 1024.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { startDenServer, stopServer } from "../../child-servers.js";
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
  await browser?.close();
  await stopServer(server);
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

const LONG = "a-project-whose-name-is-far-too-long-for-the-menu-row";

/**
 * The checked row: its height, one line's height, each visible part's
 * height (the name, and any tag beside it), and where the mark sits.
 */
async function checkedRow(p: Page) {
  return p.$eval(".den-pop .den-mi[aria-checked='true']", (row) => {
    const r = row.getBoundingClientRect();
    const l = row.querySelector(".den-mi-l")!;
    const lr = l.getBoundingClientRect();
    const cs = getComputedStyle(row);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    const parts = Array.from(row.children).map((c) => ({
      cls: (c as HTMLElement).className,
      h: c.getBoundingClientRect().height,
    }));
    const after = getComputedStyle(row, "::after");
    return {
      text: l.textContent,
      zoom: parseFloat(getComputedStyle(document.documentElement).zoom || "1"),
      rowH: r.height,
      padY: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
      line,
      parts,
      labelRight: lr.right,
      rowRight: r.right,
      mark: after.content,
      markPos: after.position,
      markTransform: after.transform,
      coarse: matchMedia("(pointer: coarse)").matches,
    };
  });
}

async function pick(p: Page, name: string) {
  await p.click("#ws-pill");
  await p.waitForSelector(".den-pop .den-mi");
  await Promise.all([
    p.waitForNavigation(),
    p.click(`.den-pop .den-mi:has-text("${name}")`),
  ]);
  await p.waitForSelector("#ws-pill:not([hidden])");
}

// iPad sizes, portrait and landscape, at the default text size and at 125%
// (iPad Safari's larger text), with touch (an iPad) and with a mouse. At
// 720 px and below the picker moves into the bar's More menu, a different
// row.
describe.each([
  [768, 1024, 1, true],
  [820, 1180, 1, true],
  [1024, 1366, 1, true],
  [1180, 820, 1, true],
  [820, 1180, 1.25, true],
  [820, 1180, 1, false],
  [1180, 820, 1.25, false],
])(
  "project drop-down at %i x %i (text %f, touch %s) in WebKit",
  (width, height, zoom, touch) => {
    it("the checkmark stays on its row's line", async () => {
      if (!browser) return;
      const { p } = await open("/services", { width, height }, touch);
      // iPad Safari's larger text is a page zoom; on every load (a pick
      // reloads the page).
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
      for (const name of ["ws-b", LONG]) {
        await pick(p, name);
        await p.click("#ws-pill");
        await p.waitForSelector(".den-pop .den-mi[aria-checked='true']");
        const row = await checkedRow(p);
        expect(row.text).toBe(name);
        expect(row.mark).toMatch(/✓/);
        expect(row.zoom).toBeCloseTo(zoom, 2);
        expect(row.coarse).toBe(touch);
        // The mark is part of the row's line: the bar's 44px touch target
        // (.den-top button::after) never takes it out of the flow.
        expect(row.markPos).toBe("static");
        expect(row.markTransform).toBe("none");
        const dir = process.env.DEN_PROBE_DIR;
        const tag = `${name === LONG ? "long" : "short"}-${width}x${height}-t${zoom}${touch ? "-touch" : ""}`;
        if (dir) {
          fs.mkdirSync(dir, { recursive: true });
          await p.screenshot({ path: path.join(dir, `picker-${tag}.png`) });
          fs.appendFileSync(
            path.join(dir, "picker-rows.jsonl"),
            JSON.stringify({ tag, ...row }) + "\n",
          );
        }
        // One line: the row is one line plus its padding, never a second
        // line for the mark or for a part beside the name.
        expect(row.rowH).toBeLessThan(row.line * 1.5 + row.padY);
        for (const part of row.parts)
          expect(part.h).toBeLessThan(row.line * 1.5);
        // The mark has room at the right of the label.
        expect(row.labelRight).toBeLessThan(row.rowRight - 8);
        await p.keyboard.press("Escape");
      }
      await p.context().close();
    }, 60_000);
  },
);

// The company drop-down (two or more companies): each row is the name, its
// project count and, when picked, the mark.
const LONG_CO = "A company whose name is far too long for the menu row";
describe.each([
  [1024, 1366, 1, true],
  [1180, 820, 1, true],
  [1366, 1024, 1, true],
  [1366, 1024, 1, false],
])(
  "company drop-down at %i x %i (text %f, touch %s) in WebKit",
  (width, height, zoom, touch) => {
    it("the checkmark stays on its row's line", async () => {
      if (!browser) return;
      const { p } = await open("/services", { width, height }, touch);
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
      for (const [picked, name] of [
        ["acme", "Acme"],
        ["long", LONG_CO],
      ]) {
        await p.evaluate(
          ([id, long]) => {
            const w = window as unknown as {
              denShell: { setOrgs: (o: unknown[], id: string) => void };
            };
            w.denShell.setOrgs(
              [
                { id: "acme", title: "Acme", workspaces: 3 },
                { id: "long", title: long, workspaces: 12 },
              ],
              id,
            );
          },
          [picked, LONG_CO],
        );
        await p.waitForSelector("#org-crumb[aria-haspopup]");
        await p.click("#org-crumb");
        await p.waitForSelector(".den-pop .den-mi[aria-checked='true']");
        const row = await checkedRow(p);
        expect(row.text).toBe(name);
        expect(row.mark).toMatch(/✓/);
        expect(row.coarse).toBe(touch);
        const dir = process.env.DEN_PROBE_DIR;
        const tag = `org-${picked}-${width}x${height}-t${zoom}${touch ? "-touch" : ""}`;
        if (dir) {
          fs.mkdirSync(dir, { recursive: true });
          await p.screenshot({ path: path.join(dir, `picker-${tag}.png`) });
          fs.appendFileSync(
            path.join(dir, "picker-rows.jsonl"),
            JSON.stringify({ tag, ...row }) + "\n",
          );
        }
        expect(row.markPos).toBe("static");
        expect(row.rowH).toBeLessThan(row.line * 1.5 + row.padY);
        for (const part of row.parts)
          expect(part.h).toBeLessThan(row.line * 1.5);
        expect(row.labelRight).toBeLessThan(row.rowRight - 8);
        await p.keyboard.press("Escape");
      }
      await p.context().close();
    }, 60_000);
  },
);
