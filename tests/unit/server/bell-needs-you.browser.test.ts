/**
 * Issue 101, on the real page: the bell's panel opens on "Needs you" (an
 * agent waiting, with no Mark read), then "Earlier" (Updates); in Spanish
 * the kit says "Te necesitan" and "Antes".
 *
 * The demo distribution; items written to the store here. Invented names
 * only. Needs Playwright's chromium (DEN_PW_WS to connect to one);
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    browser = await launchBrowser(pw.chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  const st = new NotificationStore(s.stateDir);
  st.add({
    kind: "service",
    subject: "agent:shipper",
    scope: "workspace/north",
    text: "Release 1 shipped",
  });
  // The question's agent is a real one (issue 424, as bell-v6): the
  // server's first attention check withdraws an unread "asked" row whose
  // agent has no record (issue 369), and whether that check came before or
  // after this row was timing.
  s.seed({ id: "asker", workspace: "north" });
  st.add({
    kind: "waiting",
    subject: "agent:asker",
    scope: "workspace/north",
    text: "Asker asked: which one?",
    msg: { key: "bell.m.asked", vars: { name: "Asker", text: "which one?" } },
    link: "/agents?project=north&agent=asker",
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

async function open(path: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
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
  await p.waitForSelector("#den-bell");
  await p.waitForFunction(
    () => document.querySelector(".den-bell-n")?.textContent === "1",
    undefined,
    { timeout: 15_000 },
  );
  await p.click("#den-bell");
  await p.locator('#den-bell-pop [data-sec="needs"]').waitFor();
  return p;
}

const headings = (p: Page) =>
  p.$$eval("#den-bell-pop .den-bell-sec", (els) =>
    els.map((e) => ({
      sec: e.getAttribute("data-sec"),
      h: e.querySelector("h3")?.textContent,
      waiting: e.querySelectorAll('[data-kind="waiting"]').length,
      updates: e.querySelectorAll('[data-bell="updates"]').length,
      markRead: e.querySelectorAll('[data-bell="scope"]').length,
    })),
  );

describe("issue 101: Needs you, first in the bell", () => {
  it("Needs you (the waiting agent, no Mark read), then Earlier (Updates)", async () => {
    if (!browser) return;
    const p = await open("/services");
    expect(await headings(p)).toEqual([
      { sec: "needs", h: "Needs you", waiting: 1, updates: 0, markRead: 0 },
      { sec: "earlier", h: "Earlier", waiting: 0, updates: 1, markRead: 0 },
    ]);
    await p.context().close();
  }, 90_000);

  it("in Spanish: Te necesitan, then Antes", async () => {
    if (!browser) return;
    expect(await s!.settings({ language: "es" })).toBe(200);
    try {
      const p = await open("/services");
      const h = await headings(p);
      expect(h.map((x) => x.h)).toEqual(["Te necesitan", "Antes"]);
      await p.context().close();
    } finally {
      await s!.settings({ language: null });
    }
  }, 90_000);
});
