/**
 * D79 (den#96): the Agents page puts a project's agents in the person's
 * order. A row moves inside its group (its project, running or Stopped);
 * the server stores the order, so a reload keeps it.
 *
 *   1. Alt+↑ on a focused row moves it up one; focus stays on it, and the
 *      live line says "<name> moved to position N of M".
 *   2. A drag onto the upper half of a row puts it before that row.
 *   3. The pane's ⋯ has Move to top (and not Move up for the first).
 *   4. A reload keeps the order.
 *   5. On a phone: no grip; Reorder in the project's header shows Up and
 *      Down per row (44 px), Up moves it, Done ends it.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY: nothing really runs. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
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
let browser: Browser | null = null;
let host: HostClient | null = null;
const sid: Record<string, string> = {};

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
  host = await connectHost(sessionPaths(s.stateDir).socket);
  await run("ada", "2026-11-15T01:00:00.000Z");
  await run("bo", "2026-11-15T02:00:00.000Z");
  await run("cy", "2026-11-15T03:00:00.000Z");
}, 90_000);

afterAll(async () => {
  await browser?.close();
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

async function open(width = 1440): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
    try {
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
  for (let i = 0; i < 50; i++) {
    if (JSON.stringify(await order(p)) === JSON.stringify(want)) return;
    await p.waitForTimeout(100);
  }
  expect(await order(p)).toEqual(want);
};

describe("D79: a project's agents in your own order", () => {
  it("Alt+↑ moves the focused row up one; focus stays; the live line says where", async () => {
    if (!browser) return;
    const p = await open();
    expect(await order(p)).toEqual(["ada", "bo", "cy"]);
    await p.locator(row(sid.cy)).focus();
    await p.keyboard.press("Alt+ArrowUp");
    await until(p, ["ada", "cy", "bo"]);
    expect(
      await p.evaluate(() => document.activeElement?.getAttribute("data-id")),
    ).toBe(sid.cy);
    await p.waitForFunction(() =>
      /moved to position 2 of 3/.test(
        document.querySelector("#ag-order-live")?.textContent ?? "",
      ),
    );
    expect(await p.getAttribute("#ag-order-live", "aria-live")).toBe("polite");
    // The first can't go up: nothing is sent.
    await p.locator(row(sid.ada)).focus();
    await p.keyboard.press("Alt+ArrowUp");
    await p.waitForTimeout(300);
    expect(await order(p)).toEqual(["ada", "cy", "bo"]);
    await p.context().close();
  }, 60_000);

  it("a drag onto a row's upper half puts it before that row, and a reload keeps it", async () => {
    if (!browser) return;
    const p = await open();
    await p.locator(row(sid.bo)).hover();
    expect(await p.locator(`${row(sid.bo)} .agrip`).isVisible()).toBe(true);
    await p
      .locator(row(sid.bo))
      .dragTo(p.locator(row(sid.ada)), { targetPosition: { x: 40, y: 3 } });
    await until(p, ["bo", "ada", "cy"]);
    expect(await p.locator("#agl [data-drop]").count()).toBe(0);
    await p.reload();
    await p.locator(row(sid.cy)).waitFor();
    expect(await order(p)).toEqual(["bo", "ada", "cy"]);
    await p.context().close();
  }, 60_000);

  it("the pane's ⋯: Move to top for the last; no Move up for the first", async () => {
    if (!browser) return;
    const p = await open();
    await p.locator(row(sid.cy)).click();
    const more = p.locator('.pane:not([hidden]) [data-act="more"]');
    await more.click();
    await p.getByRole("menuitem", { name: "Move to top" }).click();
    await until(p, ["cy", "bo", "ada"]);
    await more.click();
    expect(await p.getByRole("menuitem", { name: "Move up" }).count()).toBe(0);
    expect(await p.getByRole("menuitem", { name: "Move down" }).count()).toBe(
      1,
    );
    await p.keyboard.press("Escape");
    await p.context().close();
  }, 60_000);

  it("on a phone: no grip; Reorder shows 44 px Up and Down; Up moves it; Done ends it", async () => {
    if (!browser) return;
    const p = await open(390);
    expect(await p.locator("#agl .agrip").count()).toBe(0);
    const reorder = p.locator(
      '#agl .wsg[data-ws="north"] [data-act="reorder"]',
    );
    await reorder.click();
    const last = p.locator(`#agl .agord[data-agent="ada"]`);
    const up = last.locator('[data-act="ord-up"]');
    await up.waitFor();
    const box = await up.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(
      await p
        .locator(`#agl .agord[data-agent="cy"] [data-act="ord-up"]`)
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await up.click();
    await until(p, ["cy", "ada", "bo"]);
    // Focus stays on that row's Up.
    expect(
      await p.evaluate(
        () =>
          (document.activeElement?.closest(".agord") as HTMLElement | null)
            ?.dataset.agent,
      ),
    ).toBe("ada");
    await p.locator('#agl .wsg[data-ws="north"] [data-act="reorder"]').click();
    expect(await p.locator("#agl .agord").count()).toBe(0);
    await p.context().close();
  }, 60_000);
});
