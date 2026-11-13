/**
 * The double-click fix. Start fresh, Resume (and Relaunch, Stop, Write
 * handoff) hold the agent's buttons while the server answers: a redraw of
 * the list (its poll) keeps them disabled, the pressed one "Working…", so
 * a second click sends nothing. Success clears it; an error is shown and
 * the buttons come back. The server answers two at once with one result.
 *
 * The demo distribution (helpers/agents-page-server.ts), a scripted PTY.
 * Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];
const STOPPED_AT = "2026-11-06T10:30:00.000Z";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
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
    id: "srv-one",
    persona: "planner",
    workspace: "south",
    stoppedAt: STOPPED_AT,
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function open(ws: string): Promise<Page> {
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
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(signInUrl(s!.stateDir, s!.base, `/agents?ws=${ws}`));
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

describe("the double-click fix", () => {
  for (const [agent, act] of [
    ["fresh-one", "fresh"],
    ["back-one", "resume"],
  ] as const)
    it(`${act}: a second click after a redraw sends nothing; Working… until the answer`, async () => {
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
      expect(await p.textContent(btn(agent, act))).toBe("Working…");
      await p.click(btn(agent, act), { force: true }).catch(() => undefined);
      await p.dblclick(btn(agent, act), { force: true }).catch(() => undefined);
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
    await p.waitForFunction(() =>
      (document.body.textContent ?? "").includes("at its limit of 4"),
    );
    await p.waitForFunction(
      (sel) => {
        const b = document.querySelector(sel) as HTMLButtonElement | null;
        return b && !b.disabled && b.textContent !== "Working…";
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
