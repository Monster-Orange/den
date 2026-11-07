/**
 * The runs dock (R16, 0.3.0-dev.30) in a real browser on the real web
 * server: one output dock for every page, drawn by shell.js at the foot of
 * the content column. A bar ("Runs", the run tabs, Show/Hide runs) that
 * opens to a 170px <pre>; tabs in 12px mono with a dot that pulses while
 * running; "done in {s}s". Pages and plugins use one path, denShell.runs.
 * The panes' features carry over: Copy, Clear, a tab's ×, auto-scroll, the
 * error state, the lines kept, a line updated in place, the last run's
 * link.
 *
 * R16a (0.3.0-dev.30, Ward QA 2026-11-05): the dock starts collapsed to its
 * bar; open/closed and its height are user prefs (/api/settings `shell`),
 * so a reload and a fresh browser keep them; a run starting never opens
 * it (its tab appears, the Runs chip pulses); an action whose whole point
 * is output (a service's Logs) does; the drag stops at half the window.
 *
 * The distribution is the demo's (examples/distribution) with two repos
 * whose `up` is `true`; nothing else runs.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { denAuth } from "./helpers/den-auth.js";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
let browser: Browser | null = null;
let latest = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function get(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "localhost", port, path: p, timeout: 5_000, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-dock-")));
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
    'name: shop\nservices:\n  web:\n    commands:\n      local:\n        down: "echo stopped"\n    logs:\n      local: "echo a-log-line"\n',
  );
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  server = spawnServer(
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
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await get("/api/server-info")) === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error(`server did not start:\n${serverOut}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  latest =
    (
      (await (
        await fetch(`http://localhost:${port}/api/changelog`)
      ).json()) as { version: string }[]
    )[0]?.version ?? "";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The dock's prefs back to the defaults (collapsed, 170px). */
async function resetDock(): Promise<void> {
  await fetch(`http://localhost:${port}/api/settings`, {
    method: "POST",
    headers: {
      ...denAuth(path.join(tmp, "home", ".acme")),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ shell: { dock: false, dockHeight: 0 } }),
  });
}
async function shellPrefs(): Promise<{ dock: boolean; dockHeight: number }> {
  return (
    (await (await fetch(`http://localhost:${port}/api/settings`)).json()) as {
      shell: { dock: boolean; dockHeight: number };
    }
  ).shell;
}

async function open(
  url: string,
  width = 1280,
  o: { keep?: boolean } = {},
): Promise<Page> {
  if (!o.keep) await resetDock();
  const ctx = await browser!.newContext({
    viewport: { width, height: 800 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("acme-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${port}${url}`);
  await p.waitForSelector("#den-dock .den-bar");
  return p;
}

type Runs = {
  start: (id: string, label: string, o?: object) => string;
  add: (id: string, label: string, o?: object) => string;
  append: (id: string, t: string, cls?: string, o?: object) => void;
  finish: (id: string, o?: { ok: boolean }) => void;
  text: (id?: string) => string;
  list: () => { id: string; running: boolean; error: boolean }[];
  isOpen: () => boolean;
};
const runs = (p: Page, fn: string, ...args: unknown[]) =>
  p.evaluate(
    ([f, a]) =>
      (
        (window as unknown as { denShell: { runs: Runs } }).denShell
          .runs as unknown as Record<string, (...x: unknown[]) => unknown>
      )[f as string](...(a as unknown[])),
    [fn, args] as const,
  );
const txt = (p: Page, sel: string) =>
  p.$eval(sel, (e) => (e as HTMLElement).innerText.replace(/\s+/g, " ").trim());

describe("the runs dock (R16)", () => {
  it("is on every page: a bar at the foot of the content column, closed until asked", async () => {
    if (!browser) return;
    for (const url of ["/services", "/logs", "/environments", "/settings"]) {
      const p = await open(url);
      const m = await p.evaluate(() => {
        const d = document.getElementById("den-dock")!.getBoundingClientRect();
        const rail = document
          .querySelector(".den-rail")!
          .getBoundingClientRect();
        return {
          bottom: Math.round(d.bottom),
          left: Math.round(d.left),
          railRight: Math.round(rail.right),
          last: document.body.lastElementChild!.id,
        };
      });
      expect([url, m.bottom]).toEqual([url, 800]);
      expect(m.left).toBe(m.railRight);
      expect(await txt(p, "#den-dock .den-bar")).toBe(
        "Runs No runs Show runs ▴",
      );
      expect(await p.$("#den-dock-out")).toBeNull();
      await p.context().close();
    }
  }, 60_000);

  it("Show runs opens the 170px output; a run is a tab that pulses, then reads done in {s}s", async () => {
    if (!browser) return;
    const p = await open("/services");
    await p.click('#den-dock [data-act="dock"]');
    const pre = await p.$eval("#den-dock-out", (e) => {
      const cs = getComputedStyle(e);
      return {
        h: cs.height,
        font: `${cs.fontSize}/${cs.lineHeight}`,
        t: (e as HTMLElement).innerText,
      };
    });
    expect(pre).toEqual({
      h: "170px",
      font: "12px/18px",
      t: "Nothing has run yet. Output from any page lands here.",
    });
    expect(await txt(p, '#den-dock [data-act="dock"]')).toBe("Hide runs ▾");
    await runs(p, "start", "a", "restart shop/web");
    await runs(p, "append", "a", "› starting… ok");
    await p.waitForSelector(
      '#den-dock .den-rtab[aria-selected="true"] .den-dot.run',
    );
    // The Runs chip counts it (R7).
    expect(await txt(p, "#den-runs")).toBe("1 running");
    await runs(p, "finish", "a", { ok: true });
    await p.waitForFunction(() =>
      /✓ done in \d+\.\ds\n$/.test(
        (window as unknown as { denShell: { runs: Runs } }).denShell.runs.text(
          "a",
        ),
      ),
    );
    expect(await p.$("#den-dock .den-rtab .den-dot.run")).toBeNull();
    expect(await txt(p, "#den-runs")).toBe("Runs");
    expect(await p.getAttribute("#den-dock .den-rtab", "title")).toMatch(
      /^restart shop\/web · done in \d+\.\ds$/,
    );
    // A failed run: the red dot, "failed in", the err line class kept.
    await runs(p, "start", "b", "up shop/api");
    await runs(p, "append", "b", "boom", "err");
    await runs(p, "finish", "b", { ok: false });
    await p.waitForSelector(
      '#den-dock .den-rtab[aria-selected="true"] .den-dot.bad',
    );
    await p.waitForSelector("#den-dock-out .done-fail");
    expect(await txt(p, "#den-dock-out .err")).toBe("boom");
    expect(await txt(p, "#den-dock-out .done-fail")).toMatch(/^✗ failed in/);
    await p.context().close();
  }, 30_000);

  it("keeps the panes' features: a line in place, the lines kept, Copy, Clear, ×, arrows and Delete", async () => {
    if (!browser) return;
    const p = await open("/services");
    await runs(p, "start", "k6", "tests performance", {
      doneLine: false,
      max: 3,
    });
    await p.click('#den-dock [data-act="dock"]');
    await runs(p, "append", "k6", "scn [  10% ]", "", { key: "scn" });
    await runs(p, "append", "k6", "other");
    await runs(p, "append", "k6", "scn [ 100% ]", "", { key: "scn" });
    await p.waitForTimeout(100);
    expect(await runs(p, "text", "k6")).toBe("scn [ 100% ]\nother\n");
    for (const n of [1, 2, 3, 4]) await runs(p, "append", "k6", `l${n}`);
    await p.waitForTimeout(100);
    expect(await runs(p, "text", "k6")).toBe("l2\nl3\nl4\n");
    expect(await txt(p, "#den-dock-out")).toBe("l2 l3 l4");
    // Copy: the selected run's output, "Copied!" for a moment.
    await p.click('#den-dock [data-dock="copy"]');
    await p.waitForSelector('#den-dock [data-dock="copy"]:has-text("Copied!")');
    expect(await p.evaluate(() => navigator.clipboard.readText())).toBe(
      "l2\nl3\nl4\n",
    );
    // Clear: the run's lines (its onClear hook runs too).
    await p.evaluate(() => {
      (window as unknown as { denShell: { runs: Runs } }).denShell.runs.add(
        "k6",
        "tests performance",
        {
          onClear: () =>
            ((window as unknown as { __cleared: boolean }).__cleared = true),
        },
      );
    });
    await p.click('#den-dock [data-dock="clear"]');
    expect(await runs(p, "text", "k6")).toBe("");
    expect(
      await p.evaluate(
        () => (window as unknown as { __cleared: boolean }).__cleared,
      ),
    ).toBe(true);
    // Two tabs: → selects the next, Delete closes it, × closes the other.
    await runs(p, "start", "x", "check shop/web", { doneLine: false });
    await p.focus('#den-dock .den-rtab[aria-selected="true"]');
    await p.keyboard.press("ArrowLeft");
    expect(await txt(p, '#den-dock .den-rtab[aria-selected="true"]')).toBe(
      "tests performance , 1 running",
    );
    await p.keyboard.press("Delete");
    expect((await runs(p, "list")) as { id: string }[]).toEqual([
      expect.objectContaining({ id: "x" }),
    ]);
    await p.click("#den-dock [data-rclose]");
    expect(await runs(p, "list")).toEqual([]);
    expect(await txt(p, "#den-dock .den-runs-l")).toBe("No runs");
    await p.context().close();
  }, 30_000);

  // A consumer's dev.33 finding: with no runs the dock's list was a
  // role=tablist holding a "No runs" span and no tab. The role (and its
  // label) is there only while a tab is.
  it("is a tablist only while it holds a run tab: none, the first run, the last one closed", async () => {
    if (!browser) return;
    const p = await open("/services");
    const aria = () =>
      p.$eval("#den-dock .den-runs-l", (e) => ({
        role: e.getAttribute("role"),
        label: e.getAttribute("aria-label"),
        tabs: e.querySelectorAll('[role="tab"]').length,
        text: (e as HTMLElement).innerText.trim(),
      }));
    expect(await aria()).toEqual({
      role: null,
      label: null,
      tabs: 0,
      text: "No runs",
    });
    // No tablist anywhere in the dock while it is empty.
    expect(await p.$('#den-dock [role="tablist"]')).toBeNull();
    await runs(p, "start", "t1", "up shop/web");
    await p.waitForSelector('#den-dock .den-runs-l[role="tablist"] .den-rtab');
    expect(await aria()).toEqual({
      role: "tablist",
      label: "Runs",
      tabs: 1,
      text: expect.stringContaining("up shop/web"),
    });
    await runs(p, "finish", "t1", { ok: true });
    await p.click("#den-dock [data-rclose]");
    await p.waitForFunction(
      () => !document.querySelector("#den-dock .den-rtab"),
    );
    expect(await aria()).toEqual({
      role: null,
      label: null,
      tabs: 0,
      text: "No runs",
    });
    await p.context().close();
  }, 30_000);

  it("a page's command runs into a tab, its output as the pane had it", async () => {
    if (!browser) return;
    const p = await open("/services");
    await p.click('.cmd-btn:has-text("down")');
    await p.waitForSelector('#den-dock .den-rtab:has-text("down shop/web")');
    await p.waitForFunction(() =>
      /✓ Done in/.test(
        (window as unknown as { denShell: { runs: Runs } }).denShell.runs.text(
          "shop/web",
        ),
      ),
    );
    const out = (await runs(p, "text", "shop/web")) as string;
    expect(out.startsWith("\n▶ shop/web · down · local\n\n")).toBe(true);
    expect(out).toMatch(/\nstopped\n/);
    // R16a: the run left the dock collapsed; Show runs shows the output.
    expect(await runs(p, "isOpen")).toBe(false);
    await p.click('#den-dock [data-act="dock"]');
    expect(await p.$("#den-dock-out .cmd")).not.toBeNull();
    expect(await p.$("#den-dock-out .done-ok")).not.toBeNull();
    await p.context().close();
  }, 30_000);

  it("stays open across a click to another page, and lands there", async () => {
    if (!browser) return;
    const p = await open("/services");
    await p.click('#den-dock [data-act="dock"]');
    await p.waitForSelector("#den-dock-out");
    await Promise.all([
      p.waitForURL(/\/logs$/),
      p.click('.den-rail .den-ni[data-nav="logs"]'),
    ]);
    expect(new URL(p.url()).pathname).toBe("/logs");
    expect(
      await p.getAttribute(
        '.den-rail .den-ni[data-nav="logs"]',
        "aria-current",
      ),
    ).toBe("page");
    await p.waitForSelector("#den-dock-out");
    expect(await runs(p, "isOpen")).toBe(true);
    await p.click('#den-dock [data-act="dock"]');
    await Promise.all([
      p.waitForURL(/\/services$/),
      p.click('.den-rail .den-ni[data-nav="services"]'),
    ]);
    await p.waitForSelector("#den-dock .den-bar");
    expect(await p.$("#den-dock-out")).toBeNull();
    await p.context().close();
  }, 30_000);

  it("R16a: collapsed on first load; a run starting leaves it so: its tab appears and the Runs chip pulses", async () => {
    if (!browser) return;
    const p = await open("/services");
    expect(await runs(p, "isOpen")).toBe(false);
    expect(await p.$("#den-dock-out")).toBeNull();
    expect(await p.getAttribute("#den-runs", "aria-expanded")).toBe("false");
    // A real command, clicked: a tab, the dock still just its bar.
    await p.click('.cmd-btn:has-text("down")');
    await p.waitForSelector('#den-dock .den-rtab:has-text("down shop/web")');
    expect(await p.$("#den-dock-out")).toBeNull();
    // A run still going: the chip's dot pulses; still collapsed.
    await runs(p, "start", "long", "up shop/web");
    await p.waitForSelector("#den-runs .den-dot.run");
    // Motion allowed, then wait for the pulse (it failed once on a slow CI
    // runner read straight after the class landed).
    await p.emulateMedia({ reducedMotion: "no-preference" });
    // Polled, not read once: a re-render can swap the dot between the
    // query and the style read (CI read "" once, 0.4.6's release run).
    let pulse = "";
    for (let i = 0; i < 50 && pulse !== "den-pulse"; i++) {
      pulse = await p
        .$eval(
          "#den-runs .den-dot.run",
          (e) => getComputedStyle(e).animationName,
        )
        .catch(() => "");
      if (pulse !== "den-pulse") await p.waitForTimeout(100);
    }
    expect(pulse).toBe("den-pulse");
    expect(await p.$("#den-dock-out")).toBeNull();
    expect(await runs(p, "isOpen")).toBe(false);
    // The engineer opens it: the chip.
    await p.click("#den-runs");
    await p.waitForSelector("#den-dock-out");
    expect(await p.getAttribute("#den-runs", "aria-expanded")).toBe("true");
    await p.context().close();
  }, 30_000);

  it("R16a: a service's Logs opens it (the click is for its output)", async () => {
    if (!browser) return;
    const p = await open("/services");
    await p.click(".cmd-btn.logs-btn");
    await p.waitForSelector("#den-dock-out");
    await p.waitForSelector('#den-dock .den-rtab:has-text("logs shop/web")');
    expect(await runs(p, "isOpen")).toBe(true);
    await p.context().close();
  }, 30_000);

  it("R16a: open/closed and the height are user prefs: a reload and a fresh browser keep them; the drag stops at half the window", async () => {
    if (!browser) return;
    const p = await open("/services");
    await p.click('#den-dock [data-act="dock"]');
    await p.waitForSelector("#den-dock-out");
    // Drag the top edge far up: it stops at half the 800px window.
    const g = (await p.$("#den-dock .den-dock-grip"))!;
    const b = (await g.boundingBox())!;
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(b.x + b.width / 2, 5, { steps: 5 });
    await p.mouse.up();
    expect(
      await p.$eval("#den-dock-out", (e) => getComputedStyle(e).height),
    ).toBe("400px");
    await p.waitForFunction(async (u) => {
      const s = await (await fetch(u)).json();
      return s.shell.dock === true && s.shell.dockHeight === 400;
    }, `http://localhost:${port}/api/settings`);
    expect(await shellPrefs()).toMatchObject({ dock: true, dockHeight: 400 });
    // A reload: open, 400px.
    await p.reload();
    await p.waitForSelector("#den-dock-out");
    expect(
      await p.$eval("#den-dock-out", (e) => getComputedStyle(e).height),
    ).toBe("400px");
    await p.context().close();
    // A fresh browser (no storage of its own): the user's prefs.
    const q = await open("/logs", 1280, { keep: true });
    await q.waitForSelector("#den-dock-out");
    expect(
      await q.$eval("#den-dock-out", (e) => getComputedStyle(e).height),
    ).toBe("400px");
    // Collapsed, and that is remembered too.
    await q.click('#den-dock [data-act="dock"]');
    await q.waitForFunction(
      async (u) => (await (await fetch(u)).json()).shell.dock === false,
      `http://localhost:${port}/api/settings`,
    );
    await q.context().close();
    const r = await open("/logs", 1280, { keep: true });
    await r.waitForTimeout(400);
    expect(await r.$("#den-dock-out")).toBeNull();
    expect(await runs(r, "isOpen")).toBe(false);
    await r.context().close();
  }, 45_000);

  it("narrow (720px and below): the dock spans the window, nothing scrolls sideways", async () => {
    if (!browser) return;
    const p = await open("/services", 400);
    await runs(p, "start", "a", "restart shop/web with a long label");
    const m = await p.evaluate(() => {
      const d = document.getElementById("den-dock")!.getBoundingClientRect();
      return {
        left: d.left,
        width: Math.round(d.width),
        scroll: document.documentElement.scrollWidth,
      };
    });
    expect(m).toEqual({ left: 0, width: 400, scroll: 400 });
    await p.context().close();
  }, 30_000);
});
