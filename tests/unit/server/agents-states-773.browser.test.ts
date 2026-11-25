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
import { denAuth } from "./helpers/den-auth.js";
import { signInPage } from "./helpers/signed-in.js";
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
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
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

/** `by`: the list view saved before the first load (den-agents-by). */
async function open(path: string, width = 1280, by?: string): Promise<Page> {
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
  if (by)
    await ctx.addInitScript((v) => {
      // Once: a reload keeps what the page saved.
      if (sessionStorage.getItem("t-by-set")) return;
      sessionStorage.setItem("t-by-set", "1");
      localStorage.setItem("den-agents-by", v);
    }, by);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await signInPage(p, s!.stateDir, s!.base, path);
  await p.waitForSelector(
    by === "project" ? "#agl .wsg[data-ws]" : "#agl [data-band]",
    { timeout: 20_000 },
  );
  return p;
}

/**
 * The bands as the list shows them, [state, [session ids]], with only this
 * test's agents (an install's own server agent may be listed too).
 */
async function bands(p: Page): Promise<[string, string[]][]> {
  const all = await p.$$eval("#agl [data-band]", (bs) =>
    bs.map(
      (b) =>
        [
          (b as HTMLElement).dataset.band ?? "",
          [...b.querySelectorAll("button[data-kind]")].map(
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
      () => document.querySelectorAll("#agl [data-band]").length >= 4,
      null,
      { timeout: 20_000 },
    );
    expect(await bands(p)).toEqual([
      ["needs", [ag.planner.sid]],
      ["done", [ag.builder.sid]],
      ["working", [ag.reviewer.sid]],
      ["idle", [ag.scribe.sid]],
    ]);
    // Each band headed by its word (its own heading id), then its count.
    expect(
      await p.$$eval('#agl [data-band] [id^="agb-"]', (hs) =>
        hs.map((h) => h.id),
      ),
    ).toEqual(["agb-needs", "agb-done", "agb-working", "agb-idle"]);
    expect(await p.textContent('#agl [data-band="needs"] [data-count]')).toBe(
      "1",
    );
    const row = (k: string) => p.locator(`#agl button[data-id="${ag[k].sid}"]`);
    // The marks: their own shape and sign.
    const mark = (k: string, st: string) =>
      row(k).locator(`[data-mark="${st}"]`);
    expect(await mark("planner", "needs").textContent()).toBe("!");
    expect(await mark("builder", "done").textContent()).toBe("✓");
    expect(await mark("reviewer", "working").count()).toBe(1);
    expect(await mark("scribe", "idle").count()).toBe(1);
    // The chips (their words: agent-bands-773.test.ts).
    const chip = (k: string) =>
      row(k).locator("[data-attn]").getAttribute("data-attn");
    expect(await chip("planner")).toBe("needs");
    expect(await chip("builder")).toBe("done");
    expect(await chip("reviewer")).toBe("working");
    expect(await chip("scribe")).toBe("idle");
    // Each row has its project tag.
    const tag = (k: string) => row(k).locator('[data-ptag="project"]');
    expect(await tag("planner").textContent()).toBe("north");
    expect(await tag("reviewer").textContent()).toBe("south");
    // Line 2 as mock v3 draws it: what a need asks, and Needs you's and
    // Working's time with no "ago" ("3 min"; just now: "now").
    const meta = async (k: string) =>
      ((await row(k).locator("[data-meta]").textContent()) ?? "").replace(
        (await tag(k).textContent()) ?? "",
        "",
      );
    expect(await meta("planner")).toMatch(
      /^Claude Code · asks to run a command · (now|\d+ min)$/,
    );
    expect(await meta("reviewer")).toMatch(/^Claude Code · (now|\d+ min)$/);
    // Done's line: the page's own "finished {ago}" words.
    const finished = await p.evaluate(() =>
      (
        window as unknown as { denMessages: { en: Record<string, string> } }
      ).denMessages.en["ag.meta.finished"].replace(/\{ago\}.*/, ""),
    );
    expect(
      (await meta("builder")).startsWith(`Claude Code · ${finished}`),
    ).toBe(true);
    // Mock v3's rows and list: 9px 12px 9px 10px, gap 2px 10px, a
    // hairline on top of every row; the list 380 px at 1280.
    const css = await row("scribe").evaluate((el) => {
      const c = getComputedStyle(el);
      return [c.padding, c.rowGap, c.columnGap, c.borderTopWidth].join(" / ");
    });
    expect(css).toBe("9px 12px 9px 10px / 2px / 10px / 1px");
    const w = await p
      .locator("#agl")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(w - 380)).toBeLessThanOrEqual(1);
    // The sub-line: each state above zero.
    const sub = (await p.textContent("#ag-count")) ?? "";
    expect(sub).toMatch(/^\d+ agents · /);
    expect(sub).toMatch(/\b1 needs\b/);
    expect(sub).toMatch(/\b1 done\b/);
    expect(sub).toContain("1 working");
    expect(sub).toMatch(/\d+ idle/);
    // The rail's Agents count: Needs you, an amber (warn) pill.
    const pill = p.locator('[data-nav="agents"] [data-badge]');
    expect(await pill.getAttribute("data-badge")).toBe("warn");
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
        .locator(`[data-sec="done"] [data-agent="${ag.builder.id}"]`)
        .count(),
    ).toBe(1);
    await p.context().close();
  }, 60_000);

  it("Done turns into Idle when the person opens the agent; the Done band goes; a reload keeps it", async () => {
    if (skip()) return;
    const p = await open("/agents");
    await p.click(`#agl button[data-id="${ag.builder.sid}"]`);
    await p.waitForFunction(
      () => !document.querySelector('#agl [data-band="done"]'),
      null,
      { timeout: 10_000 },
    );
    const idle = await bands(p);
    expect(idle.map(([b]) => b)).toEqual(["needs", "working", "idle"]);
    expect(idle.find(([b]) => b === "idle")![1]).toContain(ag.builder.sid);
    expect(await p.locator('#agl [data-band="done"]').count()).toBe(0);
    await p.reload();
    await p.waitForSelector('#agl:not([aria-busy]) [data-band="idle"]', {
      timeout: 20_000,
    });
    expect((await bands(p)).map(([b]) => b)).toEqual([
      "needs",
      "working",
      "idle",
    ]);
    await p.context().close();
  }, 60_000);

  it("By need is the default; By project groups by project, each sorted by need; the choice is kept", async () => {
    if (skip()) return;
    const p = await open("/agents");
    const sw = "#agl [data-by-switch]";
    expect(await p.getAttribute(`${sw} [data-by="need"]`, "aria-pressed")).toBe(
      "true",
    );
    await p.click(`${sw} [data-by="project"]`);
    await p.waitForSelector("#agl .wsg[data-ws]", { timeout: 20_000 });
    expect(await p.locator("#agl [data-band]").count()).toBe(0);
    const need = [ag.planner, ag.builder, ag.reviewer, ag.scribe].map(
      (a) => a.sid,
    );
    const groups = await p.$$eval("#agl .wsg[data-ws]", (gs) =>
      gs.map((g) =>
        [...g.querySelectorAll("button[data-kind]")].map(
          (r) => (r as HTMLElement).dataset.id ?? "",
        ),
      ),
    );
    const mine = groups
      .map((ids) => ids.filter((x) => need.includes(x)))
      .filter((ids) => ids.length > 0);
    expect(mine.flat().sort()).toEqual([...need].sort());
    for (const ids of mine)
      expect(ids).toEqual(need.filter((x) => ids.includes(x)));
    await p.reload();
    await p.waitForSelector("#agl .wsg[data-ws]", { timeout: 20_000 });
    expect(
      await p.getAttribute(`${sw} [data-by="project"]`, "aria-pressed"),
    ).toBe("true");
    await p.click(`${sw} [data-by="need"]`);
    await p.waitForSelector("#agl [data-band]", { timeout: 20_000 });
    await p.context().close();
  }, 60_000);

  it("a saved By project opens grouped by project", async () => {
    if (skip()) return;
    const p = await open("/agents", 1280, "project");
    expect(
      await p.getAttribute(
        '#agl [data-by-switch] [data-by="project"]',
        "aria-pressed",
      ),
    ).toBe("true");
    expect(await p.locator("#agl .wsg[data-ws]").count()).toBeGreaterThan(0);
    expect(await p.locator("#agl [data-band]").count()).toBe(0);
    await p.context().close();
  }, 60_000);

  it("a saved By group with no Hub groups: no By group button, By need, the choice kept", async () => {
    if (skip()) return;
    const p = await open("/agents", 1280, "group");
    const sw = "#agl [data-by-switch]";
    expect(await p.locator(`${sw} [data-by="group"]`).count()).toBe(0);
    expect(await p.getAttribute(`${sw} [data-by="need"]`, "aria-pressed")).toBe(
      "true",
    );
    expect(await p.locator("#agl [data-band]").count()).toBeGreaterThan(0);
    expect(await p.evaluate(() => localStorage.getItem("den-agents-by"))).toBe(
      "group",
    );
    await p.context().close();
  }, 60_000);

  it("one project: only its agents, no project tag", async () => {
    if (skip()) return;
    const p = await open("/agents?ws=north");
    await p.waitForSelector("#agl:not([aria-busy]) [data-band]", {
      timeout: 20_000,
    });
    const ids = (await bands(p)).flatMap(([, rows]) => rows);
    expect(ids).not.toContain(ag.reviewer.sid);
    expect(ids).toContain(ag.planner.sid);
    expect(await p.locator("#agl [data-band] [data-ptag]").count()).toBe(0);
    await p.context().close();
  }, 60_000);

  it("a phone, 390 px: the same bands, each row 64 px or more, no sideways scroll", async () => {
    if (skip()) return;
    const p = await open("/agents", 390);
    const heights = await p.$$eval("#agl [data-band] button[data-kind]", (bs) =>
      bs.map((b) => b.getBoundingClientRect().height),
    );
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(64);
    // Mock v3's card: the chip says just "Needs you"; line 2 is the tag
    // and the detail (no runtime, no time for Needs you); a › at the right.
    const row = (k: string) => p.locator(`#agl button[data-id="${ag[k].sid}"]`);
    const seen = (el: import("playwright").Locator) => el.innerText();
    // The words are the page's own (its i18n keys), not English here.
    const words = await p.evaluate(() => {
      const en = (
        window as unknown as {
          denMessages: Record<string, Record<string, string>>;
        }
      ).denMessages.en;
      return { needs: en["ag.chip.needs"], command: en["ag.whyLong.command"] };
    });
    const chipEl = row("planner").locator("[data-attn]");
    expect(await chipEl.getAttribute("data-attn")).toBe("needs");
    expect((await seen(chipEl)).trim()).toBe(words.needs);
    expect((await seen(row("planner").locator("[data-meta]"))).trim()).toBe(
      `north${words.command}`,
    );
    expect((await seen(row("reviewer").locator("[data-meta]"))).trim()).toMatch(
      /^south(now|\d+ min)$/,
    );
    expect(await row("planner").locator("[data-chev]").isVisible()).toBe(true);
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
