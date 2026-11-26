/**
 * Issue 96: the Agents page puts a project's agents in the person's
 * order, in Chromium and WebKit. A row moves inside its group (its
 * project, running or Stopped); the server stores the order in the
 * person's user config, so a reload and a Den restart keep it, and the
 * Projects page's agents follow it.
 *
 *   1. A pointer drag by the grip onto a row's upper half puts it before
 *      that row; it holds through a reload and a Den restart; the
 *      Projects page lists the same order.
 *   2. Alt+↑ on a focused row moves it up one; focus stays on it, and a
 *      polite live region says "<name> moved to position N of M". The
 *      grip has an accessible name.
 *   3. At 375 px: a touch drag (pointer events) moves a row; Alt+↓ moves
 *      one and is announced; Reorder shows 44 px Up and Down; nothing
 *      scrolls sideways.
 *   4. Issue 226, at 375 px: the Stopped group offers Reorder too, with
 *      44 px Up and Down on each stopped agent that can move; a stopped
 *      agent moves, and the order holds through a reload.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY: nothing really runs. DEN_PW_WS connects to a running
 * Playwright server; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names
 * only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
const sid: Record<string, string> = {};
const browsers: Partial<Record<Engine, Browser>> = {};
type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
  host = await connectHost(sessionPaths(s.stateDir).socket);
  await run("ada", "2026-11-15T01:00:00.000Z");
  await run("bo", "2026-11-15T02:00:00.000Z");
  await run("cy", "2026-11-15T03:00:00.000Z");
  // Issue 226: two stopped agents in north (their sessions are gone).
  for (const [id, at] of [
    ["dee", "2026-11-15T04:00:00.000Z"],
    ["eve", "2026-11-15T05:00:00.000Z"],
  ])
    s!.seed({
      id,
      persona: "planner",
      workspace: "north",
      startedAt: at,
      stoppedAt: at,
    });
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [host, s],
  });
});

/** A running agent `id` in north, as `agents start` leaves one. */
async function run(id: string, startedAt: string): Promise<void> {
  const info = await host!.start({
    name: `acme-north:${id}`,
    cwd: s!.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  sid[id] = info.ref.id;
  s!.seed({
    id,
    persona: "planner",
    workspace: "north",
    session: { backend: "den-pty", id: info.ref.id },
    sessionName: `acme-north:${id}`,
    startedAt,
  });
}

const userFile = () => path.join(s!.tmp, "dist", "config", "local", "user.yml");
const userYml = () =>
  (parseYaml(fs.readFileSync(userFile(), "utf-8")) ?? {}) as {
    agents?: { order?: Record<string, string[]> };
  };

/** No saved order: by start time again. */
function resetOrder(): void {
  const u = userYml();
  delete u.agents?.order;
  fs.writeFileSync(userFile(), stringifyYaml(u));
}

async function open(
  engine: Engine,
  width = 1280,
  touch = false,
): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
    colorScheme: "light",
    ...(touch ? { hasTouch: true } : {}),
  });
  await ctx.addInitScript(() => {
    // No What's new over the list.
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
      localStorage.removeItem("den-agents-open");
    } catch {
      /* none */
    }
  });
  const p = await ctx.newPage();
  await signInPage(p, s!.stateDir, s!.base, "/agents?ws=north");
  await p.locator(row(sid.cy)).waitFor({ timeout: 20_000 });
  return p;
}

const row = (id: string) => `#agl button.agr[data-id="${id}"]`;

async function order(p: Page): Promise<string[]> {
  const ids = await p.$$eval(
    '#agl div[data-band] button.agr[data-kind="agent"]',
    (bs) => bs.map((b) => (b as HTMLElement).dataset.id ?? ""),
  );
  const by = Object.fromEntries(Object.entries(sid).map(([k, v]) => [v, k]));
  return ids.map((x) => by[x] ?? x);
}

async function mouseDrag(p: Page, from: string, to: string): Promise<void> {
  await p.hover(row(from));
  const g = (await p.locator(`${row(from)} [data-grip]`).boundingBox())!;
  const t = (await p.locator(row(to)).boundingBox())!;
  await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await p.mouse.down();
  await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + 8, { steps: 2 });
  await p.mouse.move(t.x + 40, t.y + t.height / 4, { steps: 6 });
  await p.mouse.up();
}

async function until(p: Page, want: string[]): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (JSON.stringify(await order(p)) === JSON.stringify(want)) return;
    await p.waitForTimeout(100);
  }
  expect(await order(p)).toEqual(want);
}

/**
 * `act`, a move, to its end: the server has answered its POST (it writes
 * the person's user config first), and the page has shown the list from
 * the server again and announced the move (then focus is back on a moved
 * row). A slow save's working pop-up holds the page until then.
 *
 * The list shows a move before its save, so a test that checked only the
 * list could end with the save in flight, to land in the next test's
 * reset order (issue 452).
 */
async function moved(p: Page, act: () => Promise<unknown>): Promise<void> {
  // Cleared, so this move's announcement is waited for, not the last one.
  await p.evaluate(() => {
    const el = document.querySelector("#ag-order-live");
    if (el) el.textContent = "";
  });
  const answer = p.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /^\/api\/workspaces\/[^/]+\/agents\/[^/]+\/order$/.test(
        new URL(r.url()).pathname,
      ),
  );
  await act();
  expect((await answer).status()).toBe(200);
  await p.waitForFunction(() =>
    / moved to position \d+ of \d+/.test(
      document.querySelector("#ag-order-live")?.textContent ?? "",
    ),
  );
}

/** A touch drag: pointer events with pointerType "touch", as a finger sends. */
async function touchDrag(p: Page, from: string, to: string): Promise<void> {
  await p.evaluate(
    ([g, r]) => {
      const el = document.querySelector(g) as HTMLElement;
      const target = document.querySelector(r) as HTMLElement;
      const a = el.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      const at = (type: string, x: number, y: number) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
          }),
        );
      const x0 = a.left + a.width / 2;
      const y0 = a.top + a.height / 2;
      at("pointerdown", x0, y0);
      at("pointermove", x0, y0 - 10);
      at("pointermove", b.left + 40, b.top + b.height / 4);
      at("pointerup", b.left + 40, b.top + b.height / 4);
    },
    [`${row(from)} [data-grip]`, row(to)],
  );
}

describe.each(ENGINES)(
  "Issue 96 in %s: a project's agents in your order",
  (engine) => {
    const skip = () => !browsers[engine] || !s;

    it("issue 773 + issue 96: inside a band your drag order holds; Alt+↑ moves one; a reload keeps it", async () => {
      if (skip()) return;
      resetOrder();
      const p = await open(engine);
      await until(p, ["ada", "bo", "cy"]);
      expect(await p.locator("#agl div[data-band] [data-grip]").count()).toBe(3);
      expect(
        await p.locator(`${row(sid.cy)} [data-grip]`).getAttribute("aria-label"),
      ).toBeTruthy();
      await moved(p, () => mouseDrag(p, sid.cy, sid.ada));
      await until(p, ["cy", "ada", "bo"]);
      const north = userYml().agents?.order?.north ?? [];
      expect(north.indexOf("cy")).toBeLessThan(north.indexOf("ada"));
      await p.locator(row(sid.bo)).focus();
      await moved(p, () => p.keyboard.press("Alt+ArrowUp"));
      await until(p, ["cy", "bo", "ada"]);
      expect(
        await p.evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset.id,
        ),
      ).toBe(sid.bo);
      expect(
        await p.$$eval("#agl div[data-band]", (bs) =>
          bs.map((b) => (b as HTMLElement).dataset.band),
        ),
      ).toEqual(["idle"]);
      await p.reload();
      await p.locator(row(sid.cy)).waitFor({ timeout: 20_000 });
      await until(p, ["cy", "bo", "ada"]);
      resetOrder();
      await p.context().close();
    }, 60_000);

    it("issue 96: a Den restart keeps your order; the Projects page follows", async () => {
      if (skip()) return;
      resetOrder();
      const p = await open(engine);
      await until(p, ["ada", "bo", "cy"]);
      await moved(p, () => mouseDrag(p, sid.cy, sid.ada));
      await until(p, ["cy", "ada", "bo"]);
      expect(await p.locator("#agl [data-drop]").count()).toBe(0);
      // Stored in the person's user config, by agent id.
      // (Issue 226's stopped dee and eve are saved in it too.)
      expect(
        userYml().agents?.order?.north?.filter((x) => sid[x] !== undefined),
      ).toEqual(["cy", "ada", "bo"]);
      // A Den restart reads it again.
      await s!.webDown();
      await s!.webUp();
      await signInPage(p, s!.stateDir, s!.base, "/agents?ws=north");
      await p.locator(row(sid.cy)).waitFor({ timeout: 20_000 });
      await until(p, ["cy", "ada", "bo"]);
      // The Projects page's agents follow the same order.
      await signInPage(p, s!.stateDir, s!.base, "/?ws=north");
      const projectRows =
        '#agents-section[data-ws="north"] #agent-table tr[data-agent]';
      await p.waitForSelector(projectRows, { timeout: 20_000 });
      // (Its running ones; issue 226's stopped dee and eve are listed too.)
      expect(
        (
          await p.$$eval(projectRows, (rs) =>
            rs.map((r) => (r as HTMLElement).dataset.agent ?? ""),
          )
        ).filter((x) => sid[x] !== undefined),
      ).toEqual(["cy", "ada", "bo"]);
      resetOrder();
      await p.context().close();
    }, 90_000);

    it("issue 96: Alt+↑ moves the focused row; the live region says where; the grip is named; no working pop-up; the first can't go up", async () => {
      if (skip()) return;
      resetOrder();
      const p = await open(engine);
      await until(p, ["ada", "bo", "cy"]);
      // Named for its agent (its name, else its persona).
      const grip = p.locator(`${row(sid.cy)} [data-grip]`);
      expect(await grip.getAttribute("aria-label")).toBe(
        await p.evaluate(() =>
          (
            window as unknown as {
              denShell: { t: (k: string, v: object) => string };
            }
          ).denShell.t("ag.ord.gripOne", { id: "planner" }),
        ),
      );
      expect(await grip.getAttribute("role")).toBe("img");
      await p.locator(row(sid.cy)).focus();
      await moved(p, () => p.keyboard.press("Alt+ArrowUp"));
      await until(p, ["ada", "cy", "bo"]);
      expect(await p.textContent("#ag-order-live")).toMatch(
        /planner moved to position 2 of 3/,
      );
      expect(
        await p.evaluate(() => document.activeElement?.getAttribute("data-id")),
      ).toBe(sid.cy);
      expect(await p.getAttribute("#ag-order-live", "aria-live")).toBe(
        "polite",
      );
      // No working pop-up for a quick move.
      expect(await p.locator("den-busy[open]").count()).toBe(0);
      let posts = 0;
      p.on("request", (r) => {
        if (r.method() === "POST" && /\/order$/.test(r.url())) posts++;
      });
      await p.locator(row(sid.ada)).focus();
      await p.keyboard.press("Alt+ArrowUp");
      await p.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => r(null))),
      );
      expect(posts).toBe(0);
      expect(await order(p)).toEqual(["ada", "cy", "bo"]);
      resetOrder();
      await p.context().close();
    }, 60_000);

    it("issue 1054: a move's save holds its row (dots, aria-busy), no pop-up; a refusal puts it back and says why inline", async () => {
      if (skip()) return;
      resetOrder();
      const p = await open(engine);
      expect(await order(p)).toEqual(["ada", "bo", "cy"]);
      // The save is held here, then refused: no wait judged by the clock.
      let release: () => void = () => {};
      const go = new Promise<void>((r) => (release = r));
      await p.route(
        (u) =>
          /\/api\/workspaces\/[^/]+\/agents\/[^/]+\/order$/.test(u.pathname),
        async (r) => {
          if (r.request().method() !== "POST") return r.fallback();
          await go;
          await r.fulfill({
            status: 409,
            contentType: "application/json",
            // A made-up refusal, so the line is known to be the server's.
            body: JSON.stringify({ error: "order-refused-1054" }),
          });
        },
      );
      await p.locator(row(sid.cy)).focus();
      await p.keyboard.press("Alt+ArrowUp");
      try {
        await p.locator(`${row(sid.cy)}[aria-busy="true"]`).waitFor();
        // The kit's dots at the row's end: three dots, hidden from a
        // screen reader (aria-busy says it). aria-busy is set at once; the
        // dots come when the kit's module has loaded.
        await p.waitForFunction(
          (sel) =>
            document
              .querySelector(sel)
              ?.lastElementChild?.getAttribute("aria-hidden") === "true",
          row(sid.cy),
        );
        expect(
          await p.locator(row(sid.cy)).evaluate((el) => {
            const d = el.lastElementChild;
            return [
              d?.getAttribute("aria-hidden"),
              d?.querySelectorAll("i").length,
            ];
          }),
        ).toEqual(["true", 3]);
        expect(await p.locator("den-busy dialog[open]").count()).toBe(0);
      } finally {
        release();
      }
      const err = p.locator("#ag-order-err");
      await err.waitFor({ state: "visible" });
      expect(await err.getAttribute("role")).toBe("alert");
      expect(await err.textContent()).toContain("order-refused-1054");
      await until(p, ["ada", "bo", "cy"]);
      expect(await p.locator(`${row(sid.cy)}[aria-busy]`).count()).toBe(0);
      expect(await p.locator("den-busy dialog[open]").count()).toBe(0);
      await p.context().close();
    }, 60_000);

    it("issue 96, at 375: a touch drag moves a row; Alt+↓ is announced; Idle's Reorder gives 44 px Up and Down; no sideways scroll", async () => {
      if (skip()) return;
      resetOrder();
      const p = await open(engine, 375, true);
      await until(p, ["ada", "bo", "cy"]);
      await moved(p, () => touchDrag(p, sid.bo, sid.ada));
      await until(p, ["bo", "ada", "cy"]);
      await p.locator(row(sid.bo)).focus();
      await moved(p, () => p.keyboard.press("Alt+ArrowDown"));
      await until(p, ["ada", "bo", "cy"]);
      const band = '#agl [data-band="idle"]';
      const reorder = p.locator(`${band} [data-act="reorder"]`);
      await reorder.click();
      expect(await reorder.getAttribute("aria-pressed")).toBe("true");
      const up = p.locator(`${band} [data-agent="cy"] [data-act="ord-up"]`);
      const down = p.locator(`${band} [data-agent="cy"] [data-act="ord-down"]`);
      await up.waitFor();
      for (const b of [up, down]) {
        const box = (await b.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(await down.getAttribute("aria-disabled")).toBe("true");
      await moved(p, () => up.click());
      await until(p, ["ada", "cy", "bo"]);
      await reorder.click();
      expect(await p.locator(`${band} [data-act="ord-up"]`).count()).toBe(0);
      expect(
        await p.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      resetOrder();
      await p.context().close();
    }, 60_000);

    it("issue 226, at 375: a stopped agent gets Reorder's Up and Down too, and its move holds", async () => {
      if (skip()) return;
      resetOrder();
      const p = await open(engine, 375, true);
      const stopped = "#agl details[data-stopped]";
      const names = () =>
        p.$$eval(`${stopped} .agst[data-agent]`, (rs) =>
          rs.map((r) => (r as HTMLElement).dataset.agent ?? ""),
        );
      const untilStopped = async (want: string[]) => {
        for (let i = 0; i < 60; i++) {
          if (JSON.stringify(await names()) === JSON.stringify(want)) return;
          await p.waitForTimeout(100);
        }
        expect(await names()).toEqual(want);
      };
      // Open, whatever a person left it as.
      await p.evaluate((sel) => {
        const d = document.querySelector(sel) as HTMLDetailsElement | null;
        if (d) d.open = true;
      }, stopped);
      await untilStopped(["dee", "eve"]);
      const reorder = p.locator(`${stopped} [data-act="reorder"]`);
      await reorder.click();
      expect(await reorder.getAttribute("aria-pressed")).toBe("true");
      const up = p.locator(
        `${stopped} .agord[data-agent="eve"] [data-act="ord-up"]`,
      );
      const down = p.locator(
        `${stopped} .agord[data-agent="eve"] [data-act="ord-down"]`,
      );
      await up.waitFor();
      for (const b of [up, down]) {
        const box = (await b.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(await down.getAttribute("aria-disabled")).toBe("true");
      await moved(p, () => up.click());
      await untilStopped(["eve", "dee"]);
      // Its save has been answered, so the file has it.
      const north = userYml().agents?.order?.north ?? [];
      expect(north).toContain("eve");
      expect(north.indexOf("eve")).toBeLessThan(north.indexOf("dee"));
      // The running ones keep theirs.
      expect(await order(p)).toEqual(["ada", "bo", "cy"]);
      await reorder.click();
      expect(await p.locator(`${stopped} .agord`).count()).toBe(0);
      expect(
        await p.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await p.reload();
      await p.locator(row(sid.cy)).waitFor({ timeout: 20_000 });
      await p.evaluate((sel) => {
        const d = document.querySelector(sel) as HTMLDetailsElement | null;
        if (d) d.open = true;
      }, stopped);
      await untilStopped(["eve", "dee"]);
      await p.context().close();
    }, 60_000);
  },
);
