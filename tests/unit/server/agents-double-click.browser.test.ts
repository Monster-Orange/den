/**
 * The double-click fix. Start fresh, Resume (and Relaunch, Stop, Write
 * handoff) hold the agent's buttons while the server answers: a redraw of
 * the list (its poll) keeps them disabled, the pressed one held with the
 * kit's pulsing dots (issue 698; no "Working…" label of its own), so
 * a second click sends nothing. Success clears it; an error is shown and
 * the buttons come back. The server answers two at once with one result.
 *
 * The demo distribution (helpers/agents-page-server.ts), a scripted PTY.
 * Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];
const STOPPED_AT = "2026-11-06T10:30:00.000Z";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
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
  // fresh-one can't resume (no token): Start fresh is its first button.
  s.seed({
    id: "fresh-one",
    persona: "planner",
    workspace: "north",
    stoppedAt: STOPPED_AT,
  });
  s.seed({
    id: "back-one",
    persona: "reviewer",
    workspace: "north",
    resumeToken: "66666666-6666-4666-8666-666666666666",
    stoppedAt: STOPPED_AT,
  });
  s.seed({
    id: "fail-one",
    persona: "planner",
    workspace: "north",
    stoppedAt: STOPPED_AT,
  });
  s.seed({
    id: "slow-one",
    persona: "planner",
    workspace: "north",
    stoppedAt: STOPPED_AT,
  });
  s.seed({
    id: "srv-one",
    persona: "planner",
    workspace: "south",
    stoppedAt: STOPPED_AT,
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
});

const skip = () => !browser;

async function open(
  ws: string,
  setup?: (ctx: BrowserContext) => Promise<void>,
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await setup?.(ctx);
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await signInPage(p, s!.stateDir, s!.base, `/agents?ws=${ws}`);
  await p.waitForSelector("#agl:not([aria-busy]) .agr", {
    state: "attached",
    timeout: 20_000,
  });
  const group = p.locator("#agl details[data-stopped]");
  if ((await group.count()) && (await group.getAttribute("open")) === null)
    await group.locator("summary").click();
  return p;
}

const btn = (agent: string, act: string) =>
  `.agst[data-agent="${agent}"] button[data-act="${act}"]`;

/** Redraw the row as the list's poll does: a new button, enabled. */
const redraw = (p: Page, agent: string) =>
  p.evaluate((a) => {
    const row = document.querySelector(`.agst[data-agent="${a}"]`);
    if (row) row.outerHTML = row.outerHTML.replace(/ disabled(="")?/g, "");
  }, agent);

/** Hold every POST to `verb` until release(); count them. */
async function hold(p: Page, verb: string) {
  const seen: Route[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await p.route(`**/agents/*/${verb}`, async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    seen.push(r);
    await gate;
    await r.continue();
  });
  return { seen, release };
}

/** Until `seen` has `n` requests (the click's request has left). */
async function waitForSeen(p: Page, seen: Route[], n: number, ms = 15_000) {
  const end = Date.now() + ms;
  while (seen.length < n && Date.now() < end) await p.waitForTimeout(25);
}

describe("the double-click fix", () => {
  // Issue 274: the working pop-up's code loads while the page is idle, so
  // a first click's request leaves at once, not after that code's download.
  it("the first click's request doesn't wait for the pop-up's code", async () => {
    if (skip()) return;
    const SLOW = 2_000;
    const p = await open("north", (ctx) =>
      // Its URL carries the version (?v=…).
      ctx.route(
        (u) => u.pathname === "/busy-den.js",
        async (r) => {
          await new Promise((ok) => setTimeout(ok, SLOW));
          await r.continue();
        },
      ),
    );
    // The page has been open longer than the slow download.
    await p.waitForTimeout(SLOW + 1_000);
    const h = await hold(p, "fresh");
    const t0 = Date.now();
    await p.click(btn("slow-one", "fresh"));
    await waitForSeen(p, h.seen, 1, SLOW + 1_000);
    const took = Date.now() - t0;
    expect(h.seen).toHaveLength(1);
    expect(took).toBeLessThan(SLOW / 2);
    h.release();
    await p.context().close();
  }, 60_000);

  for (const [agent, act] of [
    ["fresh-one", "fresh"],
    ["back-one", "resume"],
  ] as const)
    it(`${act}: a second click after a redraw sends nothing; dots until the answer`, async () => {
      if (skip()) return;
      const p = await open("north");
      const h = await hold(p, act);
      await p.click(btn(agent, act));
      await p.waitForFunction(() => true);
      await redraw(p, agent);
      await p.waitForFunction(
        (sel) => (document.querySelector(sel) as HTMLButtonElement)?.disabled,
        btn(agent, act),
      );
      // Issue 698: the redrawn button shows the kit's dots, its label kept.
      await p.waitForFunction(
        (sel) => {
          const b = document.querySelector(sel);
          return (
            // The kit's dots: the button's own aria-hidden span.
            !!b?.querySelector(':scope > span[aria-hidden="true"]') &&
            b.getAttribute("aria-busy") === "true"
          );
        },
        btn(agent, act),
      );
      expect(await p.textContent(btn(agent, act))).not.toContain("Working…");
      await p.click(btn(agent, act), { force: true }).catch(() => undefined);
      await p.dblclick(btn(agent, act), { force: true }).catch(() => undefined);
      // Issue 274: the first request has left (however slow the machine),
      // then the extra clicks have had time to send theirs: none did.
      await waitForSeen(p, h.seen, 1);
      await p.waitForTimeout(300);
      expect(h.seen).toHaveLength(1);
      h.release();
      await p.waitForFunction(
        (a) => !document.querySelector(`.agst[data-agent="${a}"]`),
        agent,
        { timeout: 20_000 },
      );
      expect(h.seen).toHaveLength(1);
    }, 60_000);

  it("an error: shown, and the button comes back", async () => {
    if (skip()) return;
    const p = await open("north");
    await p.route("**/agents/fail-one/fresh", (r) =>
      r.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: "Den is at its limit of 4 running agents.",
        }),
      }),
    );
    await p.click(btn("fail-one", "fresh"));
    // BUSY-1: the working pop-up's Failure says why; Close gives it back.
    await p.waitForFunction(() =>
      (document.querySelector("dialog.bz-dlg")?.textContent ?? "").includes(
        "at its limit of 4",
      ),
    );
    await p.click('dialog.bz-dlg [data-bz="close"]');
    await p.waitForFunction(
      (sel) => {
        const b = document.querySelector(sel) as HTMLButtonElement | null;
        return (
          b &&
          !b.disabled &&
          !b.querySelector(':scope > span[aria-hidden="true"]')
        );
      },
      btn("fail-one", "fresh"),
    );
  }, 60_000);

  it("the server: two Start fresh at once start it once, both get the answer", async () => {
    if (skip()) return;
    const p = await open("south");
    const before = s!.made.length;
    const [a, b] = await p.evaluate(async () => {
      const shell = (
        window as unknown as {
          denShell: { api: (m: string, u: string) => Promise<unknown> };
        }
      ).denShell;
      const u = "/api/workspaces/south/agents/srv-one/fresh";
      return Promise.all([
        shell.api("POST", u).then((x) => JSON.stringify(x)),
        shell.api("POST", u).then((x) => JSON.stringify(x)),
      ]);
    });
    expect(a).toBe(b);
    expect(s!.made.length).toBe(before + 1);
  }, 60_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
