/**
 * Issue 225: Settings › Project › Agents' mode. Each agent's actual mode
 * and where it comes from ("from its own setting", "from the project");
 * a process in another mode says "Runs as … until restarted". Changing
 * the project's mode sends it through the working pop-up; with agents
 * that have their own setting, "Also apply to the N agents with their own
 * setting" is offered with the right N and, pressed, sends follow and the
 * list then shows them following the project.
 *
 * The demo distribution (helpers/agents-page-server.ts), the agent-modes
 * route answered by the test (a stateful fake). Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = process.env.DEN_PW_WS
      ? await chromium.connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await chromium.launch();
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
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

interface AgentMode {
  agent: string;
  mode: string;
  source: string;
  running?: string;
}

/** A project on edits: lead follows, scout runs as ask, two own settings. */
function fakeServer() {
  const st = {
    mode: "edits" as string | null,
    agents: [
      { agent: "lead", mode: "edits", source: "project" },
      { agent: "scout", mode: "edits", source: "project", running: "ask" },
      { agent: "pinned", mode: "ask", source: "own", own: "ask" },
      { agent: "quiet", mode: "all", source: "own", own: "all" },
    ] as (AgentMode & { own?: string })[],
  };
  const view = () => ({
    ok: true,
    project: "north",
    mode: st.mode,
    install: null,
    agents: st.agents.map(({ own, ...a }) => {
      void own;
      return a;
    }),
    own: st.agents.filter((a) => a.source === "own").length,
  });
  const posts: unknown[] = [];
  const answer = (method: string, body: { mode?: string; follow?: true }) => {
    if (method !== "POST") return view();
    posts.push(body);
    if (body.mode !== undefined) {
      st.mode = body.mode;
      for (const a of st.agents)
        if (a.source === "project") a.mode = body.mode ?? "ask";
    }
    if (body.follow)
      for (const a of st.agents)
        if (a.source === "own") {
          a.source = "project";
          a.mode = st.mode ?? "ask";
          delete a.own;
        }
    return { ...view(), followed: [] };
  };
  return { answer, posts };
}

async function page(): Promise<{ p: Page; posts: unknown[] }> {
  const ctx = await browser!.newContext({
    viewport: { width: 375, height: 900 },
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
  const f = fakeServer();
  await p.route("**/api/workspaces/*/agent-modes", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        f.answer(
          r.request().method(),
          (r.request().postDataJSON() ?? {}) as { mode?: string },
        ),
      ),
    }),
  );
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings?ws=north#workspace"));
  await p.waitForSelector(
    '[data-setting="workspace.agents_mode"] [data-pmode-list]',
  );
  return { p, posts: f.posts };
}

const ROW = '[data-setting="workspace.agents_mode"]';
const lines = (p: Page) =>
  p.$$eval(`${ROW} [data-pmode-agent]`, (els) =>
    els.map((e) => (e.textContent ?? "").trim()),
  );

describe("issue 225: Settings › Project › Agents' mode", () => {
  it("shows each agent's mode and its source; Runs as … until restarted", async () => {
    if (skip()) return;
    const { p } = await page();
    expect(await lines(p)).toEqual([
      "lead: Edits, from the project",
      "scout: Edits, from the project. Runs as Ask until restarted.",
      "pinned: Ask, from its own setting",
      "quiet: All, from its own setting",
    ]);
    expect(
      await p.getAttribute(`${ROW} [data-pmode="edits"]`, "aria-pressed"),
    ).toBe("true");
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);

  it("a change offers to apply to the N agents with their own setting; pressed, they follow", async () => {
    if (skip()) return;
    const { p, posts } = await page();
    await p.click(`${ROW} [data-pmode="auto"]`);
    await p.waitForFunction(
      (sel) =>
        document
          .querySelector(`${sel} [data-pmode="auto"]`)
          ?.getAttribute("aria-pressed") === "true",
      ROW,
    );
    expect(posts).toEqual([{ mode: "auto" }]);
    expect(
      await p.getAttribute(`${ROW} [data-pmode-offer]`, "data-pmode-offer"),
    ).toBe("2");
    expect((await p.textContent(`${ROW} [data-pmode-follow]`))?.trim()).toBe(
      "Also apply to the 2 agents with their own setting",
    );
    await p.click(`${ROW} [data-pmode-follow]`);
    await p.waitForFunction(
      (sel) => !document.querySelector(`${sel} [data-pmode-offer]`),
      ROW,
    );
    expect(posts).toEqual([{ mode: "auto" }, { follow: true }]);
    expect(await lines(p)).toEqual([
      "lead: Auto, from the project",
      "scout: Auto, from the project. Runs as Ask until restarted.",
      "pinned: Auto, from the project",
      "quiet: Auto, from the project",
    ]);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);
});
