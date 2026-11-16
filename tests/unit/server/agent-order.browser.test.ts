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
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY: nothing really runs. DEN_PW_WS connects to a running
 * Playwright server; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names
 * only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
const sid: Record<string, string> = {};
const browsers: Partial<Record<Engine, Browser>> = {};
type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
/** The mid-drag screenshot (Chromium, 1280, light). */
const SHOT =
  process.env.DEN_ORDER_SHOT ??
  path.join(
    os.homedir(),
    "Library",
    "Logs",
    "den-probe",
    "drag-1280-light.png",
  );

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const ws = process.env.DEN_PW_WS;
    for (const e of ENGINES)
      browsers[e] = ws
        ? await pw[e].connect(ws, { exposeNetwork: "<loopback>" })
        : await pw[e].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
  host = await connectHost(sessionPaths(s.stateDir).socket);
  await run("ada", "2026-11-15T01:00:00.000Z");
  await run("bo", "2026-11-15T02:00:00.000Z");
  await run("cy", "2026-11-15T03:00:00.000Z");
}, 120_000);

afterAll(async () => {
  for (const b of Object.values(browsers)) await b?.close();
  host?.close();
  await s?.stop();
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
  await p.goto(signInUrl(s!.stateDir, s!.base, "/agents?ws=north"));
  await p.locator(row(sid.cy)).waitFor({ timeout: 20_000 });
  return p;
}

const row = (id: string) =>
  `#agl .wsg[data-ws="north"] button.agr[data-id="${id}"]`;
const grip = (id: string) => `${row(id)} .agrip`;

/** North's agents as the list shows them, by name. */
async function order(p: Page): Promise<string[]> {
  const ids = await p.$$eval(
    '#agl .wsg[data-ws="north"] button.agr[data-kind="agent"]',
    (bs) => bs.map((b) => (b as HTMLElement).dataset.id ?? ""),
  );
  const by = Object.fromEntries(Object.entries(sid).map(([k, v]) => [v, k]));
  return ids.map((x) => by[x] ?? x);
}

const until = async (p: Page, want: string[]) => {
  for (let i = 0; i < 60; i++) {
    if (JSON.stringify(await order(p)) === JSON.stringify(want)) return;
    await p.waitForTimeout(100);
  }
  expect(await order(p)).toEqual(want);
};

/** A drag by the grip of `from` with the mouse, to the top quarter of `to`. */
async function mouseDrag(p: Page, from: string, to: string, shot?: string) {
  const g = (await p.locator(grip(from)).boundingBox())!;
  const t = (await p.locator(row(to)).boundingBox())!;
  await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await p.mouse.down();
  const x = t.x + 40;
  const y = t.y + t.height / 4;
  await p.mouse.move(x, (g.y + y) / 2, { steps: 4 });
  await p.mouse.move(x, y, { steps: 4 });
  await p.locator(`${row(to)}[data-drop="before"]`).waitFor();
  if (shot) {
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await p.screenshot({ path: shot });
  }
  await p.mouse.up();
}

/** A touch drag: pointer events with pointerType "touch", as a finger sends. */
async function touchDrag(p: Page, from: string, to: string) {
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
    [grip(from), row(to)],
  );
}

describe.each(ENGINES)(
  "Issue 96 in %s: a project's agents in your order",
  (engine) => {
    const skip = () => !browsers[engine] || !s;

    it("a drag by the grip reorders; a reload and a Den restart keep it; the Projects page follows", async () => {
      if (skip()) return;
      resetOrder();
      const p = await open(engine);
      expect(await order(p)).toEqual(["ada", "bo", "cy"]);
      await mouseDrag(
        p,
        sid.cy,
        sid.ada,
        engine === "chromium" ? SHOT : undefined,
      );
      await until(p, ["cy", "ada", "bo"]);
      expect(await p.locator("#agl [data-drop], #agl .lift").count()).toBe(0);
      // Stored in the person's user config, by agent id.
      for (let i = 0; i < 50 && !userYml().agents?.order?.north; i++)
        await p.waitForTimeout(100);
      expect(userYml().agents?.order?.north).toEqual(["cy", "ada", "bo"]);
      await p.reload();
      await p.locator(row(sid.cy)).waitFor();
      expect(await order(p)).toEqual(["cy", "ada", "bo"]);
      // A Den restart reads it again.
      await s!.webDown();
      await s!.webUp();
      await p.goto(signInUrl(s!.stateDir, s!.base, "/agents?ws=north"));
      await p.locator(row(sid.cy)).waitFor({ timeout: 20_000 });
      expect(await order(p)).toEqual(["cy", "ada", "bo"]);
      // The Projects page's agents follow the same order.
      await p.goto(signInUrl(s!.stateDir, s!.base, "/?ws=north"));
      await p
        .locator('#agents-section[data-ws="north"] #agent-table tr.agent')
        .first()
        .waitFor({ timeout: 20_000 });
      expect(
        await p.$$eval(
          '#agents-section[data-ws="north"] #agent-table tr.agent',
          (rs) => rs.map((r) => (r as HTMLElement).dataset.agent),
        ),
      ).toEqual(["cy", "ada", "bo"]);
      await p.context().close();
    }, 90_000);

    it("Alt+↑ moves the focused row up one; focus stays; the live region says where; the grip is named", async () => {
      if (skip()) return;
      resetOrder();
      const p = await open(engine);
      expect(await order(p)).toEqual(["ada", "bo", "cy"]);
      // Named for its agent (its name, else its persona).
      expect(await p.getAttribute(grip(sid.cy), "aria-label")).toBe(
        "Drag to move planner",
      );
      expect(await p.getAttribute(grip(sid.cy), "role")).toBe("img");
      await p.locator(row(sid.cy)).focus();
      await p.keyboard.press("Alt+ArrowUp");
      await until(p, ["ada", "cy", "bo"]);
      expect(
        await p.evaluate(() => document.activeElement?.getAttribute("data-id")),
      ).toBe(sid.cy);
      await p.waitForFunction(() =>
        /planner moved to position 2 of 3/.test(
          document.querySelector("#ag-order-live")?.textContent ?? "",
        ),
      );
      expect(await p.getAttribute("#ag-order-live", "aria-live")).toBe(
        "polite",
      );
      // No working pop-up for a quick move.
      expect(await p.locator("den-busy[open], .bz-b:visible").count()).toBe(0);
      // The first can't go up: nothing changes.
      await p.locator(row(sid.ada)).focus();
      await p.keyboard.press("Alt+ArrowUp");
      await p.waitForTimeout(300);
      expect(await order(p)).toEqual(["ada", "cy", "bo"]);
      await p.context().close();
    }, 60_000);

    it("at 375: a touch drag moves a row; Alt+↓ is announced; Reorder's Up and Down are 44 px; no sideways scroll", async () => {
      if (skip()) return;
      resetOrder();
      const p = await open(engine, 375, true);
      expect(await order(p)).toEqual(["ada", "bo", "cy"]);
      await touchDrag(p, sid.bo, sid.ada);
      await until(p, ["bo", "ada", "cy"]);
      await p.locator(row(sid.bo)).focus();
      await p.keyboard.press("Alt+ArrowDown");
      await until(p, ["ada", "bo", "cy"]);
      await p.waitForFunction(() =>
        /planner moved to position 2 of 3/.test(
          document.querySelector("#ag-order-live")?.textContent ?? "",
        ),
      );
      await p
        .locator('#agl .wsg[data-ws="north"] [data-act="reorder"]')
        .click();
      const up = p.locator('#agl .agord[data-agent="cy"] [data-act="ord-up"]');
      await up.waitFor();
      const box = (await up.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await up.click();
      await until(p, ["ada", "cy", "bo"]);
      await p
        .locator('#agl .wsg[data-ws="north"] [data-act="reorder"]')
        .click();
      expect(await p.locator("#agl .agord").count()).toBe(0);
      expect(
        await p.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await p.context().close();
    }, 60_000);
  },
);
