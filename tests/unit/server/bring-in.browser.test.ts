/**
 * Bring in (AG-17.1) in a real browser, on the real server and the demo
 * distribution (acme; north) with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts): nothing really runs.
 * Claude Code's history is a temp HOME's ~/.claude, never this machine's.
 *
 *   - the Agents page's Bring in opens the Start dialog's Bring in mode:
 *     the workspace's conversations, newest first, with the persona list
 *     (no Plain session, no first instruction, no Advanced);
 *   - one written in the last minute says "Open elsewhere" and can't be
 *     picked;
 *   - Bring in sends the import and the runtime's resume (`--resume <id>`)
 *     runs in the folder it ran in; its pane opens; asked again, the row
 *     says which agent continues it;
 *   - at 390 nothing is wider than the window.
 *
 * DEN_START_SHOTS=<dir> writes screenshots. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { claudeSlug } from "../../../src/shared/agents/conversations.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
const SHOTS = process.env.DEN_START_SHOTS;
const PTY = loadPty().available;
const errors: string[] = [];
let latest = "";

const OLD = "1a2b3c4d-0000-4000-8000-00000000aaaa";
const OPEN = "5e6f7a8b-0000-4000-8000-00000000bbbb";

/** A Claude Code transcript under the temp HOME, last written ageMs ago. */
function conversation(cwd: string, id: string, title: string, ageMs: number) {
  const home = path.dirname(s!.stateDir);
  const dir = path.join(home, ".claude", "projects", claudeSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "user", cwd, message: { content: title } })}\n`,
  );
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
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
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function page(url: string, width = 1440, height = 900): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height },
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
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|400|409)/.test(m.text()))
      errors.push(`${url}: console: ${m.text()}`);
  });
  await p.goto(`${s!.base}${url}`);
  return p;
}

async function openBringIn(p: Page): Promise<void> {
  await p.waitForSelector("#ag-bring");
  await p.click("#ag-bring");
  await p.waitForSelector("#ag-dlg[open]", { timeout: 20_000 });
  await p.waitForSelector(`#ag-conv [data-cid="${OLD}"]`);
  await p.waitForSelector('#ag-persona [data-pid="planner"]');
}

const shot = async (p: Page, name: string) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

describe("Bring in (AG-17.1)", () => {
  it("lists the workspace's conversations, refuses one open elsewhere, and brings one in with --resume", async () => {
    if (skip() || !PTY) return;
    const docs = path.join(s!.wsDir("north"), "docs");
    fs.mkdirSync(docs, { recursive: true });
    conversation(docs, OLD, "Tidy the docs", 30 * 60_000);
    conversation(s!.wsDir("north"), OPEN, "Still typing here", 3_000);

    const p = await page("/agents?ws=north");
    await openBringIn(p);
    await shot(p, "bring-in-1440");
    expect(await p.textContent("#ag-dlg-h")).toBe("Bring in a conversation");
    expect(await p.textContent("#ag-go")).toBe("Bring in");
    // Newest first; the open one can't be picked.
    expect(
      await p.$$eval("#ag-conv [data-cid]", (bs) =>
        bs.map((b) => (b as HTMLElement).dataset.cid),
      ),
    ).toEqual([OPEN, OLD]);
    expect(
      await p.getAttribute(`#ag-conv [data-cid="${OPEN}"]`, "aria-disabled"),
    ).toBe("true");
    expect(await p.textContent(`#ag-conv [data-cid="${OPEN}"]`)).toContain(
      "Open elsewhere",
    );
    await p.click(`#ag-conv [data-cid="${OPEN}"]`, { force: true });
    expect(
      await p.getAttribute(`#ag-conv [data-cid="${OPEN}"]`, "aria-checked"),
    ).toBe("false");
    // The folder, relative to the workspace's; the first prompt as title.
    expect(await p.textContent(`#ag-conv [data-cid="${OLD}"]`)).toContain(
      "Tidy the docs",
    );
    expect(await p.textContent(`#ag-conv [data-cid="${OLD}"] .pd`)).toContain(
      "docs ·",
    );
    // A persona is needed; no Plain session, no first instruction.
    expect(await p.$('#ag-persona [data-pid=":plain"]')).toBeNull();
    expect(await p.isHidden("#ag-task-l")).toBe(true);
    expect(await p.isHidden("#ag-adv")).toBe(true);

    await p.click('#ag-persona [data-pid="planner"]');
    await p.click(`#ag-conv [data-cid="${OLD}"]`);
    const made = s!.made.length;
    const [res] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname ===
            `/api/workspaces/north/conversations/${OLD}/import`,
        { timeout: 20_000 },
      ),
      p.click("#ag-go"),
    ]);
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.request().postData() ?? "{}")).toEqual({
      persona: "planner",
      runtime: "den-claude",
    });
    const agent = (
      (await res.json()) as { agent: { id: string; sessionId: string } }
    ).agent;
    await p.waitForSelector(`.pane[data-id="${agent.sessionId}"] .xterm-rows`);
    expect(s!.made.length).toBe(made + 1);
    const pty = s!.made[s!.made.length - 1];
    expect(pty.args.slice(0, 2)).toEqual(["--resume", OLD]);
    expect(pty.opts.cwd).toBe(docs);
    expect(readRecord(s!.stateDir, agent.id)).toMatchObject({
      resumeToken: OLD,
      cwd: docs,
    });
    expect(fs.existsSync(s!.ran)).toBe(false);

    // Asked again: the row says which agent continues it.
    await p.click("#ag-bring");
    await p.waitForSelector("#ag-dlg[open]");
    await p.waitForSelector(
      `#ag-conv [data-cid="${OLD}"][aria-disabled="true"]`,
    );
    expect(await p.textContent(`#ag-conv [data-cid="${OLD}"]`)).toContain(
      `Agent ${agent.id}`,
    );
    expect(await p.isDisabled("#ag-go")).toBe(true);

    // At 390, nothing is wider than the window.
    await p.setViewportSize({ width: 390, height: 844 });
    await shot(p, "bring-in-390");
    const over = await p.$$eval("#ag-dlg, #ag-dlg *", (els) =>
      els
        .filter(
          (e) => e.getBoundingClientRect().right > window.innerWidth + 0.5,
        )
        .map((e) => e.id || e.className),
    );
    expect(over).toEqual([]);
    // Start is Start again afterwards.
    await p.click("#ag-cancel");
    await p.click("#ag-start");
    await p.waitForSelector("#ag-dlg[open]");
    expect(await p.textContent("#ag-dlg-h")).toBe("Start an agent");
    expect(await p.isHidden("#ag-conv-f")).toBe(true);
    await p.waitForSelector('#ag-persona [data-pid=":plain"]');
    await p.context().close();
    expect(errors).toEqual([]);
  }, 90_000);
});
