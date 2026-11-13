/**
 * #80 (0.4.45): in a project, the Agents page holds only that project's
 * agents and shells, plus the server agent. 0.4.44 added the open tabs'
 * projects to the list, so a tabs link from another project showed every
 * project's agents and mixed their tabs in.
 *
 *   1. In a project: the list, the tabs and ?open= hold only its own.
 *   2. ?open= naming another project's sessions: they leave the tabs, and
 *      one line says "N tabs from other projects hidden · Show in All
 *      active", which shows them all.
 *   3. A link to one agent in another project (?agent=, as ⌘K, a bell
 *      item or another page link it) switches to that agent's project,
 *      then opens it.
 *
 * The demo distribution (acme; north and south active) with a session
 * host in this process and a scripted PTY: nothing really runs.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
/** A shell in north and one in south, by id. */
const shells: Record<string, string> = {};

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
  for (const ws of ["north", "south"]) {
    const p = await open(`/agents?terminal=1&ws=${ws}`);
    await p.waitForFunction(() => !/terminal=1/.test(location.search));
    await p.waitForFunction(
      () => !!new URLSearchParams(location.search).get("open"),
    );
    const ids = (new URL(p.url()).searchParams.get("open") ?? "").split(",");
    shells[ws] = ids.find((x) => !Object.values(shells).includes(x)) ?? "";
    await p.context().close();
  }
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

async function open(next: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
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
  await p.goto(signInUrl(s!.stateDir, s!.base, next));
  return p;
}

/** The projects of the list's groups, and the tabs' ids. */
const listed = (p: Page) =>
  p.$$eval("#agl .wsg", (xs) => xs.map((x) => (x as HTMLElement).dataset.ws));
const tabs = (p: Page) =>
  p.$$eval(".agtab[data-id]", (xs) =>
    xs.map((x) => (x as HTMLElement).dataset.id),
  );
const openParam = (p: Page) =>
  (new URL(p.url()).searchParams.get("open") ?? "").split(",").filter(Boolean);

describe("#80: a project's view holds only its own", () => {
  it("the list, the tabs and ?open= hold north's; south's tab is hidden, said in one line", async () => {
    if (!browser) return;
    expect(shells.north && shells.south).toBeTruthy();
    const p = await open(
      `/agents?ws=north&layout=tabs&open=${shells.north},${shells.south}`,
    );
    await p.waitForSelector("#agl .wsg");
    await p.waitForTimeout(500);
    expect(await listed(p)).toEqual(["north"]);
    expect(await tabs(p)).toEqual([shells.north]);
    expect(openParam(p)).toEqual([shells.north]);
    const note = p.locator('#agl [data-note="other-tabs"]');
    expect((await note.textContent())?.replace(/\s+/g, " ").trim()).toBe(
      "1 tab from other projects hidden · Show in All active",
    );
    // Show in All active: every project, and both tabs.
    await note.locator("button").click();
    await p.waitForFunction(
      () => !new URLSearchParams(location.search).get("ws"),
    );
    await p.waitForSelector(`.agtab[data-id="${shells.south}"]`);
    expect((await tabs(p)).sort()).toEqual([shells.north, shells.south].sort());
    expect((await listed(p)).sort()).toEqual(["north", "south"]);
    await p.context().close();
  }, 60_000);

  it("a link to one agent in another project switches to its project, then opens it", async () => {
    if (!browser) return;
    s!.seed({
      id: "scout",
      persona: "reviewer",
      workspace: "south",
      resumeToken: "77777777-7777-4777-8777-777777777777",
      stoppedAt: "2026-11-06T10:00:00.000Z",
    });
    const p = await open(`/agents?ws=north&agent=scout`);
    await p.waitForFunction(
      () =>
        new URLSearchParams(location.search).get("ws") === "south" ||
        new URLSearchParams(location.search).get("project") === "south",
    );
    await p.waitForSelector('#agl .agst[data-agent="scout"]');
    expect(await listed(p)).not.toContain("north");
    await p.context().close();
  }, 60_000);
});
