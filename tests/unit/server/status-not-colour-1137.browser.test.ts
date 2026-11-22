/**
 * Issue 1137 (2): a status is never told by colour alone. In the sketch
 * theme ok, warn and bad are near-identical greys, and some people can't
 * tell the colours apart in any theme. So every status dot that shows
 * (.den-dot, drawn aria-hidden) has a word with it: text in its row, or a
 * label or title on it or its row.
 *
 * On the Agents page (stopped and interrupted agents, their groups) and in
 * the bell, in a real browser. The check is tested too: a dot with no word
 * must be caught.
 *
 * The demo distribution (acme; north, south) with a session host in this
 * process and a scripted PTY (helpers/agents-page-server.ts): nothing
 * really runs. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { signInPage } from "./helpers/signed-in.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let latest = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
  // The newest release (the list's head), so What's new stays shut.
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
  // north: stopped agents (hollow dots); south: two a restart interrupted.
  for (const id of ["scout", "keeper"])
    s.seed({
      id,
      persona: "reviewer",
      workspace: "north",
      stoppedAt: "2026-11-06T10:00:00.000Z",
    });
  for (const id of ["night", "dawn"])
    s.seed({ id, persona: "devops", workspace: "south" });
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

/**
 * In the page: each shown status dot with no word beside it, as its
 * classes and its row's HTML. A word is visible text in the dot's row (its
 * parent, up to three levels, not counting the dot), or an aria-label or
 * title on the dot or that row.
 */
const LONE_DOTS_JS = `(() => {
  const lone = [];
  for (const d of document.querySelectorAll(".den-dot")) {
    if (!d.checkVisibility()) continue;
    let ok = !!(d.getAttribute("aria-label") || d.getAttribute("title"));
    let el = d.parentElement;
    for (let i = 0; i < 3 && el && !ok; i++, el = el.parentElement) {
      if (el.getAttribute("aria-label") || el.getAttribute("title")) ok = true;
      const words = [...el.childNodes]
        .filter((n) => n !== d)
        .map((n) => (n.nodeType === 3 ? n.textContent : n.innerText) || "")
        .join(" ")
        .trim();
      if (words) ok = true;
    }
    if (!ok)
      lone.push(d.className + " in " + (d.parentElement?.outerHTML ?? "").slice(0, 160));
  }
  return lone;
})()`;

async function open(path: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
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
  await signInPage(p, s!.stateDir, s!.base, path);
  return p;
}

const lone = (p: Page) => p.evaluate<string[]>(LONE_DOTS_JS);
const shown = (p: Page) =>
  p.evaluate<number>(
    `[...document.querySelectorAll(".den-dot")].filter((d) => d.checkVisibility()).length`,
  );

describe("issue 1137 (2): a status is never told by colour alone", () => {
  it("the check catches a dot with no word", async () => {
    if (!browser) return;
    const p = await open("/agents?ws=north");
    await p.waitForSelector("#agl:not([aria-busy])", { timeout: 20_000 });
    await p.evaluate(() => {
      const box = document.createElement("div");
      box.id = "lone-1137";
      box.innerHTML = '<span class="den-dot ok" aria-hidden="true"></span>';
      document.body.append(box);
    });
    expect(await lone(p)).toEqual([
      expect.stringContaining('den-dot ok in <div id="lone-1137">'),
    ]);
    await p.context().close();
  }, 60_000);

  for (const ws of ["north", "south"])
    it(`the Agents page (${ws}): every status dot has a word`, async () => {
      if (!browser) return;
      const p = await open(`/agents?ws=${ws}`);
      await p.waitForSelector("#agl:not([aria-busy]) [data-agent]", {
        timeout: 20_000,
      });
      expect(await shown(p)).toBeGreaterThan(0);
      expect(await lone(p)).toEqual([]);
      await p.context().close();
    }, 60_000);

  it("the bell: every status dot has a word", async () => {
    if (!browser) return;
    const p = await open("/agents?ws=south");
    await p.locator("#den-bell").click();
    await p.locator("#den-bell-pop").waitFor();
    expect(await lone(p)).toEqual([]);
    await p.context().close();
  }, 60_000);
});
