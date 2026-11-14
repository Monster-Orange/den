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

jest.setTimeout(60_000);

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
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

/** Settings' category `cat` on the same page. */
async function show(p: Page, cat: string, first: string) {
  await p.evaluate((c) => (location.hash = c), cat);
  await p.waitForSelector(`[data-focus-key="${key(first)}"]`);
}

/** A row's control: the page's id for it is the row id with dots as dashes. */
const key = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "-");
const ctl = (p: Page, id: string) => p.locator(`[data-focus-key="${key(id)}"]`);

/** Changes a number row and waits for its save. */
async function setNumber(p: Page, id: string, v: number) {
  const saved = p.waitForResponse(
    (r) => r.url().endsWith("/api/settings") && r.request().method() === "POST",
  );
  await ctl(p, id).fill(String(v));
  await ctl(p, id).dispatchEvent("change");
  return (await saved).request().postDataJSON();
}

describe("MODE-5: Settings rows that were the command line's", () => {
  it("switches and numbers, saved, and shown again after a reload", async () => {
    if (skip()) return;
    const p = await settings();
    // Terminal tabs: off by default; on saves true.
    expect(await ctl(p, "cli.cli_tabs").isChecked()).toBe(false);
    const tabs = p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/settings") && r.request().method() === "POST",
    );
    await ctl(p, "cli.cli_tabs").check();
    expect((await tabs).request().postDataJSON()).toEqual({ cli_tabs: true });
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
