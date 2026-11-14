/**
 * FB (den#81), Ward's rule: the Report button is visible on every page
 * and inside every pop-up, never only in a menu, and on a phone in the
 * top bar. A ratchet on two sides:
 *
 * - In the page: on the real pages, the pop-ups a person opens most (the
 *   palette, the status drawer, the bell, the admin password ask, What's
 *   new, Start an agent). After each, every pop-up showing on the page,
 *   found by what it is (a dialog, role=dialog or alertdialog, a drawer,
 *   a popover), has a Report button, listed below or not.
 * - In the source: every pop-up the page code builds is counted, file by
 *   file. A new one fails here until it is listed (KNOWN) with how it gets
 *   Report, so one added later can't go without.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

jest.setTimeout(60_000);

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

/**
 * Every pop-up the page code builds, per file: how many constructs (a
 * `<dialog`, a dialog made in code, role="dialog" or "alertdialog", a
 * drawer; one pop-up can be two, and comments count), and how each gets
 * Report. The count is a ratchet: it goes up only with a line here. report-inject.js gives it to all of
 * them unless the note says otherwise.
 */
const KNOWN: Record<string, { n: number; how: string }> = {
  "agents.html": {
    n: 4,
    how: "Start an agent, Rename, Link repo, Move: .btns footer",
  },
  "persona-ui.js": { n: 1, how: "persona editor: .btns footer" },
  "shell.js": {
    n: 4,
    how: "approval and pair dialogs: .btns footer; the rail as a drawer is skipped (Report is on the rail)",
  },
  "ws-delete-agents.js": {
    n: 1,
    how: "deleting a project's agents: .wsd-acts",
  },
  "server-agent-page.js": { n: 2, how: "start fresh: .sa-fresh-acts" },
  "restart-den.js": { n: 1, how: "restart: .rd-acts, or a footer of its own" },
  "busy.js": { n: 1, how: "skipped: the working pop-up has its own Report" },
  "agent-helpers.js": { n: 1, how: "helpers list: a footer of its own" },
  "transcript-view.js": { n: 2, how: "transcript: a footer of its own" },
  "header.js": { n: 1, how: "What's new: reportButton() in .cl-footer" },
  "topbar.js": {
    n: 6,
    how: "admin password ask, status drawer, palette: a footer of their own",
  },
  "svc-panel.js": { n: 1, how: "service panel: .den-svp-foot" },
  "agents-page.js": { n: 1, how: "agent details: a footer of its own" },
  "bell.js": {
    n: 2,
    how: "the bell's panel: a footer of its own; its inline ask is skipped",
  },
  "graph.js": { n: 1, how: "the popped detail panel: a footer of its own" },
  "report-dialog.js": {
    n: 2,
    how: "the form itself, and My reports (part of Report: its own way to it)",
  },
  "popover.js": { n: 3, how: "not a pop-up: how pop-ups close" },
  "report-inject.js": { n: 2, how: "not a pop-up: the injector's own list" },
};

/** What counts as building a pop-up, in page code. */
const CONSTRUCT =
  /<dialog\b|createElement\(\s*["']dialog["']\s*\)|role=\\?["'](?:alert)?dialog\\?["']|setAttribute\(\s*["']role["']\s*,\s*["'](?:alert)?dialog["']|class=\\?["'][^"']*\bden-drawer\b/g;

function countConstructs(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fs.readdirSync(PUBLIC)) {
    if (!/\.(js|html)$/.test(f)) continue;
    const n = (
      fs.readFileSync(path.join(PUBLIC, f), "utf-8").match(CONSTRUCT) ?? []
    ).length;
    if (n) out[f] = n;
  }
  return out;
}

describe("every pop-up the page code builds is listed (FB ratchet)", () => {
  it("names each file's pop-ups, and how each gets Report", () => {
    const want = Object.fromEntries(
      Object.entries(KNOWN).map(([f, k]) => [f, k.n]),
    );
    expect(countConstructs()).toEqual(want);
  });
});

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

async function open(route: string, width = 1440): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, route));
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  return p;
}

/**
 * Every pop-up showing now with no Report button, by what it is (not by
 * the injector's own list), as `tag.class#id`. The form itself, the
 * working pop-up (its own Report), the rail as a drawer and the bell's
 * inline ask are the ones that may go without.
 */
async function missing(p: Page): Promise<string[]> {
  // A frame for the injector, and one more for a pop-up that repaints.
  await p.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
      ),
  );
  await p.waitForTimeout(150);
  return p.evaluate(() => {
    const PROBE =
      'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], .den-drawer, .den-pop:not([role="menu"]):not([role="listbox"]), .den-sheet';
    const MAY = ".fb-dlg, .bz-dlg, .den-rail, .den-rail-box, .den-bell-ask";
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(PROBE)) {
      if (el.matches(MAY) || el.closest(MAY)) continue;
      // A <dialog> shown as a popover (showPopover) shows with open unset.
      if (
        el.tagName === "DIALOG" &&
        !(el as HTMLDialogElement).open &&
        !el.matches(":popover-open")
      )
        continue;
      if (el.hidden || el.closest("[hidden]")) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      // Its own button, or the one of the pop-up it is part of.
      const host = el.parentElement?.closest(PROBE);
      const has = (x: Element) =>
        [...x.querySelectorAll<HTMLElement>("[data-den-report]")].some(
          (b) => b.getBoundingClientRect().width > 0,
        );
      if (has(el) || (host && has(host))) continue;
      out.push(
        `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}${el.id ? "#" + el.id : ""}`,
      );
    }
    return out;
  });
}

describe("the Report button in every pop-up (FB, den#81)", () => {
  it("the palette, the status drawer, the bell and the admin password ask", async () => {
    if (skip()) return;
    const p = await open("/settings");
    await p.addStyleTag({ content: "#cl-overlay{display:none!important}" });
    await p.keyboard.press("Control+k");
    await p.waitForSelector(".den-pal");
    expect(await missing(p)).toEqual([]);
    await p.keyboard.press("Escape");
    await p.click("#den-status");
    await p.waitForSelector("#den-status-drawer");
    expect(await missing(p)).toEqual([]);
    await p.keyboard.press("Escape");
    await p.click("#den-bell");
    await p.waitForSelector("#den-bell-pop:not([hidden])");
    expect(await missing(p)).toEqual([]);
    await p.keyboard.press("Escape");
    // The ask a run makes when sudo needs the password (topbar.js). The
    // password and vault routes are the test's: no password set, no vault
    // (the real keychain is never read).
    await p.route("**/api/sudo-password/**", (r) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          set: false,
          backendAvailable: false,
          hasStored: false,
        }),
      }),
    );
    // (A string: the test's compiler would rewrite import() in a function.)
    await p.evaluate(
      `import("/topbar.js").then((m) => { void m.askSudo({ command: "make install" }); })`,
    );
    await p.waitForSelector("#den-lock-pop");
    expect(await missing(p)).toEqual([]);
    // The button in a pop-up opens the form over it; the pop-up stays.
    await p.click("#den-lock-pop [data-den-report]");
    await p.waitForSelector(".fb-dlg[open]");
    expect(await p.isVisible("#den-lock-pop")).toBe(true);
    await p.context().close();
  });

  it("What's new, and Start an agent", async () => {
    if (skip()) return;
    const p = await open("/agents");
    await p.evaluate(() =>
      (window as { openChangelog?: () => void }).openChangelog?.(),
    );
    await p.waitForSelector("#cl-overlay.open");
    expect(await missing(p)).toEqual([]);
    await p.evaluate(() =>
      (window as { closeChangelog?: () => void }).closeChangelog?.(),
    );
    await p.addStyleTag({ content: "#cl-overlay{display:none!important}" });
    await p.click("#ag-start");
    await p.waitForSelector("#ag-dlg[open]");
    expect(await missing(p)).toEqual([]);
    // In the footer, first: it sits on the left.
    expect(
      await p.evaluate(
        () =>
          document
            .querySelector("#ag-dlg .btns")
            ?.firstElementChild?.matches("[data-den-report]") ?? false,
      ),
    ).toBe(true);
    await p.context().close();
  });

  it("on a phone: in the top bar, icon and word, no shortcut", async () => {
    if (skip()) return;
    const p = await open("/settings", 390);
    const b = p.locator(".den-top [data-den-report]");
    await expect(b.isVisible()).resolves.toBe(true);
    await expect(b.locator("kbd").isVisible()).resolves.toBe(false);
    await expect(b.innerText()).resolves.toMatch(/Report/);
    // Wide, the rail has it: the top bar's is hidden.
    await p.setViewportSize({ width: 1440, height: 900 });
    await expect(b.isVisible()).resolves.toBe(false);
    await p.context().close();
  });
});
