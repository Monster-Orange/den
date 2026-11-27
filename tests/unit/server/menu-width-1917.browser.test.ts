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
const JA = "長い名前のプロジェクト".repeat(6).slice(0, 64);
const WIDE = "WWW MMM ".repeat(8).slice(0, 64);
const SIZES = [
  { width: 820, height: 1180 },
  { width: 768, height: 1024 },
];
const ENGINES = ["chromium", "webkit"] as const;

let tmp = "";
let port = 0;
let server: ChildProcess;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function getJson<T>(p: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p, agent: false }, (res) => {
        let out = "";
        res.on("data", (c: Buffer) => (out += c.toString()));
        res.on("end", () => resolve(JSON.parse(out) as T));
      })
      .on("error", reject);
  });
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1917-")));
  const root = path.join(tmp, "dist");
  const repo = path.join(tmp, "repos", "shop");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [ja-long, wide-long]",
      "focus: ja-long",
      "workspaces:",
      ...[
        ["ja-long", JA],
        ["wide-long", WIDE],
      ].flatMap(([slug, name]) => [
        `  ${slug}:`,
        `    name: ${JSON.stringify(name)}`,
        "    services:",
        "      shop:",
        "        mode: dev-managed",
        `        path: ${repo}`,
      ]),
      "",
    ].join("\n"),
  );
  write(
    path.join(repo, ".den.yml"),
    'name: shop\nservices:\n  api:\n    commands:\n      local:\n        up: "true"\n',
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
    const pw = await import("playwright");
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [server],
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function openMenu(
  b: Browser,
  size: { width: number; height: number },
): Promise<Page> {
  const ctx = await b.newContext({
    viewport: size,
    hasTouch: true,
    isMobile: true,
  });
  await signIn(ctx, path.join(tmp, "home"), `http://127.0.0.1:${port}`);
  const [newest] = await getJson<{ version: string }[]>("/api/changelog");
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      return;
    }
  }, newest?.version ?? "");
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${port}/services`);
  await p.waitForSelector("#ws-pill:not([hidden])");
  await p.click("#ws-pill");
  await p.getByRole("menuitemradio", { name: JA }).waitFor();
  return p;
}

const rowOf = (p: Page, name: string) =>
  p.getByRole("menuitemradio", { name }).evaluate((row) => {
    const menu = row.closest('[role="menu"]') ?? row.parentElement!;
    const lab = row.firstElementChild as HTMLElement;
    const m = menu.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const cs = getComputedStyle(row);
    const ls = getComputedStyle(lab);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
    return {
      menuLeft: Math.round(m.left),
      menuRight: Math.round(m.right),
      screen: window.innerWidth,
      cut: lab.scrollWidth > lab.clientWidth,
      ellipsis: ls.textOverflow === "ellipsis",
      nowrap: ls.whiteSpace === "nowrap",
      oneLine:
        lab.getBoundingClientRect().height < line * 1.5 &&
        r.height <
          line * 1.5 + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
      labelEndsBeforeRow:
        lab.getBoundingClientRect().right <= Math.round(r.right),
    };
  });

describe("issue 1917: the project drop-down stays on the screen and cuts a long name", () => {
  for (const engine of ENGINES)
    for (const size of SIZES)
      it(`${engine} at ${size.width}px, touch: the menu fits the screen; a name too wide for it is cut on one line`, async () => {
        const b = browsers[engine];
        if (!b) return;
        const p = await openMenu(b, size);
        try {
          for (const [name, mustCut] of [
            [JA, true],
            [WIDE, false],
          ] as const) {
            const r = await rowOf(p, name);
            const where = `${engine} ${size.width}px "${name.slice(0, 12)}…": ${JSON.stringify(r)}`;
            expect([where, r.menuLeft >= 0]).toEqual([where, true]);
            expect([where, r.menuRight <= r.screen]).toEqual([where, true]);
            expect([where, r.cut]).toEqual([where, mustCut]);
            expect([where, r.ellipsis && r.nowrap && r.oneLine]).toEqual([
              where,
              true,
            ]);
            expect([where, r.labelEndsBeforeRow]).toEqual([where, true]);
          }
        } finally {
          await p.context().close();
        }
      }, 60_000);
});
