/**
 * Issue 773, clause 5: the Agents list matches the approved mock ("Agents:
 * four states, one list sorted by who needs you", v3) in a browser, on the
 * real path: agents started through the API, their turns said through the
 * attention route with their own tokens.
 *
 *   1. All projects: one list in four bands, in order Needs you, Done not
 *      seen, Working, Idle, each headed by its word and count; each row's
 *      mark (!, a tick, a halo, a ring) and chip ("Needs you · permission",
 *      "Done", "Working", "Idle"); each row tagged with its project. The
 *      sub-line names each state above zero.
 *   2. The bell: Needs you first, then Done, not seen, with "<name>
 *      finished".
 *   3. Done turns into Idle when the person opens the agent; the Done band
 *      goes; a reload keeps it (the server's seen mark).
 *   4. One project: only its agents, no project tag.
 *   5. A phone, 390 px: the same bands; each row 64 px tall or more; no
 *      sideways scroll.
 *
 * The demo distribution, a scripted PTY: nothing really runs. Needs
 * Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names
 * only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { denAuth, signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
/** A role in the test → { id: the agent's id, sid: its session's, token }. */
const ag: Record<string, { id: string; sid: string; token: string }> = {};
const errors: string[] = [];
/** The newest changelog version: seen, so What's new stays shut. */
let latest = "";

/** An agent started as a person does (the demo's planner persona). */
async function startAgent(ws: string, role: string): Promise<void> {
  const r = await fetch(`${s!.base}/api/workspaces/${ws}/agents`, {
    method: "POST",
    headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ persona: "planner" }),
  });
  expect(r.status).toBe(200);
  const token = actorTokenOf(s!.made.at(-1)!.opts.env) ?? "";
  s!.made.at(-1)!.emit("> ");
  const list = (await (
    await fetch(`${s!.base}/api/sessions`, { headers: denAuth(s!.stateDir) })
  ).json()) as {
    sessions: { id: string; agent?: string }[];
  };
  const row = list.sessions.find(
    (x) => !!x.agent && !Object.values(ag).some((a) => a.id === x.agent),
  )!;
  ag[role] = { id: row.agent!, sid: row.id, token };
}

const say = (role: string, body: unknown) =>
  fetch(`${s!.base}/api/agents/self/attention`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ag[role].token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

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
  await startAgent("north", "planner");
  await startAgent("north", "builder");
  await startAgent("south", "reviewer");
  await startAgent("north", "scribe");
  // planner: stopped on a permission. builder: a turn, finished, unseen.
  // reviewer: in a turn. scribe: nothing yet (Idle).
  expect(
    (
      await say("planner", {
        event: "waiting",
        why: "permission",
        what: "Bash",
        hooked: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (await say("builder", { event: "resumed", from: "prompt" })).status,
  ).toBe(200);
  expect((await say("builder", { event: "finished" })).status).toBe(200);
  expect(
    (await say("reviewer", { event: "resumed", from: "tool", what: "Read" }))
      .status,
  ).toBe(200);
  // Every project in view.
  await fetch(`${s.base}/api/scope`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ scope: "all" }),
  });
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser || !s;

async function open(path: string, width = 1280): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    // No What's new over the list.
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(signInUrl(s!.stateDir, s!.base, path));
  await p.locator("#agl .agband").first().waitFor({ timeout: 20_000 });
  return p;
}

/**
 * The bands as the list shows them, [state, [session ids]], with only this
 * test's agents (an install's own server agent may be listed too).
 */
async function bands(p: Page): Promise<[string, string[]][]> {
  const all = await p.$$eval("#agl .agband", (bs) =>
    bs.map(
      (b) =>
        [
          (b as HTMLElement).dataset.band ?? "",
          [...b.querySelectorAll("button.agr")].map(
            (r) => (r as HTMLElement).dataset.id ?? "",
          ),
        ] as [string, string[]],
    ),
  );
  const mine = new Set(Object.values(ag).map((a) => a.sid));
  return all
    .map(
      ([b, ids]) => [b, ids.filter((x) => mine.has(x))] as [string, string[]],
    )
    .filter(([, ids]) => ids.length > 0);
}

describe("issue 773: four states, one list sorted by who needs you", () => {
  it("All projects: the bands in order, each row's mark, chip and project tag; the sub-line", async () => {
    if (skip()) return;
    const p = await open("/agents");
    await p.waitForFunction(
      () => document.querySelectorAll("#agl .agband").length >= 4,
      null,
      { timeout: 20_000 },
    );
    expect(await bands(p)).toEqual([
      ["needs", [ag.planner.sid]],
      ["done", [ag.builder.sid]],
      ["working", [ag.reviewer.sid]],
      ["idle", [ag.scribe.sid]],
    ]);
    // Each band headed by its word, then its count.
    expect(
      await p.$$eval("#agl .agband > .wsh > span:first-child", (hs) =>
        hs.map((h) => h.textContent?.trim()),
      ),
    ).toEqual(["Needs you", "Done, not seen", "Working", "Idle"]);
    expect(
      await p.textContent('#agl .agband[data-band="needs"] > .wsh .n'),
    ).toBe("1");
    const row = (k: string) =>
      p.locator(`#agl button.agr[data-id="${ag[k].sid}"]`);
    // The marks: their own shape and sign.
    expect(await row("planner").locator(".agm.need").textContent()).toBe("!");
    expect(await row("builder").locator(".agm.done").textContent()).toBe("✓");
    expect(await row("reviewer").locator(".agm.work").count()).toBe(1);
    expect(await row("scribe").locator(".agm.idle").count()).toBe(1);
    // The chips.
    expect(await row("planner").locator(".cp").textContent()).toBe(
      "Needs you · permission",
    );
    expect(await row("builder").locator(".cp").textContent()).toBe("Done");
    expect(await row("reviewer").locator(".cp").textContent()).toBe("Working");
    expect(await row("scribe").locator(".cp").textContent()).toBe("Idle");
    // Each row has its project tag.
    expect(await row("planner").locator(".ptag").textContent()).toBe("north");
    expect(await row("reviewer").locator(".ptag").textContent()).toBe("south");
    // The sub-line: each state above zero.
    const sub = (await p.textContent("#ag-count")) ?? "";
    expect(sub).toMatch(/^\d+ agents · /);
    expect(sub).toContain("1 needs you");
    expect(sub).toContain("1 done, not seen");
    expect(sub).toContain("1 working");
    expect(sub).toMatch(/\d+ idle/);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("the bell: Needs you first, then Done, not seen", async () => {
    if (skip()) return;
    const p = await open("/agents");
    await p.click("#den-bell");
    const pop = p.locator("#den-bell-pop");
    await pop.locator('[data-sec="done"]').waitFor({ timeout: 10_000 });
    const order = await pop.evaluate((el) =>
      [...el.querySelectorAll("[data-sec]")].map(
        (x) => (x as HTMLElement).dataset.sec,
      ),
    );
    expect(order.slice(0, 2)).toEqual(["needs", "done"]);
    expect(
      await pop
        .locator('[data-sec="done"] .den-bell-row')
        .first()
        .textContent(),
    ).toContain("finished");
    await p.context().close();
  }, 60_000);

  it("Done turns into Idle when the person opens the agent; the Done band goes; a reload keeps it", async () => {
    if (skip()) return;
    const p = await open("/agents");
    await p.click(`#agl button.agr[data-id="${ag.builder.sid}"]`);
    await p.waitForFunction(
      () => !document.querySelector('#agl .agband[data-band="done"]'),
      null,
      { timeout: 10_000 },
    );
    const idle = await bands(p);
    expect(idle.map(([b]) => b)).toEqual(["needs", "working", "idle"]);
    expect(idle.find(([b]) => b === "idle")![1]).toContain(ag.builder.sid);
    expect(await p.locator('#agl .agband[data-band="done"]').count()).toBe(0);
    await p.reload();
    await p.locator("#agl .agband").first().waitFor({ timeout: 20_000 });
    await p.waitForTimeout(500);
    expect((await bands(p)).map(([b]) => b)).toEqual([
      "needs",
      "working",
      "idle",
    ]);
    await p.context().close();
  }, 60_000);

  it("one project: only its agents, no project tag", async () => {
    if (skip()) return;
    const p = await open("/agents?ws=north");
    await p.waitForTimeout(500);
    const ids = (await bands(p)).flatMap(([, rows]) => rows);
    expect(ids).not.toContain(ag.reviewer.sid);
    expect(ids).toContain(ag.planner.sid);
    expect(await p.locator("#agl .agband .ptag").count()).toBe(0);
    await p.context().close();
  }, 60_000);

  it("a phone, 390 px: the same bands, each row 64 px or more, no sideways scroll", async () => {
    if (skip()) return;
    const p = await open("/agents", 390);
    const heights = await p.$$eval("#agl .agband button.agr", (bs) =>
      bs.map((b) => b.getBoundingClientRect().height),
    );
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(64);
    expect(
      await p.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await p.context().close();
  }, 60_000);
});
