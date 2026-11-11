/**
 * D32: the helpers an agent starts in its own session, on the agents page,
 * from Claude Code's files on disk through the real routes (no mocked
 * route):
 *
 *   - under the agent's row: one row per recent helper, the running one
 *     first, and "All helpers (n)" with a running count;
 *   - a helper's row opens its transcript, read-only, in a dialog that
 *     says why Den can't steer it, and Escape gives focus back;
 *   - the pane bar's "Helpers (n)" opens the list;
 *   - the rail's Agents item carries the running count;
 *   - at 375 px nothing scrolls sideways; no page errors.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts). The helpers: the scrubbed
 * real-shape fixture (finished) and one written here, active now.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  shownDepths,
  sortHelpers,
  type Helper,
} from "../../../src/shared/agents/helpers.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

const FIXTURE = path.resolve(
  __dirname,
  "../../fixtures/claude-helpers/real-shape",
);
const DONE = "a1f0c0ffee0000001";
const LIVE = "a2f0c0ffee0000002";
const PARENT = "a5f0c0ffee0000005";
const CHILD = "a6f0c0ffee0000006";
const TOKEN = "00000000-0000-4000-8000-0000000000d3";

let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";

function writeHelpers(): void {
  const dir = path.join(
    s.tmp,
    "home",
    ".claude",
    "projects",
    "-seeded",
    TOKEN,
    "subagents",
  );
  fs.mkdirSync(dir, { recursive: true });
  for (const ext of ["meta.json", "jsonl"])
    fs.copyFileSync(
      path.join(FIXTURE, `agent-${DONE}.${ext}`),
      path.join(dir, `agent-${DONE}.${ext}`),
    );
  fs.writeFileSync(
    path.join(dir, `agent-${LIVE}.meta.json`),
    JSON.stringify({
      agentType: "Explore",
      description: "Read the south logs",
      toolUseId: "toolu_FIXTURE02",
      spawnDepth: 1,
      requestShape: "background",
      model: "haiku",
    }),
  );
  const at = (dt: number) => new Date(Date.now() - dt).toISOString();
  const line = (o: object) => JSON.stringify(o) + "\n";
  fs.writeFileSync(
    path.join(dir, `agent-${LIVE}.jsonl`),
    line({
      type: "user",
      isSidechain: true,
      agentId: LIVE,
      timestamp: at(20_000),
      message: { role: "user", content: "Read the south logs <b>now</b>" },
    }) +
      line({
        type: "assistant",
        isSidechain: true,
        agentId: LIVE,
        timestamp: at(10_000),
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_L1",
              name: "Grep",
              input: { pattern: "ERROR", path: "logs" },
            },
          ],
        },
      }),
  );
}

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
    name: "acme-north:scout",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  sid = info.ref.id;
  s.seed({
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:scout",
    resumeToken: TOKEN,
  });
  writeHelpers();
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

async function open(width = 1280) {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
  });
  const p: Page = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${s.base}/agents?open=${sid}&layout=tabs`);
  await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
  // This version's release notes open once over a new browser: seen.
  await p.evaluate(() =>
    (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
  );
  return { p, errors };
}

describe("an agent's helpers on the agents page (D32)", () => {
  it("rows under the agent, running first; a row opens its transcript, read-only", async () => {
    if (!browser) return;
    const { p, errors } = await open();
    const group = p.locator('#agl .aghs[data-helpers-of="scout"]');
    await group.waitFor({ timeout: 15_000 });
    const rows = group.locator("button.agh");
    // The finished one is long done: folded away (collapse_done_minutes),
    // still counted under "All helpers".
    expect(
      await rows.evaluateAll((b) => b.map((x) => x.dataset.helper)),
    ).toEqual([LIVE]);
    expect(await rows.first().getAttribute("data-status")).toBe("running");
    expect(await group.locator(".aghs-all").textContent()).toContain("2");
    expect(await group.locator(".aghs-all .hpbdg").textContent()).toBe("1");

    await rows.first().click();
    const dlg = p.locator("#tx-dlg");
    await dlg.locator(".tx-list").waitFor({ timeout: 10_000 });
    expect(await dlg.locator("#tx-h").textContent()).toContain(
      "Read the south logs",
    );
    // The prompt is text, never markup.
    expect(await dlg.locator(".tx-prompt .tx-t").textContent()).toContain(
      "<b>now</b>",
    );
    expect(await dlg.locator(".tx-prompt b").count()).toBe(0);
    expect(await dlg.locator(".tx-tool .tx-k").textContent()).toBe("Grep");
    expect(await dlg.locator("#tx-note").textContent()).toContain(
      "can't stop or steer them",
    );
    await p.keyboard.press("Escape");
    await p.waitForFunction(
      () => !(document.getElementById("tx-dlg") as HTMLDialogElement).open,
    );
    expect(
      await p.evaluate(() =>
        document.activeElement?.getAttribute("data-helper"),
      ),
    ).toBe(LIVE);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("the pane bar's Helpers button lists them; the rail's Agents item counts the running one", async () => {
    if (!browser) return;
    const { p, errors } = await open();
    const btn = p.locator(`.pane[data-id="${sid}"] [data-act="helpers"]`);
    await btn.waitFor({ timeout: 15_000 });
    expect(await btn.locator(".hpbdg").textContent()).toBe("1");
    await btn.click();
    const body = p.locator("#hp-body");
    await body.locator("button.agh").first().waitFor({ timeout: 10_000 });
    expect(await body.locator("button.agh").count()).toBe(2);
    expect(await p.locator("#hp-note").textContent()).toContain(
      "can't stop or steer them",
    );
    await p.keyboard.press("Escape");
    const rail = p.locator('[data-nav="agents"]');
    await rail.locator(".den-bdg").waitFor({ timeout: 15_000 });
    expect(await rail.locator(".den-bdg").textContent()).toBe("1");
    expect(await rail.getAttribute("aria-label")).toBe(
      "Agents, 1 helper running",
    );
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("Escape gives focus back even after the page redrew the opener (its poll)", async () => {
    if (!browser) return;
    const { p, errors } = await open();
    const replace = (sel: string) =>
      p.evaluate((s) => {
        const el = document.querySelector(s)!;
        el.replaceWith(el.cloneNode(true));
      }, sel);
    // The dialog's close event comes a task after Escape: wait for focus
    // to leave it (or a second), then say where it is.
    const focused = async () => {
      await p
        .waitForFunction(
          () =>
            !!document.activeElement &&
            document.activeElement !== document.body &&
            !document.activeElement.closest("dialog"),
          undefined,
          { timeout: 1_000 },
        )
        .catch(() => undefined);
      return p.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return a?.matches(".aghs-all")
          ? "all"
          : a?.matches("button.agh")
            ? `row:${a.dataset.helper}`
            : a?.matches('[data-act="helpers"]')
              ? "bar"
              : (a?.tagName ?? "none");
      });
    };
    // "All helpers": the list redraws while the dialog is open.
    const all = '#agl .aghs[data-helpers-of="scout"] .aghs-all';
    await p.locator(all).waitFor({ timeout: 15_000 });
    await p.click(all);
    await p.locator("#hp-body button.agh").first().waitFor();
    await replace(all);
    await p.keyboard.press("Escape");
    expect(await focused()).toBe("all");
    // A helper's row, and the pane bar's button, the same.
    const row = `#agl button.agh[data-helper="${LIVE}"]`;
    await p.click(row);
    await p.locator("#tx-dlg .tx-list").waitFor();
    await replace(row);
    await p.keyboard.press("Escape");
    expect(await focused()).toBe(`row:${LIVE}`);
    const bar = `.pane[data-id="${sid}"] [data-act="helpers"]`;
    await p.click(bar);
    await p.locator("#hp-body button.agh").first().waitFor();
    await replace(bar);
    await p.keyboard.press("Escape");
    expect(await focused()).toBe("bar");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("the rail's count on another page, from /api/sessions/helpers", async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${s.base}/settings`);
    await p
      .locator('[data-nav="agents"] .den-bdg')
      .waitFor({ timeout: 20_000 });
    expect(await p.locator('[data-nav="agents"] .den-bdg').textContent()).toBe(
      "1",
    );
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("at 375 px: rows and the transcript fit, nothing scrolls sideways", async () => {
    if (!browser) return;
    const { p, errors } = await open(375);
    const row = p.locator('.aghs[data-helpers-of="scout"] button.agh').first();
    await row.waitFor({ state: "attached", timeout: 15_000 });
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await p.locator("#tx-dlg .tx-list").waitFor({ timeout: 10_000 });
    const over = await p.evaluate(() => {
      const d = document.getElementById("tx-dlg")!.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        dlg: d.right - window.innerWidth,
      };
    });
    expect(over.page).toBeLessThanOrEqual(0);
    expect(over.dlg).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  // Last: it adds helpers (a done parent and its newer done child; neither
  // runs, so the counts above stay as they are).
  it("a helper's own helper sits under it, indented, not above it by start time", async () => {
    if (!browser) return;
    const dir = path.join(
      s.tmp,
      "home",
      ".claude",
      "projects",
      "-seeded",
      TOKEN,
      "subagents",
    );
    const at = (dt: number) => new Date(Date.now() - dt).toISOString();
    const write = (id: string, desc: string, dt: number, parent?: string) => {
      fs.writeFileSync(
        path.join(dir, `agent-${id}.meta.json`),
        JSON.stringify({
          agentType: "general-purpose",
          description: desc,
          spawnDepth: parent ? 2 : 1,
          ...(parent ? { parentAgentId: parent } : {}),
          finished: true,
        }),
      );
      fs.writeFileSync(
        path.join(dir, `agent-${id}.jsonl`),
        JSON.stringify({
          type: "user",
          isSidechain: true,
          agentId: id,
          timestamp: at(dt),
          message: { role: "user", content: desc },
        }) + "\n",
      );
    };
    write(PARENT, "Plan the notes", 5 * 60_000);
    write(CHILD, "Count one folder", 2 * 60_000, PARENT);
    const { p, errors } = await open();
    const group = p.locator('#agl .aghs[data-helpers-of="scout"]');
    await group
      .locator(`[data-helper="${CHILD}"]`)
      .waitFor({ timeout: 20_000 });
    const rows = await group
      .locator("button.agh")
      .evaluateAll((b) =>
        b.map((x) => [
          x.dataset.helper,
          (x as HTMLElement).style.getPropertyValue("--hp-depth"),
        ]),
      );
    expect(rows).toEqual([
      [LIVE, "0"],
      [PARENT, "0"],
      [CHILD, "1"],
    ]);
    // The page's twin of shownDepths agrees with the server's.
    const list: Helper[] = sortHelpers([
      { id: "p", depth: 1, status: "done", statusFrom: "t", startedAt: 1 },
      {
        id: "c",
        depth: 2,
        status: "done",
        statusFrom: "t",
        startedAt: 2,
        parentId: "p",
      },
      {
        id: "g",
        depth: 3,
        status: "done",
        statusFrom: "t",
        startedAt: 3,
        parentId: "c",
      },
      {
        id: "o",
        depth: 2,
        status: "done",
        statusFrom: "t",
        startedAt: 4,
        parentId: "gone",
      },
    ]);
    // A string, so ts-jest leaves the page's own import() alone.
    const page = (await p.evaluate(
      `import("/agent-helpers.js").then((m) => [...m.shownDepths(${JSON.stringify(list)})])`,
    )) as [string, number][];
    expect(page).toEqual([...shownDepths(list)]);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);
});
