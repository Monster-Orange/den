/**
 * Issue 1022: the page polls health fast only while it is visible.
 * With health_poll.visible_seconds 2 and hidden_seconds 10:
 *
 *  - a visible page polls about every 2 s;
 *  - a hidden page polls every 10 s, and says it is hidden (hidden=1), so
 *    the server keeps its answer for the slow interval;
 *  - visible again: one poll at once.
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1022-")));
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
  // The shortest intervals, so the test runs in seconds.
  write(
    path.join(root, "config", "local", "user.yml"),
    "health_poll:\n  visible_seconds: 2\n  hidden_seconds: 10\n",
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
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [server] });
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Poll = { at: number; hidden: boolean };

/** A signed-in page whose visibility the test sets; records each poll. */
async function openPage(): Promise<{
  p: Page;
  polls: Poll[];
  next: (after: number) => Promise<Poll>;
  setHidden: (h: boolean) => Promise<number>;
}> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await signIn(ctx, path.join(tmp, "home"), base());
  await ctx.addInitScript(() => {
    const w = window as unknown as { __hidden: boolean };
    w.__hidden = false;
    Object.defineProperty(Document.prototype, "hidden", {
      configurable: true,
      get: () => w.__hidden,
    });
    Object.defineProperty(Document.prototype, "visibilityState", {
      configurable: true,
      get: () => (w.__hidden ? "hidden" : "visible"),
    });
  });
  const polls: Poll[] = [];
  const waiters: (() => void)[] = [];
  const p = await ctx.newPage();
  p.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname !== "/api/health/stream") return;
    polls.push({
      at: Date.now(),
      hidden: u.searchParams.get("hidden") === "1",
    });
    for (const w of waiters.splice(0)) w();
  });
  // The poll after the `after`th, once it is sent.
  const next = (after: number): Promise<Poll> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`no poll ${after + 1}`)),
        20_000,
      );
      const check = (): void => {
        if (polls.length > after) {
          clearTimeout(t);
          resolve(polls[after]);
        } else waiters.push(check);
      };
      check();
    });
  const setHidden = async (h: boolean): Promise<number> => {
    const at = Date.now();
    await p.evaluate((hide) => {
      (window as unknown as { __hidden: boolean }).__hidden = hide;
      document.dispatchEvent(new Event("visibilitychange"));
    }, h);
    return at;
  };
  await p.goto(`${base()}/services`);
  return { p, polls, next, setHidden };
}

describe("issue 1022: health polls slowly when nobody is looking", () => {
  it("visible every 2 s; hidden every 10 s, saying so; visible again polls at once", async () => {
    if (!browser) return;
    const { p, polls, next, setHidden } = await openPage();
    // Visible: three polls about 2 s apart, none hidden.
    await next(2);
    const gap = polls[2].at - polls[1].at;
    expect(gap).toBeGreaterThan(1_500);
    expect(gap).toBeLessThan(5_000);
    expect(polls.slice(0, 3).some((x) => x.hidden)).toBe(false);

    // Hidden: the poll already waiting goes out (hidden), the next one
    // 10 s after it.
    await setHidden(true);
    const n = polls.length;
    const a = await next(n);
    const b = await next(n + 1);
    expect([a.hidden, b.hidden]).toEqual([true, true]);
    expect(b.at - a.at).toBeGreaterThan(9_000);

    // Visible again: one poll at once, not hidden.
    const shown = await setHidden(false);
    const c = await next(n + 2);
    expect(c.hidden).toBe(false);
    expect(c.at - shown).toBeLessThan(1_500);
    await p.context().close();
  }, 60_000);
});
