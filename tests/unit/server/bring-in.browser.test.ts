/**
 * Bring in (AG-17.1) in a real browser, on the real server and the demo
 * distribution (acme; north) with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts): nothing really runs.
 * Claude Code's history is a temp HOME's ~/.claude, never this machine's.
 *
 *   - the Agents page's Bring in opens the Start dialog's Bring in mode:
 *     the workspace's conversations, newest first, with the persona list
 *     (no Plain session, no first instruction; Advanced has the model
 *     only, AG-17.1c);
 *   - one written in the last minute says "Open elsewhere" and can't be
 *     picked;
 *   - Bring in sends the import and the runtime's resume (`--resume <id>`)
 *     runs in the folder it ran in; its pane opens; asked again, the row
 *     says which agent continues it;
 *   - at 390 nothing is wider than the window;
 *   - AG-17.1c: a conversation's own model stays ("Keeps <model> from the
 *     conversation", Advanced's first choice), the MCP servers it won't
 *     have are named, and the suggested persona is preselected, never
 *     submitted;
 *   - AG-18: the pane's ⋯ menu has Change persona…: the current persona
 *     is marked and Change is off until another is picked; mid-turn the
 *     dialog asks (After this turn, Stop it now); Stop it now resumes the
 *     same conversation as the new persona, and the open pane follows
 *     the agent to its new session ("Switched to <persona>").
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
function conversation(
  cwd: string,
  id: string,
  title: string,
  ageMs: number,
  more: unknown[] = [],
) {
  const home = path.dirname(s!.stateDir);
  const dir = path.join(home, ".claude", "projects", claudeSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    [{ type: "user", cwd, message: { content: title } }, ...more]
      .map((x) => `${JSON.stringify(x)}\n`)
      .join(""),
  );
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

/** An answer as Claude Code records it: its model, stop reason, tools. */
const answer = (model: string, stop: string, tools: string[] = []) => ({
  type: "assistant",
  message: {
    model,
    stop_reason: stop,
    content: [
      { type: "text", text: "Done." },
      ...tools.map((name) => ({ type: "tool_use", id: name, name })),
    ],
  },
});

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
    // Long enough to be cut: the badge must still show whole (the 0.4.14-dev.0 gate).
    conversation(
      docs,
      OLD,
      "Tidy the docs and the long README sections on installing it everywhere",
      30 * 60_000,
    );
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
    // AG-17.1c: Advanced has the model only (the persona's permissions).
    expect(await p.$('#ag-persona [data-pid=":plain"]')).toBeNull();
    expect(await p.isHidden("#ag-task-l")).toBe(true);
    expect(await p.isHidden("#ag-adv")).toBe(false);
    expect(await p.$("#ag-adv-b [data-pm]")).toBeNull();

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
    // The badge shows whole beside a long title, at 1440 (the 0.4.14-dev.0 gate).
    const clipped = await p.$eval(
      `#ag-conv [data-cid="${OLD}"] .tagx`,
      (e) =>
        e.getBoundingClientRect().right >
          (e.closest(".pr") as HTMLElement).getBoundingClientRect().right ||
        e.scrollWidth > e.clientWidth + 0.5 ||
        e.getBoundingClientRect().right >
          (e.parentElement as HTMLElement).getBoundingClientRect().right + 0.5,
    );
    expect(clipped).toBe(false);
    // Each runtime that can't is its own sentence (the 0.4.14-dev.0 gate).
    expect(await p.textContent("#ag-conv-h")).not.toMatch(/yet [A-Z]/);

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

  it("AG-17.1c, AG-18: keeps the conversation's model, says what changes, then changes persona on the same conversation", async () => {
    if (skip() || !PTY) return;
    const api = path.join(s!.wsDir("north"), "api");
    fs.mkdirSync(api, { recursive: true });
    const p = await page("/agents?ws=north");
    await p.waitForSelector("#ag-bring");
    // The latest agent here is a reviewer: Bring in suggests it.
    await p.evaluate(() =>
      window.denShell.api("POST", "/api/workspaces/north/agents", {
        persona: "reviewer",
        id: "rev-1",
      }),
    );
    const CONV = "9c8d7e6f-0000-4000-8000-00000000cccc";
    conversation(api, CONV, "Shape the API", 30 * 60_000, [
      answer("claude-opus-4-5", "end_turn", ["mcp__linear__get_issue"]),
    ]);
    await p.click("#ag-bring");
    await p.waitForSelector("#ag-dlg[open]", { timeout: 20_000 });
    await p.click(`#ag-conv [data-cid="${CONV}"]`);
    // Suggested and preselected, not submitted.
    await p.waitForSelector(
      '#ag-persona [data-pid="reviewer"][aria-checked="true"]',
    );
    const keep = await p.$$eval("#ag-keep li", (ls) =>
      ls.map((l) => l.textContent),
    );
    expect(keep).toEqual([
      "Keeps claude-opus-4-5 from the conversation.",
      expect.stringMatching(
        /^From now on it works as .+: its role, its permissions \(.+\), Den's tools and guards\. Its history stays\.$/,
      ),
      "It won't have: linear. Den runs agents with Den's tools only.",
    ]);
    await p.click("#ag-adv-s");
    expect(
      await p.$eval(
        "#ag-model",
        (el) => (el as HTMLSelectElement).options[0].textContent,
      ),
    ).toBe("Keep claude-opus-4-5");
    await shot(p, "bring-in-keeps");
    const [res] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname ===
            `/api/workspaces/north/conversations/${CONV}/import`,
        { timeout: 20_000 },
      ),
      p.click("#ag-go"),
    ]);
    expect(res.status()).toBe(200);
    // The model isn't sent: the server keeps the conversation's.
    expect(JSON.parse(res.request().postData() ?? "{}")).toEqual({
      persona: "reviewer",
      runtime: "den-claude",
    });
    const agent = (
      (await res.json()) as { agent: { id: string; sessionId: string } }
    ).agent;
    const pty = s!.made[s!.made.length - 1];
    expect(pty.args[pty.args.indexOf("--model") + 1]).toBe("claude-opus-4-5");
    expect(readRecord(s!.stateDir, agent.id)?.model).toBe("claude-opus-4-5");
    // Its session ends when Den stops it, as a real one does.
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      setTimeout(() => pty.exit(143), 5);
    };

    // AG-18: the pane's ⋯ → Change persona…
    const more = `.pane[data-id="${agent.sessionId}"] [data-act="more"]`;
    await p.waitForSelector(more);
    await p.click(more);
    await p.click('.den-pop .den-mi:has-text("Change persona")');
    await p.waitForSelector("#ag-dlg[open]");
    expect(await p.textContent("#ag-dlg-h")).toContain("persona");
    await p.waitForSelector(
      '#ag-persona [data-pid="reviewer"][aria-checked="true"] [data-current]',
    );
    expect(await p.isDisabled("#ag-go")).toBe(true);
    expect(await p.$('#ag-persona [data-pid=":plain"]')).toBeNull();
    expect(await p.isHidden("#ag-name-l")).toBe(true);
    await p.click('#ag-persona [data-pid="planner"]');
    expect(await p.isDisabled("#ag-go")).toBe(false);
    expect(await p.textContent("#ag-keep li")).toBe(
      "Keeps claude-opus-4-5 from the conversation.",
    );
    // Mid-turn: it asks, and nothing is stopped.
    conversation(api, CONV, "Shape the API", 30 * 60_000, [
      answer("claude-opus-4-5", "tool_use", ["Bash"]),
    ]);
    const before = s!.made.length;
    await p.click("#ag-go");
    await p.waitForSelector("#ag-pc-now");
    expect(await p.textContent("#ag-err")).toContain(
      "It's working. Change after this turn, or stop it now?",
    );
    expect(await p.isVisible("#ag-pc-after")).toBe(true);
    expect(pty.signals).toEqual([]);
    expect(s!.made.length).toBe(before);
    await shot(p, "change-persona-busy");
    const [ch] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname ===
            `/api/workspaces/north/agents/${agent.id}/persona`,
        { timeout: 20_000 },
      ),
      p.click("#ag-pc-now"),
    ]);
    expect(ch.status()).toBe(200);
    expect(JSON.parse(ch.request().postData() ?? "{}")).toEqual({
      persona: "planner",
      when: "now",
    });
    await p.waitForSelector("#ag-dlg:not([open])", { state: "attached" });
    expect(s!.made.length).toBe(before + 1);
    const next = s!.made[s!.made.length - 1];
    expect(next.args.slice(0, 2)).toEqual(["--resume", CONV]);
    expect(readRecord(s!.stateDir, agent.id)).toMatchObject({
      id: agent.id,
      persona: "planner",
      model: "claude-opus-4-5",
      resumeToken: CONV,
    });
    expect(fs.existsSync(s!.ran)).toBe(false);
    // The open pane follows its agent to the new session, in the same
    // slot, and says so in its scrollback; never left on the old one.
    await p.waitForFunction(
      (old) => {
        const panes = [...document.querySelectorAll(".pane")];
        return (
          panes.length === 1 &&
          panes[0].getAttribute("data-id") !== old &&
          (panes[0].querySelector(".xterm-rows")?.textContent ?? "").includes(
            "Switched to planner",
          )
        );
      },
      agent.sessionId,
      { timeout: 5_000 },
    );
    const now = await p.getAttribute(".pane", "data-id");
    expect(new URL(p.url()).searchParams.get("open")).toBe(now);
    await p.context().close();
    expect(errors).toEqual([]);
  }, 90_000);

  it("AG-18: Change persona on an agent never prompted says it started fresh, in the toast and the pane", async () => {
    if (skip() || !PTY) return;
    const p = await page("/agents?ws=north");
    await p.waitForSelector("#ag-bring");
    const started = (await p.evaluate(() =>
      window.denShell.api("POST", "/api/workspaces/north/agents", {
        persona: "reviewer",
        id: "fresh-1",
        runtime: "den-claude",
      }),
    )) as { agent: { sessionId: string } };
    const sid = started.agent.sessionId;
    const pty = s!.made[s!.made.length - 1];
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      setTimeout(() => pty.exit(143), 5);
    };
    await p.goto(`${s!.base}/agents?ws=north&open=${sid}`);
    const more = `.pane[data-id="${sid}"] [data-act="more"]`;
    await p.waitForSelector(more);
    await p.click(more);
    await p.click('.den-pop .den-mi:has-text("Change persona")');
    await p.waitForSelector("#ag-dlg[open]");
    await p.click('#ag-persona [data-pid="planner"]');
    const done = p.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.status() === 200 &&
        new URL(r.url()).pathname ===
          "/api/workspaces/north/agents/fresh-1/persona",
      { timeout: 20_000 },
    );
    await p.click("#ag-go");
    // Idle, it changes at once; if Den can't tell, it asks: Stop it now.
    const asked = await p
      .waitForSelector("#ag-pc-now", { timeout: 2_000 })
      .catch(() => null);
    if (asked) await p.click("#ag-pc-now");
    const ch = await done;
    expect(ch.status()).toBe(200);
    expect(((await ch.json()) as { fresh?: boolean }).fresh).toBe(true);
    await p.waitForFunction(
      (old) => {
        const panes = [...document.querySelectorAll(".pane")];
        const text = panes[0]?.querySelector(".xterm-rows")?.textContent ?? "";
        return (
          panes.length === 1 &&
          panes[0].getAttribute("data-id") !== old &&
          text.includes("Switched to planner") &&
          text.includes(
            "Nothing to resume yet; started fresh (same conversation id, folder and scope)",
          )
        );
      },
      sid,
      { timeout: 8_000 },
    );
    await p.context().close();
    expect(errors).toEqual([]);
  }, 60_000);

  it("D56: one started in ~ is listed apart, comes in only by the person's pick (naming its folder), and its row says where it started", async () => {
    if (skip() || !PTY) return;
    const home = path.dirname(s!.stateDir);
    const AWAY = "4d3c2b1a-0000-4000-8000-00000000dddd";
    conversation(home, AWAY, "Plan the week from home", 20 * 60_000, [
      answer("claude-opus-5-5", "end_turn"),
    ]);
    const p = await page("/agents?ws=north");
    await p.waitForSelector("#ag-bring");
    // The tests above leave agents running: under the cap, one more.
    for (const pty of s!.made) {
      const kill = pty.kill.bind(pty);
      pty.kill = (sig: string) => {
        kill(sig);
        setTimeout(() => pty.exit(143), 5);
      };
    }
    await p.evaluate(async () => {
      const r = (await window.denShell.api(
        "GET",
        "/api/workspaces/north/agents",
      )) as
        | { agents?: { agent: string; state: string }[] }
        | { agent: string; state: string }[];
      const rows = Array.isArray(r) ? r : (r.agents ?? []);
      for (const a of rows)
        if (a.state === "running")
          await window.denShell.api(
            "POST",
            `/api/workspaces/north/agents/${encodeURIComponent(a.agent)}/stop`,
            {},
          );
    });
    await p.click("#ag-bring");
    await p.waitForSelector("#ag-dlg[open]", { timeout: 20_000 });
    await p.waitForSelector('#ag-persona [data-pid="planner"]');
    await p.waitForSelector(`#ag-conv-o [data-cid="${AWAY}"]`);
    expect(await p.textContent("#ag-conv-ot")).toBe(
      "Started outside any project",
    );
    expect(await p.isVisible("#ag-conv-ohelp")).toBe(true);
    // Never in the project's list, never picked for you.
    expect(await p.$(`#ag-conv [data-cid="${AWAY}"]`)).toBeNull();
    expect(
      await p.getAttribute(`#ag-conv-o [data-cid="${AWAY}"]`, "aria-checked"),
    ).toBe("false");
    // Its full folder, not relative to the project's.
    expect(
      await p.textContent(`#ag-conv-o [data-cid="${AWAY}"] .pd`),
    ).toContain(`${home} ·`);
    await shot(p, "bring-in-outside-1440");
    await p.click('#ag-persona [data-pid="planner"]');
    await p.click(`#ag-conv-o [data-cid="${AWAY}"]`);
    expect(
      await p.getAttribute(`#ag-conv-o [data-cid="${AWAY}"]`, "aria-checked"),
    ).toBe("true");
    const [res] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname ===
            `/api/workspaces/north/conversations/${AWAY}/import`,
        { timeout: 20_000 },
      ),
      p.click("#ag-go"),
    ]);
    expect(res.status()).toBe(200);
    expect(JSON.parse(res.request().postData() ?? "{}")).toEqual({
      persona: "planner",
      runtime: "den-claude",
      outside: home,
    });
    const agent = (
      (await res.json()) as { agent: { id: string; sessionId: string } }
    ).agent;
    const pty = s!.made[s!.made.length - 1];
    expect(pty.args.slice(0, 2)).toEqual(["--resume", AWAY]);
    expect(pty.opts.cwd).toBe(home);
    expect(readRecord(s!.stateDir, agent.id)).toMatchObject({
      cwd: home,
      outside: true,
    });
    const row = "#agl";
    await p.waitForFunction(
      ([sel, want]) =>
        (document.querySelector(sel as string)?.textContent ?? "").includes(
          want as string,
        ),
      [row, `started in ${home} (outside the project)`],
      { timeout: 10_000 },
    );
    await p.context().close();
    expect(errors).toEqual([]);
  }, 60_000);
});
