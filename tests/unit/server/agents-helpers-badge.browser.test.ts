/**
 * #80 (0.4.45): an agent's helpers are a badge you open, not rows that
 * jump in. Before, the agent in front showed its helpers as rows under it,
 * so the list moved each time one started or ended. Now:
 *
 *   1. Closed by default, the agent in front too; a reload starts closed.
 *   2. The badge is a toggle button (aria-expanded). Open, it shows the
 *      first agents.helpers_shown (default 3) running helpers, in start
 *      order, oldest first.
 *   3. More running: "Show all (M)" opens the Helpers list. A helper that
 *      starts later never moves the rows already shown.
 *   4. Open stays open across the list's refreshes.
 *   5. The dot doesn't pulse under reduced motion.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY. The helpers are Claude Code's files on disk, written here.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

const TOKEN = "00000000-0000-4000-8000-0000000000e1";
let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";
let sessionFrom = 0;
let n = 0;

/** The helpers' folder of agent "many". */
const dir = () =>
  path.join(
    s.tmp,
    "home",
    ".claude",
    "projects",
    "-seeded",
    TOKEN,
    "subagents",
  );

/** A running helper that started `secondsAgo` ago; its id. */
function helper(secondsAgo: number): string {
  const id = `aef0c0ffee0000${String(100 + n++).padStart(3, "0")}`;
  fs.writeFileSync(
    path.join(dir(), `agent-${id}.meta.json`),
    JSON.stringify({ agentType: "Explore", description: `job ${id}` }),
  );
  const at = new Date(
    Math.max(Date.now() - secondsAgo * 1000, sessionFrom),
  ).toISOString();
  fs.writeFileSync(
    path.join(dir(), `agent-${id}.jsonl`),
    JSON.stringify({
      type: "user",
      isSidechain: true,
      agentId: id,
      timestamp: at,
      message: { role: "user", content: `job ${id}` },
    }) + "\n",
  );
  return id;
}

/** Oldest first: the order an open badge shows them in. */
const started: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:many",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  sessionFrom = Date.parse(info.startedAt) + 1;
  sid = info.ref.id;
  s.seed({
    id: "many",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:many",
    resumeToken: TOKEN,
  });
  fs.mkdirSync(dir(), { recursive: true });
  // Wait a moment so the helpers' times fall after the session's start.
  await new Promise((r) => setTimeout(r, 1200));
  // Six running, written newest first; started holds them oldest first.
  for (let i = 0; i < 6; i++) started.unshift(helper(i * 0.1));
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

async function open(width = 1280): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  // "many" in front: before 0.4.45 its helpers showed as rows by now.
  await p.goto(
    signInUrl(s.stateDir, s.base, `/agents?open=${sid}&layout=focus`),
  );
  await p.waitForSelector(`#agl .agr-hpb[data-agent="many"]`, {
    timeout: 20_000,
  });
  // This version's release notes open once over a new browser: seen.
  await p.evaluate(() =>
    (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
  );
  return p;
}

const toggle = (p: Page) => p.locator(`#agl .agr-hpb[data-agent="many"]`);
const rows = (p: Page) =>
  p.$$eval('#agl .aghs[data-helpers-of="many"] button.agh', (xs) =>
    xs.map((x) => (x as HTMLElement).dataset.helper),
  );

describe("#80: helpers are a badge you open", () => {
  it("closed by default, the agent in front too: no rows until the badge is pressed", async () => {
    if (!browser) return;
    const p = await open();
    await expect(toggle(p).getAttribute("aria-expanded")).resolves.toBe(
      "false",
    );
    await expect(toggle(p).textContent()).resolves.toContain("6 helpers");
    await p.waitForTimeout(500);
    expect(await rows(p)).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("open: the first 3 running, oldest first, then Show all (6), which opens the list", async () => {
    if (!browser) return;
    const p = await open();
    await toggle(p).click();
    await p.waitForSelector('#agl .aghs[data-helpers-of="many"] button.agh');
    await expect(toggle(p).getAttribute("aria-expanded")).resolves.toBe("true");
    expect(await rows(p)).toEqual(started.slice(0, 3));
    const all = p.locator('#agl .aghs[data-helpers-of="many"] .aghs-all');
    await expect(all.textContent()).resolves.toBe("Show all (6)");
    await all.click();
    await p.locator("#hp-body button.agh").first().waitFor();
    expect(await p.locator("#hp-body button.agh").count()).toBe(6);
    await p.keyboard.press("Escape");
    await p.waitForFunction(
      () => !(document.getElementById("hp-dlg") as HTMLDialogElement)?.open,
    );
    // Pressed again: closed.
    await toggle(p).click();
    await p.waitForSelector('#agl .aghs[data-helpers-of="many"]', {
      state: "detached",
    });
    await p.context().close();
  }, 60_000);

  it("a helper that starts later never moves the rows shown; open survives the refresh, a reload starts closed", async () => {
    if (!browser) return;
    const p = await open();
    await toggle(p).click();
    await p.waitForSelector('#agl .aghs[data-helpers-of="many"] button.agh');
    const before = await rows(p);
    started.push(helper(0));
    // The list's poll picks it up: the count changes in place.
    await p.waitForFunction(
      () =>
        /7 helpers/.test(
          document.querySelector('#agl .agr-hpb[data-agent="many"]')
            ?.textContent ?? "",
        ),
      undefined,
      { timeout: 20_000 },
    );
    expect(await rows(p)).toEqual(before);
    await expect(
      p.locator('#agl .aghs[data-helpers-of="many"] .aghs-all').textContent(),
    ).resolves.toBe("Show all (7)");
    await expect(toggle(p).getAttribute("aria-expanded")).resolves.toBe("true");
    await p.reload();
    await toggle(p).waitFor();
    await expect(toggle(p).getAttribute("aria-expanded")).resolves.toBe(
      "false",
    );
    expect(await rows(p)).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("agents.helpers_shown sets how many: 1 shows one", async () => {
    if (!browser) return;
    expect(await s.settings({ agents_helpers_shown: 1 })).toBe(200);
    try {
      const p = await open();
      await toggle(p).click();
      await p.waitForSelector('#agl .aghs[data-helpers-of="many"] button.agh');
      expect(await rows(p)).toEqual(started.slice(0, 1));
      await p.context().close();
    } finally {
      await s.settings({ agents_helpers_shown: null });
    }
  }, 60_000);

  it("the badge's dot doesn't pulse under reduced motion", async () => {
    if (!browser) return;
    const p = await open();
    const anim = await toggle(p)
      .locator(".hp-dot")
      .evaluate((d) => getComputedStyle(d).animationName);
    expect(anim).toBe("none");
    await p.context().close();
  }, 60_000);
});
