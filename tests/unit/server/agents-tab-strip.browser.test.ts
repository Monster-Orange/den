/**
 * The agents page's tab strip (Tabs layout) shows every open agent's tab
 * whole when they can fit: the tabs give up width (their names shorten)
 * before the strip scrolls sideways. On 0.4.89 each tab kept its own width,
 * up to 280px, so at 390 wide the strip scrolled to the tab in front and
 * cut the first one at the left edge: a strip that scrolls sideways reads
 * as the page scrolling sideways.
 *
 * Three running agents, two with long names, open in Tabs, at 1280 and 390
 * wide, in Chromium and WebKit: every tab lies wholly inside the strip, and
 * the strip doesn't scroll.
 *
 * Invented names only. DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser, type BrowserEngine } from "../helpers/browser.js";

const ENGINES: BrowserEngine[] = ["chromium", "webkit"];
const WIDTHS = [1280, 390];
const RUNNING = [
  "releasecoordinatorforthenorthandsouthprojects1",
  "releasecoordinatorforthenorthandsouthprojects2",
  "runner-3",
];

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
const sids: string[] = [];
const browsers: Partial<Record<BrowserEngine, Browser>> = {};

beforeAll(async () => {
  for (const engine of ENGINES) {
    try {
      const pw = await import("playwright");
      browsers[engine] = await launchBrowser(pw[engine]);
    } catch (err) {
      if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
      throw err;
    }
  }
  s = await startAgentsPageServer({});
  host = await connectHost(sessionPaths(s.stateDir).socket);
  for (const [i, id] of RUNNING.entries()) {
    const info = await host.start({
      name: `acme-north:${id}`,
      cwd: s.wsDir("north"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    sids.push(info.ref.id);
    s.seed({
      id,
      persona: "apersonawithaverylongnamethatcannotbreakanywhere",
      workspace: "north",
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: `acme-north:${id}`,
      startedAt: `2026-11-13T10:0${i}:00.000Z`,
    });
    s.made[s.made.length - 1].emit(`${id} ready\r\n$ `);
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [host, s],
  });
});

async function open(engine: BrowserEngine, width: number): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width, height: 800 },
  });
  const p = await ctx.newPage();
  await signInPage(
    p,
    s!.stateDir,
    s!.base,
    `/agents?open=${sids.join(",")}&layout=tabs`,
  );
  // What's new, over the page on a first visit: seen.
  await p
    .getByRole("button", { name: "Got it" })
    .click({ timeout: 3000 })
    .catch(() => {});
  await p.getByRole("tablist").waitFor();
  await p.waitForFunction(
    (n) =>
      document.querySelectorAll('[role="tablist"] [role="tab"]').length >= n,
    RUNNING.length,
  );
  return p;
}

const skip = () =>
  !Object.keys(browsers).length && process.env.DEN_SKIP_BROWSER_TESTS === "1";

describe("the agents page's tab strip", () => {
  for (const engine of ENGINES)
    for (const width of WIDTHS)
      it(`${engine}, ${width} wide, three agents in Tabs: every tab whole, the strip doesn't scroll`, async () => {
        if (skip()) return;
        const p = await open(engine, width);
        try {
          const m = await p.evaluate(() => {
            const strip = document.querySelector('[role="tablist"]')!;
            const box = strip.getBoundingClientRect();
            const left = box.left;
            const right = box.left + strip.clientWidth;
            const tabs = Array.from(strip.querySelectorAll('[role="tab"]'));
            return {
              scrolls: strip.scrollWidth > strip.clientWidth + 1,
              cut: tabs
                .map((t) => {
                  const r = (t.parentElement ?? t).getBoundingClientRect();
                  return r.left < left - 0.5 || r.right > right + 0.5
                    ? (t.textContent ?? "").trim().slice(0, 24)
                    : "";
                })
                .filter(Boolean),
            };
          });
          expect(m).toEqual({ scrolls: false, cut: [] });
        } finally {
          await p.context().close();
        }
      }, 60_000);
});
