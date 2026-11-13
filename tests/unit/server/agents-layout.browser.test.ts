/**
 * The Agents tab's layouts (AG-4b, AG spec "AG-4b: Agents tab layout") in
 * a real browser, with four agents running:
 *
 *   - the page fills the window: the list and the panes end 14px above the
 *     runs dock at 1440x900 and 1440x1300, in every layout, with the dock
 *     shut or open (no 100vh guess);
 *   - Focus (the default), Tabs and Tile, from the page header's switch,
 *     ⌃⇧1 / ⌃⇧2 / ⌃⇧3 (never ⌘1-3 or Ctrl+1-3: the browser's tabs) or ⌘K
 *     "Layout: …"; inside a terminal the keys never reach the agent; the
 *     URL says it (&layout=), and it is saved for the person (POST
 *     /api/settings agents_layout), so a reload keeps it;
 *   - Focus: a click replaces the pane, Shift-click adds one alongside;
 *     Tabs: one pane under a tab strip, each tab the agent's name, then
 *     its persona and workspace, and a dot when it is waiting; Tile: a
 *     real grid, 1 full, 2 side by side, 3-4 as 2x2, never three columns;
 *   - double-click a tab to rename it: the name is the agent record's, and
 *     the list, the pane's bar and ⌘K show it; Esc keeps the old one; the
 *     id never changes;
 *   - at 390px Focus and Tile are Tabs;
 *   - every terminal fits its pane in every layout: xterm's screen inside
 *     the pane, less than a cell (and xterm's 14px scrollbar) to spare.
 *
 * The demo distribution (acme; north, south) with a session host in this
 * process and a scripted PTY (helpers/agents-page-server.ts): nothing
 * really runs. DEN_AGENTS_SHOTS=<dir> writes screenshots.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let browser: Browser | null = null;
let latest = "";
const SHOTS = process.env.DEN_AGENTS_SHOTS;
const errors: string[] = [];

/** The four agents: id, persona, workspace. */
const AGENTS = [
  ["planner", "planner", "north"],
  ["reviewer", "reviewer", "north"],
  ["builder", "builder", "south"],
  ["scout", "reviewer", "south"],
] as const;
const sid: Record<string, string> = {};

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  host = await connectHost(sessionPaths(s.stateDir).socket);
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  for (const [id, persona, ws] of AGENTS) {
    const info = await host.start({
      name: `acme-${ws}:${id}`,
      cwd: s.wsDir(ws),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    sid[id] = info.ref.id;
    ptys[id] = s.made[s.made.length - 1];
    s.seed({
      id,
      persona,
      workspace: ws,
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: `acme-${ws}:${id}`,
    });
    ptys[id].emit(`${id} ready\r\n${"=".repeat(200)}\r\n$ `);
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  host?.close();
  await s?.stop();
});

const skip = () => !browser;
/** Agent `id`'s scripted PTY (what the page typed into it). #70: by start order, as all carry this process's pid. */
const ptys: Record<string, AgentsPageServer["made"][number]> = {};
const ptyOf = (id: string) => ptys[id];
const all = () => AGENTS.map(([id]) => sid[id]).join(",");

async function page(
  url: string,
  opts: { width?: number; height?: number; waiting?: string } = {},
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
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
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`${url}: console: ${m.text()}`);
  });
  // The host knows nothing of approvals yet (AG-6a): one agent waits here.
  if (opts.waiting)
    await p.route("**/api/sessions", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as {
        sessions: Record<string, unknown>[];
      };
      for (const x of body.sessions)
        if (x.agent === opts.waiting) x.waiting = true;
      await r.fulfill({ response: res, body: JSON.stringify(body) });
    });
  await p.goto(`${s!.base}${url}`);
  await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
  return p;
}

async function eventually(
  pred: () => Promise<boolean> | boolean,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The panes on screen, in the page's order. */
const shown = (p: Page) =>
  p.$$eval("#agr .pane", (ps) =>
    ps
      .filter((x) => (x as HTMLElement).offsetWidth > 0)
      .map((x) => (x as HTMLElement).dataset.id!),
  );
const rect = (p: Page, sel: string) =>
  p.$eval(sel, (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, b: r.bottom };
  });
const layoutOf = (p: Page) =>
  p.$eval("#agr", (e) => (e as HTMLElement).dataset.layout ?? "");
const urlLayout = (p: Page) => new URL(p.url()).searchParams.get("layout");
const saved = async () =>
  (
    (await (await fetch(`${s!.base}/api/settings`)).json()) as {
      agents_layout?: string;
    }
  ).agents_layout;

/**
 * Each pane on screen: its terminal fits it. xterm's screen sits inside
 * the pane, and what is left beside and below it is less than one cell
 * (beside: and the scrollbar xterm's fit leaves room for). The cell is
 * the one xterm drew with (its renderer's CSS cell, sub-pixel: the pane's
 * data-cell-w and data-cell-h), never the screen's size over its rows,
 * which rounds; the space is what xterm's fit reads (whole pixels, as
 * parseInt reads its computed size) of the .term's content box.
 */
async function fits(p: Page): Promise<string[]> {
  return p.$$eval("#agr .pane", (ps) =>
    ps
      .filter((x) => (x as HTMLElement).offsetWidth > 0)
      .flatMap((pane) => {
        const el = pane as HTMLElement;
        const term = el.querySelector(".term") as HTMLElement;
        const scr = el.querySelector(".xterm-screen") as HTMLElement | null;
        const id = el.dataset.id;
        if (!scr) return [`${id}: no terminal`];
        const cw = Number(el.dataset.cellW);
        const ch = Number(el.dataset.cellH);
        if (!(cw > 0) || !(ch > 0)) return [`${id}: no cell size`];
        const cs = getComputedStyle(term);
        const tr = term.getBoundingClientRect();
        const px = (k: string) => parseFloat(cs.getPropertyValue(k)) || 0;
        // The .term's content box, in CSS pixels (not clientWidth: it rounds).
        const w =
          tr.width -
          px("padding-left") -
          px("padding-right") -
          px("border-left-width") -
          px("border-right-width");
        const h =
          tr.height -
          px("padding-top") -
          px("padding-bottom") -
          px("border-top-width") -
          px("border-bottom-width");
        const sr = scr.getBoundingClientRect();
        const pr = el.getBoundingClientRect();
        const cols = Number(el.dataset.cols);
        const rows = Number(el.dataset.rows);
        const out: string[] = [];
        if (sr.right > pr.right + 0.5 || sr.bottom > pr.bottom + 0.5)
          out.push(`${id}: the screen overflows the pane`);
        if (sr.width > w + 0.5 || sr.height > h + 0.5)
          out.push(
            `${id}: the screen (${sr.width}x${sr.height}) is bigger than its box (${w}x${h})`,
          );
        // xterm's fit leaves 14px for its scrollbar (addon-fit 0.11).
        const beside = Math.floor(w) - 14 - cols * cw;
        if (beside < 0 || beside >= cw)
          out.push(`${id}: ${beside}px beside it (a cell is ${cw})`);
        // A whole cell left below is a missed row.
        const below = Math.floor(h) - rows * ch;
        if (below < 0 || below >= ch)
          out.push(`${id}: ${below}px below it (a cell is ${ch})`);
        return out;
      }),
  );
}
let cellLogged = false;
async function expectFits(p: Page): Promise<void> {
  if (!cellLogged) {
    cellLogged = true;
    const c = await p.$eval("#agr .pane[data-cell-h]", (e) => ({
      w: (e as HTMLElement).dataset.cellW,
      h: (e as HTMLElement).dataset.cellH,
      dpr: devicePixelRatio,
    }));
    // Measured: xterm's CSS cell on this machine.
    process.stdout.write(
      `AG-4b cell: ${c.w} x ${c.h} css px (devicePixelRatio ${c.dpr})\n`,
    );
  }
  let last: string[] = [];
  try {
    await eventually(async () => (last = await fits(p)).length === 0);
  } catch {
    expect(last).toEqual([]);
  }
}

/** Each pane's terminal is up (its screen drawn). */
async function termsUp(p: Page, n: number): Promise<void> {
  await p.waitForFunction(
    (k) =>
      [...document.querySelectorAll("#agr .pane")].filter(
        (x) =>
          (x as HTMLElement).offsetWidth > 0 &&
          x.querySelector(".xterm-screen"),
      ).length === k,
    n,
    { timeout: 20_000 },
  );
}

const shot = async (p: Page, name: string) => {
  if (!SHOTS) return;
  // Each pane in sight has drawn its scrollback ("<id> ready") first.
  await p
    .waitForFunction(
      () =>
        [...document.querySelectorAll("#agr .pane")]
          .filter((x) => (x as HTMLElement).offsetWidth > 0)
          .every((x) =>
            (x.querySelector(".xterm-rows")?.textContent ?? "").includes(
              "ready",
            ),
          ),
      null,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

describe("the Agents tab's layouts (AG-4b)", () => {
  it.each([900, 1300])(
    "fills the window at 1440x%i: the list and the panes end 14px above the runs dock, in every layout, the dock shut or open",
    async (height) => {
      if (skip()) return;
      await s!.settings({ agents_layout: null, shell: { dock: null } });
      for (const layout of ["focus", "tabs", "tile"]) {
        const p = await page(`/agents?open=${all()}&layout=${layout}`, {
          height,
        });
        await termsUp(p, layout === "tile" ? 4 : 1);
        for (const dock of ["shut", "open"]) {
          if (dock === "open") {
            await p.click('.den-dock [data-act="dock"]');
            await p.waitForSelector("#den-dock-out");
          }
          await eventually(async () => {
            const [d, l, r] = await Promise.all([
              rect(p, "#den-dock"),
              rect(p, "#agl"),
              rect(p, "#agr"),
            ]);
            return (
              Math.abs(d.y - 14 - l.b) <= 0.5 && Math.abs(d.y - 14 - r.b) <= 0.5
            );
          });
          const [d, l, r] = await Promise.all([
            rect(p, "#den-dock"),
            rect(p, "#agl"),
            rect(p, "#agr"),
          ]);
          // Measured, not eyeballed (getBoundingClientRect).
          process.stdout.write(
            `AG-4b fill 1440x${height} ${layout} dock ${dock}: dock top ${d.y}, list bottom ${l.b}, panes bottom ${r.b}\n`,
          );
          expect(d.y - l.b).toBeCloseTo(14, 0);
          expect(d.y - r.b).toBeCloseTo(14, 0);
          // Every pane on screen fills the panes' box to its foot.
          for (const id of await shown(p)) {
            const pr = await rect(p, `.pane[data-id="${id}"]`);
            expect(pr.b).toBeLessThanOrEqual(r.b + 0.5);
          }
          await expectFits(p);
          await shot(p, `fill-1440x${height}-${layout}-dock-${dock}`);
        }
        // Shut it again for the next layout (the dock is a saved pref).
        await p.click('.den-dock [data-act="dock"]');
        // The window resized: the panes follow, and each terminal fits.
        await p.setViewportSize({ width: 1180, height: height - 120 });
        await eventually(async () => {
          const [d, r] = await Promise.all([
            rect(p, "#den-dock"),
            rect(p, "#agr"),
          ]);
          return Math.abs(d.y - 14 - r.b) <= 0.5;
        });
        await expectFits(p);
        await p.context().close();
      }
      await s!.settings({ shell: { dock: null } });
    },
    120_000,
  );

  it("switches Focus (the default), Tabs and Tile from the header, with ⌃⇧1 / ⌃⇧2 / ⌃⇧3 and from ⌘K; the URL says it, and it is saved for the person", async () => {
    if (skip()) return;
    await s!.settings({ agents_layout: null });
    const p = await page(`/agents?open=${all()}`);
    expect(await layoutOf(p)).toBe("focus");
    const seg = p.locator('.ph [role="group"][data-layouts]');
    expect(await seg.locator("button").allTextContents()).toEqual([
      "Focus",
      "Tabs",
      "Tile",
    ]);
    expect(await seg.locator('button[aria-pressed="true"]').textContent()).toBe(
      "Focus",
    );
    expect(
      await seg
        .locator("button")
        .evaluateAll((bs) =>
          bs.map((b) => b.getAttribute("aria-keyshortcuts")),
        ),
    ).toEqual(["Control+Shift+1", "Control+Shift+2", "Control+Shift+3"]);
    expect(
      await seg.locator("button").evaluateAll((bs) => bs.map((b) => b.title)),
    ).toEqual(["Focus (⌃⇧1)", "Tabs (⌃⇧2)", "Tile (⌃⇧3)"]);
    // Focus shows one: the last opened.
    expect(await shown(p)).toEqual([sid.scout]);

    await seg.getByRole("button", { name: "Tile" }).click();
    expect(await layoutOf(p)).toBe("tile");
    expect(urlLayout(p)).toBe("tile");
    await eventually(async () => (await saved()) === "tile");
    expect((await shown(p)).length).toBe(4);
    await termsUp(p, 4);
    await expectFits(p);

    // ⌘2 and Ctrl+2 are the browser's (its tabs): the page leaves them.
    await p.keyboard.press("Meta+2");
    await p.keyboard.press("Control+2");
    expect(await layoutOf(p)).toBe("tile");
    await p.keyboard.press("Control+Shift+Digit2");
    expect(await layoutOf(p)).toBe("tabs");
    expect(urlLayout(p)).toBe("tabs");
    await eventually(async () => (await saved()) === "tabs");
    expect(await shown(p)).toEqual([sid.scout]);
    await expectFits(p);

    // The keys work with a terminal focused too, and the agent never
    // sees them.
    await p.click(`.pane[data-id="${sid.scout}"] .term`);
    const pty = ptyOf("scout");
    const wrote = pty.writes.length;
    await p.keyboard.press("Control+Shift+Digit3");
    expect(await layoutOf(p)).toBe("tile");
    await p.keyboard.press("Control+Shift+Digit1");
    expect(await layoutOf(p)).toBe("focus");
    await eventually(async () => (await saved()) === "focus");
    await new Promise((r) => setTimeout(r, 300));
    expect(pty.writes.slice(wrote).map((b) => b.toString())).toEqual([]);

    // ⌘K: "Layout: Tile".
    await p.click("#den-search");
    await p.fill("#den-pal-q", "layout");
    await p.waitForSelector('#den-pal-list li[role="option"]');
    expect(
      await p
        .locator('#den-pal-list li[role="option"] .den-pal-l')
        .allTextContents(),
    ).toEqual(
      expect.arrayContaining(["Layout: Focus", "Layout: Tabs", "Layout: Tile"]),
    );
    await p.fill("#den-pal-q", "layout: tile");
    await p.keyboard.press("Enter");
    await eventually(async () => (await layoutOf(p)) === "tile");
    await eventually(async () => (await saved()) === "tile");

    // Saved for the person: a page with no &layout= opens in it.
    await p.keyboard.press("Control+Shift+Digit2");
    await eventually(async () => (await saved()) === "tabs");
    await p.goto(`${s!.base}/agents?open=${sid.planner}`);
    await p.waitForSelector("#agl:not([aria-busy]) .agr");
    expect(await layoutOf(p)).toBe("tabs");
    expect(urlLayout(p)).toBe("tabs");
    // A link's &layout= wins for that page, and saves nothing.
    await p.goto(`${s!.base}/agents?open=${sid.planner}&layout=tile`);
    await p.waitForSelector("#agl:not([aria-busy]) .agr");
    expect(await layoutOf(p)).toBe("tile");
    expect(await saved()).toBe("tabs");
    // The hint under the list says how this layout works.
    expect(await p.textContent("#agl-hint")).toContain("up to 4");
    await s!.settings({ agents_layout: null });
    await p.context().close();
  }, 90_000);

  it.each([1440, 1024])(
    "Tile is a grid at %ipx: 1 full, 2 side by side, 3-4 as 2x2, never three columns; each terminal fits",
    async (width) => {
      if (skip()) return;
      const p = await page("/agents?layout=tile", { width });
      const ids = AGENTS.map(([id]) => sid[id]);
      for (let n = 1; n <= 4; n++) {
        await p.click(`.agr[data-id="${ids[n - 1]}"]`);
        await termsUp(p, n);
        const agr = await rect(p, "#agr");
        const boxes = await Promise.all(
          ids.slice(0, n).map((id) => rect(p, `.pane[data-id="${id}"]`)),
        );
        const cols = new Set(boxes.map((b) => Math.round(b.x))).size;
        expect(cols).toBe(n === 1 ? 1 : 2);
        if (n === 1) {
          expect(Math.abs(boxes[0].w - agr.w)).toBeLessThanOrEqual(1);
          expect(Math.abs(boxes[0].h - agr.h)).toBeLessThanOrEqual(1);
        }
        if (n === 2) {
          expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(1);
          expect(Math.abs(boxes[0].h - agr.h)).toBeLessThanOrEqual(1);
        }
        if (n >= 3) {
          expect(boxes[2].y).toBeGreaterThan(boxes[0].y + boxes[0].h);
          expect(Math.abs(boxes[0].w - boxes[2].w)).toBeLessThanOrEqual(1);
          expect(Math.abs(boxes[0].h - boxes[2].h)).toBeLessThanOrEqual(1);
        }
        await expectFits(p);
      }
      await shot(p, `tile-${width}`);
      for (const layout of ["focus", "tabs"]) {
        await p.click(`.ph [data-layouts] button[data-layout="${layout}"]`);
        await termsUp(p, 1);
        await expectFits(p);
        await shot(p, `${layout}-${width}`);
      }
      await p.context().close();
    },
    90_000,
  );

  it("Focus: a click replaces the pane, Shift-click adds one alongside. Tabs: a strip of named tabs (name, then persona · workspace) with a waiting dot", async () => {
    if (skip()) return;
    await s!.settings({ agents_layout: null });
    const p = await page("/agents", { waiting: "builder" });
    await p.click(`.agr[data-id="${sid.planner}"]`);
    await termsUp(p, 1);
    await p.click(`.agr[data-id="${sid.reviewer}"]`);
    await eventually(async () => (await shown(p)).join() === sid.reviewer);
    expect(new URL(p.url()).searchParams.get("open")).toBe(sid.reviewer);
    await p.click(`.agr[data-id="${sid.builder}"]`, { modifiers: ["Shift"] });
    await termsUp(p, 2);
    expect(await shown(p)).toEqual([sid.reviewer, sid.builder]);
    await expectFits(p);
    // The list's row says it waits with its dot as well as its badge.
    expect(
      await p.locator(`.agr[data-id="${sid.builder}"] .den-dot.warn`).count(),
    ).toBe(1);

    await p.keyboard.press("Control+Shift+Digit2");
    await p.click(`.agr[data-id="${sid.scout}"]`);
    await termsUp(p, 1);
    const tabs = p.locator('#agr [role="tablist"] [role="tab"]');
    expect(await tabs.count()).toBe(3);
    const tab = (id: string) => p.locator(`#agr [role="tab"][data-id="${id}"]`);
    expect(await tab(sid.scout).getAttribute("aria-selected")).toBe("true");
    expect(await tab(sid.scout).locator(".tn").textContent()).toBe("scout");
    expect(await tab(sid.scout).locator(".tm").textContent()).toBe(
      "reviewer · south",
    );
    expect(await tab(sid.builder).locator(".den-dot.warn").count()).toBe(1);
    expect(await tab(sid.scout).locator(".den-dot.warn").count()).toBe(0);
    // A tab shows its pane; the others stay attached, out of sight.
    await tab(sid.reviewer).click();
    await eventually(async () => (await shown(p)).join() === sid.reviewer);
    await expectFits(p);
    expect(await tab(sid.reviewer).getAttribute("aria-selected")).toBe("true");
    // Its × closes it (the session keeps running).
    await p
      .locator(`#agr .agtab-w[data-id="${sid.builder}"] [data-act="close"]`)
      .click();
    expect(await tabs.count()).toBe(2);
    await shot(p, "tabs-waiting");
    await p.context().close();
  }, 90_000);

  it("double-click a tab to rename it: saved in the agent's record, shown in the list, the pane's bar and ⌘K; Esc keeps the old name; the id never changes", async () => {
    if (skip()) return;
    const p = await page(
      `/agents?open=${sid.planner},${sid.scout}&layout=tabs`,
    );
    const tab = p.locator(`#agr [role="tab"][data-id="${sid.scout}"]`);
    const wrap = p.locator(`#agr .agtab-w[data-id="${sid.scout}"]`);
    await tab.dblclick();
    const input = wrap.locator("input");
    await input.waitFor();
    expect(await input.inputValue()).toBe("scout");
    await input.fill("Night watch");
    await input.press("Escape");
    expect(await tab.locator(".tn").textContent()).toBe("scout");

    await tab.dblclick();
    await input.fill("  Night watch ");
    await input.press("Enter");
    await eventually(
      async () => (await tab.locator(".tn").textContent()) === "Night watch",
    );
    const rec = JSON.parse(
      fs.readFileSync(path.join(s!.stateDir, "agents", "scout.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(rec).toMatchObject({ id: "scout", displayName: "Night watch" });
    const row = p.locator(`.agr[data-id="${sid.scout}"]`);
    await eventually(async () =>
      ((await row.locator(".nm").textContent()) ?? "").startsWith(
        "Night watch",
      ),
    );
    expect(await row.locator(".nm .id").textContent()).toBe("reviewer · scout");
    expect(
      (await p.textContent(`.pane[data-id="${sid.scout}"] .bar2 b`))?.trim(),
    ).toBe("Night watch");
    // ⌘K names it too.
    await p.click("#den-search");
    await p.fill("#den-pal-q", "night watch");
    await p.waitForSelector('#den-pal-list li[role="option"]');
    expect(
      await p
        .locator('#den-pal-list li[role="option"] .den-pal-l')
        .first()
        .textContent(),
    ).toBe("Agents › south / Night watch");
    await p.keyboard.press("Escape");
    // The input takes no more than a name may be (40).
    await tab.dblclick();
    await input.fill("x".repeat(60));
    expect((await input.inputValue()).length).toBe(40);
    // Cleared: back to its id.
    await input.fill("");
    await input.press("Enter");
    await eventually(
      async () => (await tab.locator(".tn").textContent()) === "scout",
    );
    expect(
      (
        JSON.parse(
          fs.readFileSync(
            path.join(s!.stateDir, "agents", "scout.json"),
            "utf-8",
          ),
        ) as Record<string, unknown>
      ).displayName,
    ).toBeUndefined();
    await p.context().close();
  }, 90_000);

  it.each(["focus", "tabs", "tile"])(
    "at 390px, %s shows as Tabs: one pane under the strip, it fits, no sideways scroll",
    async (layout) => {
      if (skip()) return;
      const p = await page(`/agents?open=${all()}&layout=${layout}`, {
        width: 390,
        height: 844,
      });
      await termsUp(p, 1);
      expect(await layoutOf(p)).toBe("tabs");
      expect(await p.locator('#agr [role="tab"]').count()).toBe(4);
      // The switch still says the person's choice.
      expect(
        await p
          .locator('.ph [data-layouts] button[aria-pressed="true"]')
          .getAttribute("data-layout"),
      ).toBe(layout);
      await expectFits(p);
      const over = await p.evaluate(() => {
        const c = document.getElementById("den-content")!;
        return Math.max(
          document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          c.scrollWidth - c.clientWidth,
        );
      });
      expect(over).toBeLessThanOrEqual(0);
      await shot(p, `${layout}-390`);
      await p.context().close();
    },
    60_000,
  );

  it("0.4.44: the list, the bar and the input all name the tab in front, never ?ws='s project", async () => {
    if (skip()) return;
    // ?ws=north, with a south agent's tab open too: a message once went to
    // the tab in front while the list marked the URL's project's agent.
    const p = await page(
      `/agents?layout=tabs&ws=north&open=${sid.planner},${sid.builder}`,
    );
    await termsUp(p, 1);
    const front = async () => ({
      tab: await p
        .locator('#agr [role="tab"][aria-selected="true"]')
        .getAttribute("data-id"),
      // The list's mark: one row, the tab in front's.
      marked: await p.$$eval('#agl .agr[aria-current="true"]', (rs) =>
        rs.map((r) => (r as HTMLElement).dataset.id),
      ),
      bar: (
        await p
          .locator(`#agr .pane[data-id] .bar2`)
          .filter({ visible: true })
          .innerText()
      ).replace(/\s+/g, " "),
      to: await p
        .locator("#agr .pane .agto")
        .filter({ visible: true })
        .textContent(),
    });
    for (const [id, ws] of [
      ["builder", "south"],
      ["planner", "north"],
      ["builder", "south"],
    ] as const) {
      await p.click(`#agr [role="tab"][data-id="${sid[id]}"]`);
      await eventually(async () => (await front()).tab === sid[id]);
      const f = await front();
      expect(f.marked).toEqual([sid[id]]);
      expect(f.bar).toMatch(new RegExp(`^${id} · ${ws}( · |$)`));
      expect(f.to).toBe(`To ${id} · ${ws}`);
    }
    // A row's click brings its tab to the front, and the mark with it.
    await p.click(`#agl .agr[data-id="${sid.planner}"]`);
    await eventually(async () => (await front()).tab === sid.planner);
    expect((await front()).marked).toEqual([sid.planner]);
    // The input's line has the project's colour, a different one per project.
    const hue = (id: string) =>
      p.$eval(`#agr .pane[data-id="${sid[id]}"] .agto`, (e) =>
        getComputedStyle(e).borderLeftColor,
      );
    expect(await hue("planner")).not.toBe(await hue("builder"));
    await p.context().close();
  }, 60_000);

  // Review shots only (DEN_AGENTS_SHOTS): the tab in front, each in turn,
  // at 1440 and 390 px, light and dark, in en and ja.
  it("0.4.44: review shots of the tab in front (DEN_AGENTS_SHOTS only)", async () => {
    if (skip() || !SHOTS) return;
    try {
      for (const lang of ["en", "ja"] as const) {
        expect(await s!.settings({ language: lang === "en" ? null : lang })).toBe(200);
        for (const scheme of ["light", "dark"] as const)
          for (const width of [1440, 390]) {
            const ctx = await browser!.newContext({
              viewport: { width, height: width > 400 ? 900 : 844 },
              colorScheme: scheme,
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
            await p.goto(
              `${s!.base}/agents?layout=tabs&ws=north&open=${sid.planner},${sid.builder}`,
            );
            await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
            await termsUp(p, 1);
            for (const id of ["planner", "builder"]) {
              await p.click(`#agr [role="tab"][data-id="${sid[id]}"]`);
              await p.waitForSelector(
                `#agr [role="tab"][data-id="${sid[id]}"][aria-selected="true"]`,
              );
              await shot(p, `front-${id}-${width}-${scheme}-${lang}`);
              if (width < 400) {
                // Narrow: the tabs, the bar and the To line, scrolled into sight.
                await p.evaluate(() => {
                  const to = [...document.querySelectorAll("#agr .pane .agto")].find(
                    (x) => (x as HTMLElement).offsetWidth > 0,
                  );
                  to?.scrollIntoView({ block: "end" });
                });
                await shot(p, `front-${id}-${width}-${scheme}-${lang}-to`);
                await p.evaluate(() => window.scrollTo(0, 0));
              }
            }
            await ctx.close();
          }
      }
    } finally {
      await s!.settings({ language: null });
    }
  }, 240_000);

  it("0.4.44: a long tab title keeps the agent's name whole; its project goes first", async () => {
    if (skip()) return;
    const p = await page(`/agents?layout=tabs&open=${sid.planner}`, {
      width: 900,
    });
    await termsUp(p, 1);
    const cut = await p.$eval(`#agr [role="tab"][data-id="${sid.planner}"]`, (tab) => {
      const tn = tab.querySelector(".tn") as HTMLElement;
      const tm = tab.querySelector(".tm") as HTMLElement;
      tm.textContent = "a-very-long-persona-name · a-very-long-project-name-indeed";
      return {
        name: tn.scrollWidth <= tn.clientWidth,
        meta: tm.scrollWidth > tm.clientWidth,
      };
    });
    expect(cut).toEqual({ name: true, meta: true });
    await p.context().close();
  }, 60_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
