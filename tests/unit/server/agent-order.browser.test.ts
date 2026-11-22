/**
 * Issue 96: the Agents page puts a project's agents in the person's
 * order, in Chromium and WebKit. A stopped row moves inside the Stopped
 * group, among its project's; the server stores the order in the
 * person's user config, so a reload and a Den restart keep it, and the
 * Projects page's agents follow it.
 *
 *   1. Issue 773: a running agent is in a band, in the rule's order (see
 *      below), never the saved one.
 *   2. Issue 226, at 375 px: the Stopped group offers Reorder too, with
 *      44 px Up and Down on each stopped agent that can move; a stopped
 *      agent moves, and the order holds through a reload.
 *
 * Issue 773 (approved mock v3, its rules table): running agents are in
 * the four bands, and a band's order is the rule's: A to Z in Working and
 * Idle, "same input, same order every time". A saved order never moves a
 * running row, which has no grip, no Alt+arrow move and no Reorder. The
 * Stopped group keeps the person's order (2).
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

/** North's running agents as the list shows them (the bands), by name. */
async function order(p: Page): Promise<string[]> {
  const ids = await p.$$eval(
    '#agl .agband button.agr[data-kind="agent"]',
    (bs) => bs.map((b) => (b as HTMLElement).dataset.id ?? ""),
  );
  const by = Object.fromEntries(Object.entries(sid).map(([k, v]) => [v, k]));
  return ids.map((x) => by[x] ?? x);
}

/** Waits until north's running agents show `want` (a poll may lag). */
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

describe.each(ENGINES)(
  "Issue 96 in %s: a project's agents in your order",
  (engine) => {
    const skip = () => !browsers[engine] || !s;

    it("issue 773 (mock v3): a saved order never moves a running row; A to Z in Idle, no grip, no Alt+arrow move, no band Reorder", async () => {
      if (skip()) return;
      // The person once ordered north cy, ada, bo (issue 96).
      const u = userYml();
      u.agents = { ...(u.agents ?? {}), order: { north: ["cy", "ada", "bo"] } };
      fs.writeFileSync(userFile(), stringifyYaml(u));
      const p = await open(engine);
      // The Idle band's own order, A to Z, whatever was saved.
      await until(p, ["ada", "bo", "cy"]);
      await p.reload();
      await p.locator(row(sid.cy)).waitFor();
      await until(p, ["ada", "bo", "cy"]);
      // No grip on a running row.
      expect(await p.locator("#agl .agband .agrip").count()).toBe(0);
      // Alt+↑ on a running row asks nothing of the server and moves nothing.
      let posts = 0;
      p.on("request", (r) => {
        if (r.method() === "POST" && /\/order$/.test(new URL(r.url()).pathname))
          posts++;
      });
      await p.focus(row(sid.cy));
      await p.keyboard.press("Alt+ArrowUp");
      await p.waitForTimeout(400);
      expect(posts).toBe(0);
      await until(p, ["ada", "bo", "cy"]);
      await p.context().close();
      // A phone: no Reorder in a band (the Stopped group keeps its own).
      const m = await open(engine, 375, true);
      await until(m, ["ada", "bo", "cy"]);
      expect(await m.locator('#agl .agband [data-act="reorder"]').count()).toBe(
        0,
      );
      expect(
        await m
          .locator('#agl details[data-stopped] [data-act="reorder"]')
          .count(),
      ).toBe(1);
      resetOrder();
      await m.context().close();
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
