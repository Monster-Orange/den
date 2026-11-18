/**
 * MODE-5 (0.4.46): in a browser, Settings changes what only the command
 * line could: Local environment and Terminal tabs are switches, Log pane
 * lines and the six reconnect and restart-guard limits are numbers. Each
 * change is saved (POST /api/settings) and shows after a reload.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

jest.setTimeout(60_000);

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    // DEN_HELPERS_BROWSER=webkit runs it there; DEN_PW_WS connects to a
    // Playwright server instead of launching one here.
    const pw = await import("playwright");
    const engine =
      process.env.DEN_HELPERS_BROWSER === "webkit" ? "webkit" : "chromium";
    const ws = process.env.DEN_PW_WS;
    browser = ws
      ? await pw[engine].connect(ws, { exposeNetwork: "<loopback>" })
      : await pw[engine].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
});

const skip = () => !browser;

async function settings(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings#cli"));
  await p.waitForSelector('[data-focus-key="cli-cli_tabs"]');
  return p;
}

/**
 * Settings' category `cat` on the same page. Every category is drawn, so
 * the row is there before the hash's redraw: wait for that redraw (a row
 * marked before it is gone), or the next step types into an input it is
 * about to replace (issue 424).
 */
async function show(p: Page, cat: string, first: string) {
  const sel = `[data-focus-key="${key(first)}"]`;
  await p.evaluate(
    ([c, q]) => {
      document.querySelector(q)?.setAttribute("data-before-hash", "");
      location.hash = c;
    },
    [cat, sel] as const,
  );
  await p.waitForSelector(`${sel}:not([data-before-hash])`);
}

/** A row's control: the page's id for it is the row id with dots as dashes. */
const key = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "-");
const ctl = (p: Page, id: string) => p.locator(`[data-focus-key="${key(id)}"]`);

/**
 * Waits for a row's "Saved" mark. The page redraws the category after a save
 * and only then marks the row, so the next step can't type into an input
 * that the redraw is about to replace (CI run 43597828404: the late redraw
 * swapped the input between fill and change, and the old value was saved).
 */
async function savedMark(p: Page, id: string) {
  await p.waitForSelector(`#s-${key(id)}.set-saved.ok`);
}

/**
 * Changes a number row as a person does (types, then leaves the field) and
 * waits for its save and the page's redraw. One change, so one save: a
 * dispatched change on top of the typed one saved the row twice, and the
 * second save's redraw could land while the next row was being typed into,
 * putting that row back to its old value before its change (issue 424).
 * The wait is armed before the change and matches this row's own value.
 */
async function setNumber(p: Page, id: string, v: number) {
  const saved = p.waitForResponse(
    (r) =>
      r.url().endsWith("/api/settings") &&
      r.request().method() === "POST" &&
      JSON.stringify(r.request().postDataJSON() ?? {}).includes(`:${v}`),
  );
  await ctl(p, id).fill(String(v));
  await ctl(p, id).blur();
  const body = (await saved).request().postDataJSON();
  await savedMark(p, id);
  return body;
}

describe("MODE-5: Settings rows that were the command line's", () => {
  it("switches and numbers, saved, and shown again after a reload", async () => {
    if (skip()) return;
    const p = await settings();
    // Every save the page sends: one per change (issue 424).
    const posts: unknown[] = [];
    p.on("request", (r) => {
      if (r.url().endsWith("/api/settings") && r.method() === "POST")
        posts.push(r.postDataJSON());
    });
    // Terminal tabs: off by default; on saves true.
    expect(await ctl(p, "cli.cli_tabs").isChecked()).toBe(false);
    const tabs = p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/settings") && r.request().method() === "POST",
    );
    await ctl(p, "cli.cli_tabs").check();
    expect((await tabs).request().postDataJSON()).toEqual({ cli_tabs: true });
    await savedMark(p, "cli.cli_tabs");
    expect(await setNumber(p, "cli.log_window_lines", 50000)).toEqual({
      log_window_lines: 50000,
    });
    await show(p, "agents", "agents.pane_reconnect");
    expect(await setNumber(p, "agents.pane_reconnect", 20)).toEqual({
      panes_reconnect: { max_failures: 20 },
    });
    await show(p, "server", "server.crash_loop_wait");
    expect(await setNumber(p, "server.crash_loop_wait", 600)).toEqual({
      crash_loop: { max_wait_seconds: 600 },
    });
    expect(posts).toEqual([
      { cli_tabs: true },
      { log_window_lines: 50000 },
      { panes_reconnect: { max_failures: 20 } },
      { crash_loop: { max_wait_seconds: 600 } },
    ]);
    await p.reload();
    await p.waitForSelector('[data-focus-key="server-crash_loop_wait"]');
    expect(await ctl(p, "server.crash_loop_wait").inputValue()).toBe("600");
    expect(await ctl(p, "server.crash_loop").inputValue()).toBe("5");
    await show(p, "cli", "cli.cli_tabs");
    expect(await ctl(p, "cli.cli_tabs").isChecked()).toBe(true);
    expect(await ctl(p, "cli.log_window_lines").inputValue()).toBe("50000");
    await show(p, "agents", "agents.pane_reconnect");
    expect(await ctl(p, "agents.pane_reconnect").inputValue()).toBe("20");
    // Back to the defaults for the other tests in this server.
    await s!.settings({
      cli_tabs: null,
      log_window_lines: null,
      panes_reconnect: { max_failures: null },
      crash_loop: { max_wait_seconds: null },
    });
    await p.context().close();
  });

  /**
   * Issue 424: one click saved twice. A redraw while the save was out (a
   * plugin's rows arriving, any `den:settings`) drew the switch from the
   * old value, off again; check() then saw it off and clicked a second
   * time, and so would a person. Each save is held here so the redraw
   * lands in it every time.
   */
  async function slowSaves(p: Page) {
    const posts: unknown[] = [];
    p.on("request", (r) => {
      if (r.url().endsWith("/api/settings") && r.method() === "POST")
        posts.push(r.postDataJSON());
    });
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    await p.route("**/api/settings", async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    const sent = p.waitForRequest(
      (r) => r.url().endsWith("/api/settings") && r.method() === "POST",
    );
    // On, then the redraw, mid-save.
    await ctl(p, "cli.cli_tabs").click();
    await sent;
    await p.evaluate(() =>
      window.dispatchEvent(new CustomEvent("den:settings")),
    );
    return { posts, release };
  }

  it("one click saves once, even when the page redraws mid-save", async () => {
    if (skip()) return;
    const p = await settings();
    const { posts, release } = await slowSaves(p);
    // The switch shows the value being saved.
    expect(await ctl(p, "cli.cli_tabs").isChecked()).toBe(true);
    // check() (a person's second look) finds it on, and a stray change
    // with the same value sends nothing.
    await ctl(p, "cli.cli_tabs").check({ timeout: 5_000 });
    await ctl(p, "cli.cli_tabs").dispatchEvent("change");
    release();
    await savedMark(p, "cli.cli_tabs");
    expect(await ctl(p, "cli.cli_tabs").isChecked()).toBe(true);
    expect(posts).toEqual([{ cli_tabs: true }]);
    await p.unroute("**/api/settings");
    await s!.settings({ cli_tabs: null });
    await p.context().close();
  });

  it("on then off while the first save is out saves both, in order", async () => {
    if (skip()) return;
    const p = await settings();
    const { posts, release } = await slowSaves(p);
    // Off before the first save returns (a quick second click; set
    // directly, since a save out past OPEN_MS puts the modal working
    // pop-up over the page): the row keeps the latest.
    await ctl(p, "cli.cli_tabs").evaluate((e) => {
      (e as HTMLInputElement).checked = false;
      e.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(await ctl(p, "cli.cli_tabs").isChecked()).toBe(false);
    const second = p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/settings") &&
        r.request().method() === "POST" &&
        (r.request().postDataJSON() as { cli_tabs?: boolean }).cli_tabs ===
          false,
    );
    release();
    await second;
    await savedMark(p, "cli.cli_tabs");
    expect(await ctl(p, "cli.cli_tabs").isChecked()).toBe(false);
    expect(posts).toEqual([{ cli_tabs: true }, { cli_tabs: false }]);
    await p.unroute("**/api/settings");
    await p.reload();
    await p.waitForSelector('[data-focus-key="cli-cli_tabs"]');
    expect(await ctl(p, "cli.cli_tabs").isChecked()).toBe(false);
    await s!.settings({ cli_tabs: null });
    await p.context().close();
  });

  it("every row of these is a control, none read-only", async () => {
    if (skip()) return;
    const p = await settings();
    for (const [cat, ids] of [
      ["cli", ["cli.local_dev", "cli.cli_tabs", "cli.log_window_lines"]],
      [
        "agents",
        [
          "agents.pane_reconnect",
          "agents.pane_reconnect_window",
          "agents.pane_reconnect_wait",
        ],
      ],
      [
        "server",
        [
          "server.crash_loop",
          "server.crash_loop_minutes",
          "server.crash_loop_wait",
        ],
      ],
    ] as const) {
      await show(p, cat, ids[0]);
      for (const id of ids)
        expect([id, await ctl(p, id).evaluate((e) => e.tagName)]).toEqual([
          id,
          "INPUT",
        ]);
    }
    await p.context().close();
  });
});
