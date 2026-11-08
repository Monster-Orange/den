/**
 * The service panel (0.4.18, QA-0.4.14 §C) in a real browser on the real
 * web server (the demo distribution: north with repo notes, south with
 * blog). notes answers its health check (a stub on localhost) so it has a
 * URL and is up; blog's check points at a closed port, so it has a URL and
 * is down.
 *
 * - a pinned row's Visit ↗: named "Visit <id> (opens a new tab)", the URL
 *   as its tooltip; greyed out with "Not running" while down; none without
 *   a URL; no hover × any more;
 * - a click on the row's name opens the panel and doesn't navigate; it
 *   sits beside its row (not at 0,0) inside the window; ⌘/Ctrl-click
 *   still opens Services in a new tab;
 * - Enter on the row opens it with focus inside; Esc closes it and focus
 *   goes back to the row;
 * - each action asks what the pages ask: Start, Stop and Restart the
 *   Services page's /api/service/exec, Logs what the Logs page asks
 *   (/api/service/taillog for a local service, which has no `logs:`
 *   block here), Run tests /api/run; Start agent here opens the Start dialog with the workspace
 *   and the repo's folder, and the agent starts there;
 * - the Services card's name and the Graph card's ⋯ open the same panel;
 * - under 640 px it is a bottom sheet;
 * - its controls are buttons with plain names (the accessibility tree);
 * - blog's `up` is a dev server that never exits (it serves blog's health
 *   port): after Start, "starting…" follows the health feed and Restart
 *   comes back; once it stops, the rail's ↗ greys out within a tick, as
 *   the panel says down, also with the top bar's View on another
 *   workspace;
 * - Open in Graph, and a direct /graph#focus=<id>, focus the card, also
 *   with the View on one workspace (the Graph page's ?ws=);
 * - Open in Graph for a pin outside the View (View: north, blog in south)
 *   says "blog is in south, outside this View." with Show south, which
 *   switches the View and focuses the card; the View never switches by
 *   itself;
 * - blog's dev server listens 2 s after Start and answers a second late:
 *   the panel says starting… until up, never down, after Start and after
 *   Restart.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let stub: http.Server | null = null;
let stubUrl = "";
let deadUrl = "";
let devUp = "";
let latest = "";
const errors: string[] = [];
const PTY = loadPty().available;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  stub = http.createServer((_q, r) => r.end("ok"));
  await new Promise<void>((r) => stub!.listen(0, "localhost", r));
  stubUrl = `http://localhost:${(stub.address() as AddressInfo).port}`;
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, "localhost", r));
  deadUrl = `http://localhost:${(closed.address() as AddressInfo).port}`;
  await new Promise<void>((r) => closed.close(() => r()));
  // blog's up: a dev server on blog's health port that never exits (GET
  // /quit stops it; it gives up by itself after 5 minutes). It listens 2 s
  // after it starts, so health says down for a while after Start, and it
  // answers a second late, so the header's refresh paints notes first,
  // with blog's last (down) result still in it.
  const port = new URL(deadUrl).port;
  const code =
    `const s=require("http").createServer((q,r)=>{if(q.url==="/quit"){r.end("ok");process.exit(0)}setTimeout(()=>r.end("ok"),1000)});` +
    `setTimeout(()=>s.listen(${port},"localhost"),2000);setTimeout(()=>process.exit(0),300000)`;
  devUp = `${JSON.stringify(process.execPath)} -e '${code}'`;
  s = await startAgentsPageServer({
    health: { notes: `${stubUrl}/health`, blog: `${deadUrl}/health` },
    up: { blog: devUp },
  });
  expect(await s.settings({ shell: { pins: ["notes", "blog"] } })).toBe(200);
  // An agent working in notes' repo, and one elsewhere in the workspace.
  s.seed({ id: "notes-helper", workspace: "north", cwd: repo("notes") });
  s.seed({ id: "elsewhere", workspace: "north" });
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 60_000);

afterAll(async () => {
  if (devUp) await fetch(`${deadUrl}/quit`).catch(() => undefined);
  await browser?.close();
  await s?.stop();
  await new Promise<void>((r) => (stub ? stub.close(() => r()) : r()));
});

const skip = () => !browser || !s;
const repo = (name: string) => path.join(s!.tmp, "repos", name);

/** Start a planner in `folder` from the page; the response's status. */
async function startIn(p: Page, folder: string): Promise<number> {
  return p.evaluate(async (outside) => {
    try {
      await (
        window as unknown as {
          denShell: {
            api(m: string, u: string, b: unknown): Promise<unknown>;
          };
        }
      ).denShell.api("POST", "/api/workspaces/north/agents", {
        persona: "planner",
        folder: outside,
      });
      return 200;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  }, folder);
}

/** The top bar's View: "all" or one workspace (a server setting). */
async function view(p: Page, scope: string): Promise<void> {
  await p.evaluate(async (v) => {
    await (
      window as unknown as {
        denShell: { api(m: string, u: string, b: unknown): Promise<unknown> };
      }
    ).denShell.api("POST", "/api/scope", { scope: v });
  }, scope);
}

/** A page of the real server; `asked` records every /api stream and write. */
async function page(
  url: string,
  width = 1440,
  height = 900,
): Promise<{ p: Page; asked: string[] }> {
  const ctx = await browser!.newContext({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  const asked: string[] = [];
  p.on("request", (r) => {
    const u = new URL(r.url());
    if (
      /^\/api\/(service\/(exec|logs|taillog)|run)$/.test(u.pathname) ||
      (r.method() === "POST" && u.pathname.startsWith("/api/workspaces/"))
    )
      asked.push(`${r.method()} ${u.pathname}${u.search}`);
  });
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(`${s!.base}${url}`);
  return { p, asked };
}

/** The rail's pinned rows once health has painted their Visit ↗. */
async function railReady(p: Page): Promise<void> {
  await p.waitForSelector('.den-rail [data-pin="notes"]');
  await p.waitForSelector('.den-rail [data-visit="notes"]', {
    timeout: 20_000,
  });
  await p.waitForSelector(
    '.den-rail [data-visit="blog"][aria-disabled="true"]',
    {
      timeout: 20_000,
    },
  );
}
const panel = ".den-svp[role='dialog']";
const rect = (p: Page, sel: string) =>
  p.$eval(sel, (e) => {
    const b = e.getBoundingClientRect();
    return {
      x: b.left,
      y: b.top,
      w: b.width,
      h: b.height,
      r: b.right,
      b: b.bottom,
    };
  });
/** Wait for the stream `want` (a path and query prefix) to be asked. */
async function asks(asked: string[], want: string): Promise<string> {
  const end = Date.now() + 10_000;
  for (;;) {
    const hit = asked.find((a) => a.startsWith(want));
    if (hit) return hit;
    if (Date.now() > end)
      throw new Error(`never asked ${want}: ${asked.join(", ")}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("a pinned row's Visit ↗", () => {
  it("is named for its service, its URL the tooltip; greyed out while down; no ×", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await railReady(p);
    const visit = (id: string) =>
      p.$eval(`.den-rail [data-visit="${id}"]`, (b) => ({
        label: b.getAttribute("aria-label"),
        title: b.getAttribute("title"),
        disabled: b.getAttribute("aria-disabled"),
        text: b.textContent,
        inLink: b.closest("a") !== null,
      }));
    expect(await visit("notes")).toEqual({
      label: "Visit notes (opens a new tab)",
      title: `${stubUrl}/`,
      disabled: null,
      text: "↗",
      inLink: false,
    });
    expect(await visit("blog")).toEqual({
      label: "Visit blog (opens a new tab)",
      title: "Not running",
      disabled: "true",
      text: "↗",
      inLink: false,
    });
    // Always shown (touch), beside the row, 26 px square (the mock).
    const v = await rect(p, '.den-rail [data-visit="notes"]');
    expect([v.w, v.h]).toEqual([26, 26]);
    const row = await rect(p, '.den-rail [data-pin="notes"]');
    expect(v.x).toBeGreaterThanOrEqual(row.r);
    // The hover × is gone; Unpin is in the panel's footer.
    expect(await p.$$(".den-rail [data-unpin], .den-pin-x")).toHaveLength(0);
    // A click on a greyed-out Visit says why and opens nothing.
    const pages = p.context().pages().length;
    // (aria-disabled: Playwright's click won't, a person's does.)
    await p.click('.den-rail [data-visit="blog"]', { force: true });
    expect(await p.textContent(".den-toast")).toBe("Not running");
    expect(p.context().pages().length).toBe(pages);
    // A click on a live one opens its URL in a new tab.
    const [tab] = await Promise.all([
      p.context().waitForEvent("page"),
      p.click('.den-rail [data-visit="notes"]'),
    ]);
    await tab.waitForLoadState();
    expect(tab.url()).toBe(`${stubUrl}/`);
    await p.context().close();
  }, 60_000);

  it("has none without a URL", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await railReady(p);
    // A pin no health result has (no URL): its row, but no ↗.
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { pin(id: string): void } }
      ).denShell.pin("nowhere"),
    );
    await p.waitForSelector('.den-rail [data-pin="nowhere"]');
    expect(await p.$$('.den-rail [data-visit="nowhere"]')).toHaveLength(0);
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { unpin(id: string): void } }
      ).denShell.unpin("nowhere"),
    );
    await p.context().close();
  }, 60_000);
});

describe("the panel", () => {
  it("opens on a click without navigating, beside its row, inside the window", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await railReady(p);
    const before = p.url();
    await p.click('.den-rail [data-pin="notes"]');
    await p.waitForSelector(panel);
    expect(p.url()).toBe(before);
    expect(
      await p.getAttribute('.den-rail [data-pin="notes"]', "aria-expanded"),
    ).toBe("true");
    expect(await p.getAttribute(panel, "aria-label")).toBe(
      "notes: quick panel",
    );
    // In the top layer, beside the rail and level with its row (the mock:
    // the rail's right + 8, the row's top − 6), 340 wide, in the window.
    expect(await p.$eval(panel, (e) => e.matches(":popover-open"))).toBe(true);
    const b = await rect(p, panel);
    const rail = await rect(p, ".den-rail");
    const row = await rect(p, ".den-rail .den-pin-row:has([data-pin='notes'])");
    expect(b.w).toBe(340);
    expect(Math.abs(b.x - (rail.r + 8))).toBeLessThanOrEqual(1);
    expect(Math.abs(b.y - (row.y - 6))).toBeLessThanOrEqual(1);
    expect(b.x).toBeGreaterThan(0);
    expect(b.y).toBeGreaterThan(0);
    expect(b.r).toBeLessThanOrEqual(1440);
    expect(b.b).toBeLessThanOrEqual(900);
    // What it shows: the name, workspace, state and URL, then the actions.
    expect(await p.textContent(`${panel} .den-svp-t b`)).toBe("notes");
    expect(await p.textContent(`${panel} .den-wsp`)).toBe("north");
    expect(await p.textContent(`${panel} .den-svp-url`)).toBe(`${stubUrl}/`);
    expect(
      await p.$$eval(`${panel} .den-svp-acts .den-btn`, (bs) =>
        bs.map((x) => x.textContent),
      ),
    ).toEqual(["Visit ↗", "Stop", "Restart", "Logs"]);
    expect(
      await p.$$eval(`${panel} .den-svp-foot .den-lnk`, (bs) =>
        bs.map((x) => x.textContent),
      ),
    ).toEqual(["Open in Services", "Open in Graph", "Unpin"]);
    // The agents working in notes' repo, with Open.
    await p.waitForSelector(`${panel} .den-svp-ag`);
    expect(
      await p.$$eval(`${panel} .den-svp-nm`, (e) =>
        e.map((x) => x.textContent),
      ),
    ).toEqual(["notes-helper"]);
    // A click outside closes it.
    await p.mouse.click(1200, 600);
    expect(await p.$$(panel)).toHaveLength(0);
    expect(
      await p.getAttribute('.den-rail [data-pin="notes"]', "aria-expanded"),
    ).toBe("false");
    await p.context().close();
  }, 60_000);

  it("Enter on the row opens it with focus inside; Esc closes it and focus goes back", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await railReady(p);
    await p.focus('.den-rail [data-pin="notes"]');
    await p.keyboard.press("Enter");
    await p.waitForSelector(panel);
    expect(
      await p.evaluate(() => [
        document.activeElement?.closest(".den-svp") !== null,
        document.activeElement?.textContent,
      ]),
    ).toEqual([true, "Visit ↗"]);
    await p.keyboard.press("Escape");
    expect(await p.$$(panel)).toHaveLength(0);
    expect(
      await p.evaluate(
        () => (document.activeElement as HTMLElement).dataset.pin,
      ),
    ).toBe("notes");
    await p.context().close();
  }, 60_000);

  it("⌘/Ctrl-click on the row still opens Services in a new tab", async () => {
    if (skip()) return;
    const { p } = await page("/agents");
    await railReady(p);
    const [tab] = await Promise.all([
      p.context().waitForEvent("page"),
      p.click('.den-rail [data-pin="notes"]', {
        modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
      }),
    ]);
    await tab.waitForURL(/\/services/);
    expect(new URL(tab.url()).pathname + new URL(tab.url()).hash).toBe(
      "/services#repo-notes",
    );
    expect(await p.$$(panel)).toHaveLength(0);
    await p.context().close();
  }, 60_000);

  it("each action asks what the Services page asks", async () => {
    if (skip()) return;
    // The Services page's own up and logs buttons, for the record.
    const svc = await page("/services");
    await svc.p.waitForSelector('.cmd-btn[data-repo="notes"][data-cmd="up"]');
    await svc.p.click('.cmd-btn[data-repo="notes"][data-cmd="up"]');
    const pageUp = await asks(svc.asked, "GET /api/service/exec?");
    await svc.p.context().close();

    const { p, asked } = await page("/services");
    await railReady(p);
    await p.click('.den-rail [data-pin="notes"]');
    await p.waitForSelector(panel);
    // Stop: down, the same route and fields as the page's.
    await p.click(`${panel} [data-svx="stop"]`);
    const down = await asks(asked, "GET /api/service/exec?");
    expect(down).toBe(pageUp.replace("cmd=up", "cmd=down"));
    asked.length = 0;
    await p.click(`${panel} [data-svx="restart"]`);
    expect(await asks(asked, "GET /api/service/exec?")).toBe(
      pageUp.replace("cmd=up", "cmd=restart"),
    );
    asked.length = 0;
    await p.click(`${panel} [data-svx="logs"]`);
    // What the Logs page asks for a local service: taillog (notes has no
    // `logs:` block, so /api/service/logs would 404).
    expect(await asks(asked, "GET /api/service/")).toBe(
      "GET /api/service/taillog?repo=notes&service=notes",
    );
    // Logs opens the runs dock on that service's tab, and it reads.
    await p.waitForSelector(".den-dock:not([hidden])");
    await p.waitForTimeout(1_500);
    expect(await p.textContent(".den-dock")).not.toContain("Connection closed");
    asked.length = 0;
    await p.click(`${panel} [data-svx="tests"]`);
    expect(await asks(asked, "GET /api/run?")).toBe(
      "GET /api/run?pillar=suites&module=notes&env=local",
    );
    await p.context().close();
  }, 90_000);

  it("Start agent here opens the Start dialog with the workspace and the repo's folder; the agent runs there", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await railReady(p);
    await p.click('.den-rail [data-pin="notes"]');
    await p.waitForSelector(panel);
    await Promise.all([
      p.waitForURL(/\/agents\?/),
      p.click(`${panel} [data-svx="startag"]`),
    ]);
    await p.waitForSelector("#ag-dlg[open]", { timeout: 20_000 });
    expect(await p.inputValue("#ag-ws")).toBe("north");
    expect(await p.inputValue("#ag-folder")).toBe(repo("notes"));
    expect(await p.textContent("#ag-folder-t")).toBe("Folder (optional)");
    if (!PTY) return void (await p.context().close());
    await p.waitForSelector('#ag-persona [data-pid="planner"]');
    await p.click('#ag-persona [data-pid="planner"]');
    const [res] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/workspaces/north/agents",
        { timeout: 20_000 },
      ),
      p.click("#ag-go"),
    ]);
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.request().postData() ?? "{}")).toMatchObject({
      folder: repo("notes"),
    });
    const agent = ((await res.json()) as { agent: { id: string; cwd: string } })
      .agent;
    expect(agent.cwd).toBe(fs.realpathSync(repo("notes")));
    expect(readRecord(s!.stateDir, agent.id)?.cwd).toBe(
      fs.realpathSync(repo("notes")),
    );
    await p.context().close();
  }, 90_000);

  it("a folder outside the workspace is refused, a link inside it that points out too", async () => {
    if (skip()) return;
    const { p } = await page("/agents");
    await p.waitForSelector(".den-rail .den-ni");
    const link = path.join(repo("notes"), "escape");
    fs.symlinkSync(path.dirname(s!.tmp), link);
    try {
      for (const outside of [path.dirname(s!.tmp), link])
        expect(await startIn(p, outside)).toBe(403);
    } finally {
      fs.unlinkSync(link);
    }
    await p.context().close();
  }, 60_000);

  it("the Services card's name and the Graph card's ⋯ open the same panel", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await railReady(p);
    const name = '.svc-name-btn[data-svpanel-open="notes"]';
    await p.waitForSelector(name);
    const before = p.url();
    await p.click(name);
    await p.waitForSelector(panel);
    expect(p.url()).toBe(before);
    expect(await p.textContent(`${panel} .den-svp-t b`)).toBe("notes");
    // Anchored to the name: just below it.
    const n = await rect(p, name);
    const b = await rect(p, panel);
    expect(Math.abs(b.y - (n.b + 6))).toBeLessThanOrEqual(1);
    await p.keyboard.press("Escape");
    expect(await p.evaluate(() => document.activeElement?.className)).toBe(
      "svc-name-btn",
    );
    await p.context().close();

    const g = await page("/graph");
    // A one-service repo's card is the repo's (its id "notes").
    const more = '.dg-svp[data-svpanel-open="notes"]';
    await g.p.waitForSelector(more, { timeout: 20_000 });
    await g.p.click(more);
    await g.p.waitForSelector(panel);
    expect(await g.p.textContent(`${panel} .den-svp-t b`)).toBe("notes");
    // The card's details didn't open under it.
    expect(await g.p.$eval(".dg-panel", (e) => (e as HTMLElement).hidden)).toBe(
      true,
    );
    await g.p.context().close();
  }, 90_000);

  it("collapsed rail: the dot opens the same panel, Visit is its first button", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await railReady(p);
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { setCollapsed(on: boolean): void } }
      ).denShell.setCollapsed(true),
    );
    await p.waitForSelector("body.den-rail-collapsed");
    expect(
      await p.$eval(
        '.den-rail [data-visit="notes"]',
        (b) => getComputedStyle(b).display,
      ),
    ).toBe("none");
    await p.click('.den-rail [data-pin="notes"]');
    await p.waitForSelector(panel);
    expect(
      await p.evaluate(() =>
        document.activeElement?.getAttribute("data-visit"),
      ),
    ).toBe("notes");
    const b = await rect(p, panel);
    const rail = await rect(p, ".den-rail");
    expect(Math.abs(b.x - (rail.r + 8))).toBeLessThanOrEqual(1);
    await p.keyboard.press("Escape");
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { setCollapsed(on: boolean): void } }
      ).denShell.setCollapsed(false),
    );
    await p.context().close();
  }, 60_000);

  it("is a bottom sheet under 640 px", async () => {
    if (skip()) return;
    const { p } = await page("/services", 390, 844);
    await p.waitForSelector('.den-rail [data-pin="notes"]', {
      state: "attached",
    });
    await p.click(".den-menu-btn");
    await railReady(p);
    await p.click('.den-rail [data-pin="notes"]');
    await p.waitForSelector(`${panel}.den-sheet`);
    const b = await rect(p, panel);
    expect([b.x, b.w, b.b]).toEqual([0, 390, 844]);
    expect(b.h).toBeLessThanOrEqual(844 * 0.85 + 1);
    // Its scrim closes it.
    await p.mouse.click(195, 10);
    expect(await p.$$(panel)).toHaveLength(0);
    await p.context().close();
  }, 60_000);

  it("names every control plainly (the accessibility tree)", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await railReady(p);
    await p.click('.den-rail [data-pin="notes"]');
    await p.waitForSelector(`${panel} .den-svp-ag`);
    const dlg = p.getByRole("dialog", { name: "notes: quick panel" });
    for (const name of [
      "Close",
      "Visit notes (opens a new tab)",
      "Stop",
      "Restart",
      "Logs",
      "Run tests",
      "Open notes-helper",
      "+ Start agent here",
      "Open in Services",
      "Open in Graph",
      "Unpin",
    ])
      expect([
        name,
        await dlg.getByRole("button", { name, exact: true }).count(),
      ]).toEqual([name, 1]);
    // Unpin: the row goes, focus stays in the rail.
    await dlg.getByRole("button", { name: "Unpin", exact: true }).click();
    expect(await p.$$('.den-rail [data-pin="notes"]')).toHaveLength(0);
    expect(await p.$$(panel)).toHaveLength(0);
    expect(
      await p.evaluate(
        () => document.activeElement?.closest(".den-rail") !== null,
      ),
    ).toBe(true);
    await p.evaluate(() =>
      (
        window as unknown as { denShell: { pin(id: string): void } }
      ).denShell.pin("notes"),
    );
    await p.context().close();
  }, 60_000);
});

describe("a dev server whose up never exits (blog)", () => {
  const st = `${panel} .den-svp-st`;
  const text = (p: Page) => p.textContent(st);

  it("after Start, starting… follows the health feed and Restart comes back", async () => {
    if (skip()) return;
    const { p, asked } = await page("/services");
    await railReady(p);
    await p.click('.den-rail [data-pin="blog"]');
    await p.waitForSelector(panel);
    // Every state text the panel shows from Start's starting… on (each
    // repaint; blog is down before it).
    await p.evaluate((sel) => {
      const w = window as unknown as { seen: string[] };
      w.seen = [];
      const note = () => {
        const v = document.querySelector(sel)?.textContent ?? "";
        if (!w.seen.length && v !== "starting…") return;
        if (v && w.seen[w.seen.length - 1] !== v) w.seen.push(v);
      };
      new MutationObserver(note).observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
      setInterval(note, 20);
    }, st);
    await p.click(`${panel} [data-svx="start"]`);
    await asks(asked, "GET /api/service/exec?");
    await p.waitForFunction(
      (sel) => document.querySelector(sel)?.textContent === "starting…",
      st,
    );
    expect(
      await p.$eval(`${panel} [data-svx="restart"]`, (b) =>
        b.hasAttribute("disabled"),
      ),
    ).toBe(true);
    // Health says up (the dev server answers): starting… clears, though
    // the up stream is still open.
    await p.waitForFunction(
      (sel) => /^up\b/.test(document.querySelector(sel)?.textContent ?? ""),
      st,
      { timeout: 30_000 },
    );
    expect(await (await fetch(`${deadUrl}/health`)).text()).toBe("ok");
    // Health said down for its first 2 s: the panel said starting… then,
    // never down.
    const seen = await p.evaluate(
      () => (window as unknown as { seen: string[] }).seen,
    );
    expect(seen.filter((v) => /^down/.test(v))).toEqual([]);
    expect(seen[seen.length - 1]).toMatch(/^up\b/);
    expect(
      await p.$eval(`${panel} [data-svx="restart"]`, (b) =>
        b.hasAttribute("disabled"),
      ),
    ).toBe(false);
    expect(await text(p)).not.toBe("starting…");
    // Restart: starting… again (the old one goes down, the new one listens
    // 2 s later), then up, never down.
    await p.evaluate(() => {
      (window as unknown as { seen: string[] }).seen = [];
    });
    await p.click(`${panel} [data-svx="restart"]`);
    await p.waitForFunction(
      (sel) => /^up\b/.test(document.querySelector(sel)?.textContent ?? ""),
      st,
      { timeout: 30_000 },
    );
    const again = await p.evaluate(
      () => (window as unknown as { seen: string[] }).seen,
    );
    expect(again[0]).toBe("starting…");
    expect(again.filter((v) => /^down/.test(v))).toEqual([]);
    expect(await (await fetch(`${deadUrl}/health`)).text()).toBe("ok");
    await p.context().close();
  }, 90_000);

  it("once it stops, the rail's ↗ greys out within a tick of the panel saying down", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    // The View on north: blog (south) is out of view, still pinned.
    await view(p, "north");
    try {
      await p.reload();
      await p.waitForSelector(
        '.den-rail [data-visit="blog"]:not([aria-disabled])',
        { timeout: 20_000 },
      );
      await p.click('.den-rail [data-pin="blog"]');
      await p.waitForSelector(panel);
      await fetch(`${deadUrl}/quit`).catch(() => undefined);
      await p.waitForFunction(
        (sel) => /^down/.test(document.querySelector(sel)?.textContent ?? ""),
        st,
        { timeout: 30_000 },
      );
      // One feed tick (5 s) at most after the panel's dot.
      await p.waitForSelector(
        '.den-rail [data-visit="blog"][aria-disabled="true"]',
        { timeout: 6_000 },
      );
      expect(
        await p.getAttribute('.den-rail [data-visit="blog"]', "title"),
      ).toBe("Not running");
    } finally {
      await view(p, "all");
      await p.context().close();
    }
  }, 90_000);
});

describe("Open in Graph", () => {
  const card = '.dg-card.sel:has([data-svpanel-open="notes"])';
  /** The focused card: selected, and inside the graph's viewport. */
  async function focused(p: Page): Promise<void> {
    await p.waitForSelector(card, { timeout: 20_000 });
    expect(await p.evaluate(() => location.hash)).toBe("#focus=notes");
    const c = await rect(p, card);
    const vp = await rect(p, ".dg-vp");
    expect(c.x).toBeGreaterThanOrEqual(vp.x);
    expect(c.y).toBeGreaterThanOrEqual(vp.y);
    expect(c.r).toBeLessThanOrEqual(vp.r);
    expect(c.b).toBeLessThanOrEqual(vp.b);
  }

  it.each(["all", "north"])(
    "a direct /graph#focus=<id> focuses the card (View: %s)",
    async (scope) => {
      if (skip()) return;
      const { p } = await page("/services");
      await view(p, scope);
      try {
        await p.goto(`${s!.base}/graph#focus=notes`);
        await focused(p);
      } finally {
        await view(p, "all");
        await p.context().close();
      }
    },
    60_000,
  );

  it("the panel's Open in Graph focuses the card (View: north)", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await view(p, "north");
    try {
      await p.reload();
      await p.waitForSelector('.den-rail [data-visit="notes"]', {
        timeout: 20_000,
      });
      await p.click('.den-rail [data-pin="notes"]');
      await p.waitForSelector(panel);
      await Promise.all([
        p.waitForURL(/\/graph/),
        p.click(`${panel} [data-svx="graph"]`),
      ]);
      await focused(p);
    } finally {
      await view(p, "all");
      await p.context().close();
    }
  }, 60_000);
});

describe("Open in Graph for a pin outside the View", () => {
  const out = ".dg-out";
  const card = (id: string) => `.dg-card:has([data-svpanel-open="${id}"])`;

  it("says where it is, and Show south switches the View and focuses the card", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    const before = await (await fetch(`${s!.base}/api/scope`)).json();
    await view(p, "north");
    try {
      await p.reload();
      await p.waitForSelector('.den-rail [data-pin="blog"]', {
        timeout: 20_000,
      });
      await p.click('.den-rail [data-pin="blog"]');
      await p.waitForSelector(panel);
      await Promise.all([
        p.waitForURL(/\/graph/),
        p.click(`${panel} [data-svx="graph"]`),
      ]);
      await p.waitForSelector(out, { timeout: 20_000 });
      expect((await p.textContent(`${out} span`))?.trim()).toBe(
        "blog is in south, outside this View.",
      );
      expect(await p.textContent(`${out} button`)).toBe("Show south");
      expect(await p.$(card("blog"))).toBeNull();
      // The View didn't switch by itself.
      expect(
        (
          (await (await fetch(`${s!.base}/api/scope`)).json()) as {
            scope: string;
          }
        ).scope,
      ).toBe("north");
      await Promise.all([p.waitForEvent("load"), p.click(`${out} button`)]);
      await p.waitForSelector(`${card("blog")}.sel`, { timeout: 20_000 });
      expect(
        (
          (await (await fetch(`${s!.base}/api/scope`)).json()) as {
            scope: string;
          }
        ).scope,
      ).toBe("south");
      expect(await p.evaluate(() => location.hash)).toBe("#focus=blog");
      expect(await p.$(out)).toBeNull();
      const c = await rect(p, `${card("blog")}.sel`);
      const vp = await rect(p, ".dg-vp");
      expect(c.x).toBeGreaterThanOrEqual(vp.x);
      expect(c.y).toBeGreaterThanOrEqual(vp.y);
      expect(c.r).toBeLessThanOrEqual(vp.r);
      expect(c.b).toBeLessThanOrEqual(vp.b);
    } finally {
      await p.evaluate(
        async (name) => {
          const sh = (
            window as unknown as {
              denShell: {
                api(m: string, u: string, b: unknown): Promise<unknown>;
              };
            }
          ).denShell;
          if (name)
            await sh.api("POST", "/api/workspaces", { name, action: "focus" });
        },
        (before as { focus?: string }).focus ?? "",
      );
      await view(p, "all");
      await p.context().close();
    }
  }, 90_000);

  it("a service in the View shows no line", async () => {
    if (skip()) return;
    const { p } = await page("/services");
    await view(p, "north");
    try {
      await p.goto(`${s!.base}/graph#focus=notes`);
      await p.waitForSelector(`${card("notes")}.sel`, { timeout: 20_000 });
      expect(await p.$(out)).toBeNull();
    } finally {
      await view(p, "all");
      await p.context().close();
    }
  }, 60_000);
});

describe("the page", () => {
  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
