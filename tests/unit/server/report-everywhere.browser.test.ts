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
import { reportAtOnce, reportMisses, reportSeen } from "./report-at-once.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { pageImport } from "./helpers/page-import.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

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
    n: 6,
    how: "Start an agent, Rename, Link repo, Move, a job still running (0.4.48; an alertdialog, so two): .btns footer",
  },
  "persona-ui.js": { n: 1, how: "persona editor: .btns footer" },
  // Issue 95: the rail's ☰ drawer is the UI kit's now (shell-client.js).
  "shell.js": {
    n: 3,
    how: "approval and pair dialogs: .btns footer",
  },
  // Issues 669, 670: deleting a project's agents (ws-delete-agents.js),
  // start fresh (server-agent-page.js), restart (restart-den.js), Unlink
  // from a Hub project (settings-registry.js), the helpers list
  // (agent-helpers.js), the transcript (transcript-view.js) and My reports
  // (report-den.js) are the kit's dialog frame now: no construct of their
  // own, and mountDialog puts Report first in the frame's .dk-ft.
  // Issue 95: What's new is the UI kit's (whatsnew.js: Report in its
  // .cl-footer, from den-kit.js's reportButton).
  "topbar.js": {
    n: 6,
    how: "admin password ask: reportFoot() drawn with it (den#143); status drawer, palette: a footer of their own",
  },
  "svc-panel.js": {
    n: 1,
    how: "service panel: reportButton(true) drawn in .den-svp-foot (den#143)",
  },
  "agents-page.js": {
    n: 1,
    how: "agent details: reportFoot() drawn with them (den#143)",
  },
  "bell.js": {
    n: 1,
    how: "its inline ask (skipped); the bell's panel is the kit's since den-ui 0.7.0 (hydrateBell), drawn with reportFoot() as its foot (den#143)",
  },
  "gate-chip.js": {
    n: 1,
    how: "the gate queue (issue 144): a dialog on the body, given Report by the injector (gate-chip.browser.test.ts)",
  },
  "graph.js": {
    n: 1,
    how: "the popped detail panel: reportFoot() drawn with it (panel.js, den#143)",
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
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    browser = await launchBrowser(chromium);
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

/**
 * Issue 94, UK-3 "one placement": in the top bar, Report sits right
 * before the bell (then the account), with its word, at every width and
 * on every page, never in the rail; the shortcut shows beside the word
 * only where there is room, and the tooltip always has it.
 */
async function topBarPlacement(p: Page, wide: boolean): Promise<string[]> {
  return p.evaluate((isWide) => {
    const bad: string[] = [];
    const vis = (e: Element | null) => {
      const r = e?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    };
    const top = [
      ...document.querySelectorAll<HTMLElement>(".den-top [data-den-report]"),
    ];
    if (top.length !== 1) return ["top bar has " + top.length + " Report"];
    const b = top[0]!;
    const bell = document.getElementById("den-bell");
    if (!vis(b)) bad.push("top Report not visible");
    if (b.nextElementSibling !== bell) bad.push("not right before the bell");
    const user = document.getElementById("den-user");
    if (
      user &&
      bell &&
      !(bell.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING)
    )
      bad.push("account not after the bell");
    if (!/\S/.test(b.querySelector("span")?.textContent ?? ""))
      bad.push("no word");
    if (!b.querySelector("svg")) bad.push("no icon");
    if (!(b.getAttribute("title") ?? "").includes("⌘⇧F"))
      bad.push("tooltip lacks the shortcut");
    if (vis(b.querySelector("kbd")) !== isWide)
      bad.push("kbd " + (isWide ? "hidden when wide" : "shown when narrow"));
    if (
      document.querySelector(
        ".den-rail [data-den-report], .den-rail [data-act=report]",
      )
    )
      bad.push("Report in the rail");
    if (document.documentElement.scrollWidth > innerWidth)
      bad.push("page scrolls sideways");
    return bad;
  }, wide);
}

/**
 * Every pop-up showing, where its Report button sits: first in its row,
 * so no other button of that row is before it (above it, or to its left).
 */
async function misplaced(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const out: string[] = [];
    for (const b of document.querySelectorAll<HTMLElement>(
      "[data-den-report]",
    )) {
      if (b.closest(".den-top, .den-rail, .fb-dlg")) continue;
      const r = b.getBoundingClientRect();
      if (!r.width) continue;
      const row = b.parentElement!;
      for (const o of row.querySelectorAll<HTMLElement>(
        ":scope > button, :scope > a",
      )) {
        if (o === b) continue;
        const q = o.getBoundingClientRect();
        if (!q.width) continue;
        const before =
          q.bottom <= r.top + 2 || (q.top < r.bottom - 2 && q.left < r.left);
        if (before)
          out.push(
            `${row.className || row.tagName}: ${o.textContent?.trim().slice(0, 20)} before Report`,
          );
      }
    }
    return out;
  });
}

async function clean(p: Page) {
  expect(await missing(p)).toEqual([]);
  expect(await misplaced(p)).toEqual([]);
}

describe("the Report button in every pop-up (FB, den#81)", () => {
  it.each([1440, 390])(
    "issue 94: one placement at %i: the top bar before the bell, first in every pop-up's footer",
    async (w) => {
      if (skip()) return;
      const p = await open("/agents", w);
      await p.addStyleTag({ content: "#cl-overlay{display:none!important}" });
      expect(await topBarPlacement(p, w >= 1000)).toEqual([]);
      await p.keyboard.press("Control+k");
      await p.waitForSelector(".den-pal");
      await clean(p);
      await p.keyboard.press("Escape");
      await p.click("#den-status");
      await p.waitForSelector("#den-status-drawer");
      await clean(p);
      await p.keyboard.press("Escape");
      await p.click("#den-bell");
      await p.waitForSelector("#den-bell-pop:not([hidden])");
      await clean(p);
      await p.keyboard.press("Escape");
      await p.click("#ag-start");
      await p.waitForSelector("#ag-dlg[open]");
      await clean(p);
      await p.context().close();
    },
    60_000,
  );

  it("the palette, the status drawer, the bell and the admin password ask", async () => {
    if (skip()) return;
    const p = await open("/settings");
    await p.addStyleTag({ content: "#cl-overlay{display:none!important}" });
    await p.keyboard.press("Control+k");
    await p.waitForSelector(".den-pal");
    await clean(p);
    await p.keyboard.press("Escape");
    await p.click("#den-status");
    await p.waitForSelector("#den-status-drawer");
    await clean(p);
    await p.keyboard.press("Escape");
    await p.click("#den-bell");
    await p.waitForSelector("#den-bell-pop:not([hidden])");
    await clean(p);
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
      `${pageImport("/topbar.js")}.then((m) => { void m.askSudo({ command: "make install" }); })`,
    );
    await p.waitForSelector("#den-lock-pop");
    await clean(p);
    // The button in a pop-up opens the form over it; the pop-up stays.
    await p.click("#den-lock-pop [data-den-report]");
    await p.waitForSelector(".fb-dlg[open]");
    expect(await p.isVisible("#den-lock-pop")).toBe(true);
    await p.context().close();
  });

  it("den#143: the bell, the admin password ask and the graph's popped details have Report the moment they show, and through a repaint", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    await reportAtOnce(ctx);
    const p = await ctx.newPage();
    await p.goto(signInUrl(s!.stateDir, s!.base, "/graph?ws=north"));
    await p.waitForFunction(
      () => !!(window as { denShell?: unknown }).denShell,
    );
    await p.addStyleTag({ content: "#cl-overlay{display:none!important}" });
    // The bell: shown, then its refresh while open repaints it (every 5 s).
    await p.click("#den-bell");
    await p.waitForSelector("#den-bell-pop:not([hidden])");
    await p.waitForTimeout(5_600);
    await p.keyboard.press("Escape");
    // The graph's details, popped out, then another tab (a repaint).
    await p.waitForSelector(".dg-card");
    await p.click(".dg-card");
    await p.waitForSelector(".dg-panel:not([hidden])");
    await p.click(".dg-panel [data-popout]");
    await p.waitForSelector(".dg-panel[role=dialog]");
    const tabs = p.locator(
      '.dg-panel[role=dialog] [role="tab"][aria-selected="false"]',
    );
    if (await tabs.count()) await tabs.first().click();
    await p.waitForTimeout(300);
    await p.keyboard.press("Escape");
    // The admin password ask (the test's routes: no password, no vault).
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
    await p.evaluate(
      `${pageImport("/topbar.js")}.then((m) => { void m.askSudo({ command: "make install" }); })`,
    );
    await p.waitForSelector("#den-lock-pop");
    await p.waitForTimeout(300);
    expect((await reportSeen(p)).sort()).toEqual(
      ["#den-bell-pop", "#den-lock-pop", ".dg-panel[role=dialog]"].sort(),
    );
    expect(await reportMisses(p)).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("What's new, and Start an agent", async () => {
    if (skip()) return;
    const p = await open("/agents");
    await p.evaluate(() =>
      (window as { openChangelog?: () => void }).openChangelog?.(),
    );
    await p.waitForSelector("#cl-overlay.open");
    await clean(p);
    await p.evaluate(() =>
      (window as { closeChangelog?: () => void }).closeChangelog?.(),
    );
    await p.addStyleTag({ content: "#cl-overlay{display:none!important}" });
    await p.click("#ag-start");
    await p.waitForSelector("#ag-dlg[open]");
    await clean(p);
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
});
