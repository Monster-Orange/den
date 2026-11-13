/**
 * The Workspaces page's Agents section (AG-4a, AG spec §5c) in a real
 * browser: under the repo table, one row per agent of the selected
 * workspace (persona and id, runtime, state, cwd, started at), Stop, and
 * Resume where the record allows it; "+ Start agent" picks a persona and a
 * runtime and calls the start route; the workspace header counts the
 * agents. The header links to the Agents page ("Open in Agents →", for
 * the workspace) and a row with a session has Open (its terminal there,
 * AG-4a-term). In ja too. Each
 * page signs in first (SEC-1b: Start and Resume are shell-grade).
 *
 * The real server on the demo distribution with a session host in this
 * process (helpers/agents-page-server.ts): a scripted PTY, so nothing an
 * agent starts runs, and a `claude` shim that must never run. Invented
 * names only (north, south).
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import type { Browser, Page } from "playwright";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let latest = "";
// The server checks the PTY module is there before it asks the host.
const PTY = loadPty().available;

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
  // Two records as `agents start` leaves them, their sessions gone (a
  // reboot): one in each workspace.
  // Each with its conversation's token: only then can it resume (AG-14.2).
  s.seed({
    id: "scout",
    persona: "reviewer",
    workspace: "north",
    resumeToken: "55555555-5555-4555-8555-555555555555",
  });
  s.seed({
    id: "lookout",
    persona: "devops",
    workspace: "south",
    resumeToken: "66666666-6666-4666-8666-666666666666",
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

/** Workspaces for `ws`, its Agents section listed, the lock known. */
async function open(ws: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript((v) => {
    try {
      // No What's new dialog over the page: its latest version is seen.
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  // SEC-1b: Start and Resume are shell-grade, so the browser signs in as a
  // person does, through a one-time /auth link (never a bypass).
  await p.goto(signInUrl(s!.stateDir, s!.base, `/?ws=${ws}`));
  await p.waitForSelector(
    `#agents-section[data-ws="${ws}"] #agent-table tbody tr:not(.tbl-none), #agents-section[data-ws="${ws}"] #agent-table tbody tr.tbl-none td:not(:empty)`,
    { timeout: 20_000 },
  );
  await p.waitForSelector("#ws-agents-count:not([hidden])");
  return p;
}

const row = (p: Page, id: string) =>
  p.locator(`#agent-table tr.agent[data-agent="${id}"]`);
const cells = (p: Page, id: string) =>
  row(p, id).locator("th, td").allTextContents();

describe("the Agents section", () => {
  it("renders a seeded record's row: persona and id, runtime, state, cwd, started at; Resume only, as it may resume", async () => {
    if (skip()) return;
    const p = await open("north");
    await row(p, "scout").waitFor();
    const [agent, runtime, state, cwd, started, acts] = await cells(p, "scout");
    expect(agent.replace(/\s+/g, " ").trim()).toBe("scout persona reviewer");
    expect(runtime.trim()).toBe("den-claude");
    expect(state.trim()).toBe("interrupted");
    expect(cwd.trim()).toBe(s!.wsDir("north"));
    // The page's own format of the record's startedAt: a date, not "—".
    expect(started.trim()).not.toBe("—");
    expect(started.trim()).toMatch(/\d/);
    expect(acts.trim()).toBe("Resume");
    expect(
      await row(p, "scout")
        .getByRole("button", { name: "Resume scout" })
        .count(),
    ).toBe(1);
    // The repo table's look, measured: heads, cells and the frame
    // compute the same as the repo table's.
    const look = (sel: string) =>
      p.$eval(sel, (el) => {
        const cs = getComputedStyle(el);
        return [
          cs.fontFamily,
          cs.fontSize,
          cs.fontWeight,
          cs.textTransform,
          cs.letterSpacing,
          cs.color,
          cs.paddingTop,
          cs.paddingLeft,
          cs.borderBottomWidth,
          cs.borderRadius,
          cs.backgroundColor,
        ].join(" | ");
      });
    for (const [mine, theirs] of [
      ["#agent-table thead th", "#repo-table thead th"],
      ["#agent-table tbody tr.agent > th", "#repo-table tbody tr.repo > th"],
      [
        "#agent-table tbody tr.agent .repo-name",
        "#repo-table tbody tr.repo .repo-name",
      ],
      ["#agents-section .tablewrap", "#repo-table"],
    ])
      expect(await look(mine)).toBe(
        await look(
          theirs === "#repo-table" ? ".tablewrap:has(#repo-table)" : theirs,
        ),
      );
    // The section sits under the repo table.
    const [tbl, sec] = await Promise.all([
      p.locator("#repo-table").boundingBox(),
      p.locator("#agents-section").boundingBox(),
    ]);
    expect(sec!.y).toBeGreaterThan(tbl!.y + tbl!.height);
    await p.context().close();
  }, 45_000);

  it("lists a workspace's own agents only: south's never under north", async () => {
    if (skip()) return;
    const north = await open("north");
    expect(await row(north, "lookout").count()).toBe(0);
    expect(await north.locator("#agents-section").textContent()).not.toContain(
      "lookout",
    );
    await north.context().close();
    const south = await open("south");
    await row(south, "lookout").waitFor();
    expect(await row(south, "scout").count()).toBe(0);
    await south.context().close();
  }, 45_000);

  it("links to the Agents page: Open in Agents → for the workspace; no Open on a row without a session", async () => {
    if (skip()) return;
    const p = await open("north");
    const sec = p.locator("#agents-section");
    const all = sec.getByRole("link", { name: "Open in Agents →" });
    expect(await all.getAttribute("href")).toBe("/agents?project=north");
    // scout's session is gone: nothing to open.
    expect(await row(p, "scout").getByRole("link").count()).toBe(0);
    expect(
      await sec
        .locator("[data-agent-act]")
        .evaluateAll((bs) =>
          bs.map((b) => (b as HTMLElement).dataset.agentAct),
        ),
    ).toEqual(["resume"]);
    expect(await p.locator(".xterm, [data-terminal]").count()).toBe(0);
    await p.context().close();
  }, 45_000);

  it('counts the agents in the workspace header ("1 agent", "n agents")', async () => {
    if (skip()) return;
    const p = await open("south");
    expect((await p.textContent("#ws-agents-count"))?.trim()).toBe("1 agent");
    // In the header (R24c), before "Open in Graph →".
    const [count, link] = await Promise.all([
      p.locator(".content-header #ws-agents-count").boundingBox(),
      p.locator(".content-header #ws-open-graph").boundingBox(),
    ]);
    expect(count!.x).toBeLessThan(link!.x);
    await p.context().close();
  }, 45_000);

  it("Start via the form calls the start route; the new row runs, and Stop updates it", async () => {
    if (skip() || !PTY) return;
    const p = await open("north");
    const before = Number(
      (await p.textContent("#ws-agents-count"))!.match(/\d+/)![0],
    );
    await p.click("#agent-start-open");
    // (An option is never "visible": attached is what a filled list is.)
    await p.waitForSelector(
      '#agent-start-form:not([hidden]) select[name="persona"] option[value="planner"]',
      { state: "attached" },
    );
    await p.selectOption('#agent-start-form select[name="persona"]', "planner");
    await p.selectOption(
      '#agent-start-form select[name="runtime"]',
      "den-claude",
    );
    const [req, res] = await Promise.all([
      p.waitForRequest(
        (r) =>
          r.method() === "POST" &&
          new URL(r.url()).pathname === "/api/workspaces/north/agents",
      ),
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/workspaces/north/agents",
        { timeout: 20_000 },
      ),
      p.click("#agent-start-go"),
    ]);
    expect(JSON.parse(req.postData() ?? "{}")).toEqual({
      persona: "planner",
      runtime: "den-claude",
    });
    expect(res.status()).toBe(200);
    await p.waitForSelector(
      '#agent-table tr.agent[data-agent="planner"][data-state="running"]',
    );
    // An id that is its persona still says so, like every other row
    // (0.4.1-dev.1, a consumer's nit).
    const [named] = await cells(p, "planner");
    expect(named.replace(/\s+/g, " ").trim()).toBe("planner persona planner");
    expect(s!.made).toHaveLength(1);
    expect(s!.made[0].opts.cwd).toBe(s!.wsDir("north"));
    expect(fs.existsSync(s!.ran)).toBe(false);
    await p.waitForFunction(
      (n) =>
        document.getElementById("ws-agents-count")?.textContent?.trim() ===
        `${n} agents`,
      before + 1,
    );
    // A running agent has a session: Open, its terminal on the Agents page.
    const { sessionId } = (
      (await res.json()) as { agent: { sessionId: string } }
    ).agent;
    expect(sessionId).toEqual(expect.any(String));
    expect(
      await row(p, "planner")
        .getByRole("link", { name: "Open planner in Agents" })
        .getAttribute("href"),
    ).toBe(`/agents?open=${encodeURIComponent(sessionId)}`);
    // A running agent: Stop, no Resume.
    expect(
      await row(p, "planner")
        .locator("[data-agent-act]")
        .evaluateAll((bs) =>
          bs.map((b) => (b as HTMLElement).dataset.agentAct),
        ),
    ).toEqual(["stop"]);

    // Stop: TERM to its session; the answer comes once the session has
    // exited (0.4.8), and the row says stopped.
    const kill = s!.made[0].kill.bind(s!.made[0]);
    s!.made[0].kill = (sig: string) => {
      kill(sig);
      setTimeout(() => s!.made[0].exit(143), 300);
    };
    const stopped = p.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
        "/api/workspaces/north/agents/planner/stop",
    );
    await row(p, "planner")
      .getByRole("button", { name: "Stop planner" })
      .click();
    expect((await stopped).status()).toBe(200);
    expect(s!.made[0].signals).toContain("SIGTERM");
    await p.waitForSelector(
      '#agent-table tr.agent[data-agent="planner"][data-state="stopped"]',
      { timeout: 15_000 },
    );
    expect(
      (await row(p, "planner").locator("td").nth(1).textContent())?.trim(),
    ).toBe("stopped");
    expect(
      await row(p, "planner")
        .getByRole("button", { name: "Resume planner" })
        .count(),
    ).toBe(1);
    await p.context().close();
  }, 60_000);

  it("is in Japanese when the UI is", async () => {
    if (skip()) return;
    expect(await s!.settings({ language: "ja" })).toBe(200);
    try {
      const p = await open("south");
      expect((await p.textContent("#agents-h"))?.trim()).toBe("エージェント");
      expect((await p.textContent("#ws-agents-count"))?.trim()).toBe(
        "エージェント 1 件",
      );
      expect(
        await p.$$eval("#agent-table thead th", (ths) =>
          ths.map((th) => th.textContent?.trim()),
        ),
      ).toEqual([
        "エージェント",
        "ランタイム",
        "状態",
        "ディレクトリ",
        "開始",
        "操作",
      ]);
      const [agent, , state, , , acts] = await cells(p, "lookout");
      expect(agent.replace(/\s+/g, " ").trim()).toBe("lookout ペルソナ devops");
      expect(state.trim()).toBe("中断");
      expect(acts.trim()).toBe("再開");
      expect((await p.textContent("#agent-start-open"))?.trim()).toBe(
        "+ エージェントを開始",
      );
      await p.context().close();
    } finally {
      await s!.settings({ language: null });
    }
  }, 45_000);
});
