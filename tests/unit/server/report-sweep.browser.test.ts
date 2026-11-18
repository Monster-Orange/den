/**
 * Issue 81's rule, as a sweep: on every page in the nav registry
 * (denShell.pages(), so a page added there is swept with no change here)
 * and in every pop-up a person can open from the shell on it, a Report
 * entry is visible with no menu opened: the top bar's, and each pop-up's
 * own. Pop-ups here: the command palette, the status drawer, the bell,
 * the user menu (◐ ▾), each scope menu (org, project, env), and below
 * 720 px the rail's ☰ drawer (the top bar is inert behind it, so its
 * Report can't be reached). Menus count: "every dialog, drawer, sheet and
 * popover: its own visible Report button".
 *
 * In Chromium and WebKit, in en, es and ja, at 1440 and 390 px. DEN_PW_WS:
 * Den's own Playwright server; else (CI) the browsers Playwright installed.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

jest.setTimeout(60_000);

type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
const LANGS = ["en", "es", "ja"] as const;
const WIDTHS = [1440, 390];

const browsers: Partial<Record<Engine, Browser>> = {};
let s: AgentsPageServer | null = null;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES)
      browsers[e] = process.env.DEN_PW_WS
        ? await pw[e].connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await pw[e].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await s?.settings({ language: "en" }).catch(() => 0);
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

const skip = () => !browsers.chromium || !browsers.webkit;

/**
 * Every pop-up showing now with no visible Report entry of its own (or of
 * the pop-up it is part of), as `tag.class#id`. The form itself, the
 * working pop-up (its own Report) and the bell's inline ask go without.
 */
function missing(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const LAYER =
      'dialog, [role="dialog"], [role="alertdialog"], [role="menu"], .den-drawer';
    const MAY = ".fb-dlg, .bz-dlg, .den-bell-ask";
    // A box with display: contents (the rail's drawer box) has no rect of
    // its own: its children's.
    const rectOf = (el: Element): DOMRect => {
      if (getComputedStyle(el).display !== "contents")
        return el.getBoundingClientRect();
      const rs = [...el.children]
        .map(rectOf)
        .filter((r) => r.width && r.height);
      if (!rs.length) return new DOMRect();
      const l = Math.min(...rs.map((r) => r.left));
      const t = Math.min(...rs.map((r) => r.top));
      return new DOMRect(
        l,
        t,
        Math.max(...rs.map((r) => r.right)) - l,
        Math.max(...rs.map((r) => r.bottom)) - t,
      );
    };
    const seen = (el: Element) => {
      if (el.closest("[inert]")) return false;
      const r = rectOf(el);
      if (!r.width || !r.height) return false;
      if (r.bottom <= 0 || r.right <= 0) return false;
      if (r.top >= innerHeight || r.left >= innerWidth) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && Number(cs.opacity) !== 0;
    };
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(LAYER)) {
      if (el.matches(MAY) || el.closest(MAY)) continue;
      if (el.tagName === "DIALOG" && !(el as HTMLDialogElement).open) {
        let pop = false;
        try {
          pop = el.matches(":popover-open");
        } catch {
          /* no popovers */
        }
        if (!pop) continue;
      }
      if (el.hidden || el.closest("[hidden]") || !seen(el)) continue;
      const host = el.parentElement?.closest(LAYER);
      const has = (x: Element) =>
        [...x.querySelectorAll("[data-den-report]")].some(seen);
      if (has(el) || (host && has(host))) continue;
      out.push(
        `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}${el.id ? "#" + el.id : ""}`,
      );
    }
    return out;
  });
}

/** The top bar's Report, visible (not inert-hidden, in the window). */
function topReport(p: Page): Promise<boolean> {
  return p.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(".den-top [data-den-report]"),
    ].some((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right <= innerWidth + 1;
    }),
  );
}

/** Close whatever is open: Escape twice, then the drawer's scrim. */
async function closeAll(p: Page) {
  await p.keyboard.press("Escape");
  await p.keyboard.press("Escape");
  await p.evaluate(() =>
    (document.querySelector(".den-scrim") as HTMLElement | null)?.click(),
  );
}

/** Let the injector's frame and a repaint pass. */
async function settle(p: Page) {
  await p.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
      ),
  );
  await p.waitForTimeout(120);
}

/**
 * The shell's openers on this page that show now: [what, selector].
 * At 390 the ☰ drawer; at every width the palette, the status drawer,
 * the bell, ◐ ▾ and each scope crumb with a menu.
 */
async function openers(p: Page, width: number): Promise<[string, string][]> {
  const ids: [string, string][] = await p.evaluate(() => {
    const vis = (e: Element | null) => {
      const r = e?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    };
    const out: [string, string][] = [];
    for (const [what, sel] of [
      ["status drawer", "#den-status"],
      ["bell", "#den-bell"],
      ["user menu", "#appearance-btn"],
    ] as const)
      if (vis(document.querySelector(sel))) out.push([what, sel]);
    for (const b of document.querySelectorAll<HTMLElement>(
      ".den-top button[data-scope]",
    ))
      if (vis(b))
        out.push([
          `scope menu ${b.dataset.scope}`,
          `.den-top button[data-scope="${b.dataset.scope}"]`,
        ]);
    if (vis(document.querySelector("#den-menu-btn")))
      out.push(["rail drawer", "#den-menu-btn"]);
    return out;
  });
  return width < 720 ? ids : ids.filter(([w]) => w !== "rail drawer");
}

async function sweepPage(
  p: Page,
  route: string,
  width: number,
): Promise<string[]> {
  const bad: string[] = [];
  await p.goto(s!.base + route);
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  await p.waitForSelector(".den-top [data-den-report]", { timeout: 10_000 });
  await p.addStyleTag({ content: "#cl-overlay{display:none!important}" });
  await settle(p);
  if (!(await topReport(p))) bad.push(`${route} @${width}: no top-bar Report`);
  for (const m of await missing(p)) bad.push(`${route} @${width}: ${m}`);
  // The palette, by its key.
  await p.keyboard.press("Control+k");
  if (
    await p.waitForSelector(".den-pal", { timeout: 3_000 }).catch(() => null)
  ) {
    await settle(p);
    for (const m of await missing(p))
      bad.push(`${route} @${width} palette: ${m}`);
  } else bad.push(`${route} @${width}: the palette didn't open`);
  await closeAll(p);
  for (const [what, sel] of await openers(p, width)) {
    await settle(p);
    await p
      .click(sel)
      .catch(() => bad.push(`${route} @${width}: ${what} not clickable`));
    await settle(p);
    for (const m of await missing(p))
      bad.push(`${route} @${width} ${what}: ${m}`);
    await closeAll(p);
  }
  return bad;
}

async function pagesOf(ctx: BrowserContext): Promise<string[]> {
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, "/"));
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  const hrefs = await p.evaluate(() =>
    (
      window as unknown as {
        denShell: { pages(): { id: string; href: string }[] };
      }
    ).denShell
      .pages()
      .map((x) => x.href),
  );
  await p.close();
  return [...new Set(hrefs.map((h) => new URL(h, "http://x").pathname))];
}

describe("issue 81: a visible Report on every page and in every pop-up the shell opens", () => {
  const cases = ENGINES.flatMap((e) => LANGS.map((l) => [e, l] as const));
  it.each(cases)(
    "%s, %s: every nav page at 1440 and 390, and each pop-up from its shell",
    async (engine, lang) => {
      if (skip()) return;
      await s!.settings({ language: lang });
      const bad: string[] = [];
      for (const width of WIDTHS) {
        const ctx = await browsers[engine]!.newContext({
          viewport: { width, height: 900 },
          reducedMotion: "reduce",
        });
        try {
          const pages = await pagesOf(ctx);
          expect(pages.length).toBeGreaterThan(5);
          const p = await ctx.newPage();
          p.on("pageerror", (e) =>
            errors.push(`${engine} ${lang} ${width}: ${e.message}`),
          );
          await p.goto(s!.base + "/");
          await p.waitForFunction(
            (l) => document.documentElement.lang === l,
            lang,
          );
          for (const r of pages) bad.push(...(await sweepPage(p, r, width)));
        } finally {
          await ctx.close();
        }
      }
      expect(bad).toEqual([]);
    },
    420_000,
  );

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
