/**
 * An agent's pane as a terminal (AG-4b, AG spec "AG-4b: Agents tab
 * layout"), in a real browser:
 *
 *   - Shift+Enter is a soft newline: the runtime's (catalog softNewline),
 *     Claude Code's ESC CR, Codex's Ctrl+J; a plain session's is Enter.
 *     No CR goes with it;
 *   - the session's name: Claude Code's /rename (its transcript's latest
 *     custom-title) shows in the pane header after the runtime, in the
 *     tab, the list and ⌘K; a Den rename after it wins;
 *   - links: a plain URL and an OSC 8 http link are links, ⌘-click
 *     (Ctrl-click elsewhere) opens them in a new tab with noopener, and a
 *     plain click opens nothing; an OSC 8 javascript: link is no link and
 *     does nothing; a path inside the workspace is a link (the server
 *     says it exists), one outside it or missing is not; ⌘-click copies
 *     its absolute path (Settings editor_open none) or opens the editor's
 *     URL at the line (zed).
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts): nothing really runs, no
 * vendor CLI. DEN_AGENTS_SHOTS=<dir> writes screenshots.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let browser: Browser | null = null;
let latest = "";
const SHOTS = process.env.DEN_AGENTS_SHOTS;
const errors: string[] = [];
const TOKEN = "5f0c2d1e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
const sid: Record<string, string> = {};
const pid: Record<string, number> = {};
const MOD = process.platform === "darwin" ? "Meta" : "Control";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  host = await connectHost(sessionPaths(s.stateDir).socket);
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  const agents: Array<[string, string, string | null]> = [
    ["planner", "den-claude", TOKEN],
    ["coder", "codex", null],
    ["shell", "", null],
  ];
  for (const [id, runtime, token] of agents) {
    const info = await host.start({
      name: `acme-north:${id}`,
      cwd: s.wsDir("north"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    sid[id] = info.ref.id;
    pid[id] = info.pid;
    // "shell" is a plain session: no record.
    if (runtime)
      s.seed({
        id,
        persona: id === "planner" ? "planner" : "builder",
        runtime,
        workspace: "north",
        session: { backend: "den-pty", id: info.ref.id },
        sessionName: `acme-north:${id}`,
        ...(token ? { resumeToken: token } : {}),
      });
    pty(id).emit(`${id} ready\r\n$ `);
  }
  const ws = s.wsDir("north");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "src", "x.ts"), "export {};\n");
  fs.mkdirSync(path.join(s.tmp, "outside"), { recursive: true });
  fs.writeFileSync(path.join(s.tmp, "outside", "y.ts"), "y\n");
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  host?.close();
  await s?.stop();
});

const skip = () => !browser;
const pty = (id: string) => s!.made.find((x) => x.pid === pid[id])!;
const typed = (id: string, from: number) =>
  Buffer.concat(pty(id).writes.slice(from)).toString("latin1");
const transcript = () =>
  path.join(s!.tmp, "home", ".claude", "projects", "-seeded", `${TOKEN}.jsonl`);

async function eventually(
  pred: () => Promise<boolean> | boolean,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function page(url: string): Promise<Page> {
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
    // What a modifier-click opens or copies, recorded instead.
    const w = window as unknown as {
      __opened: unknown[][];
      __copied: string[];
    };
    w.__opened = [];
    w.__copied = [];
    window.open = (...a: unknown[]) => {
      w.__opened.push(a);
      return null;
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string) => {
          w.__copied.push(t);
          return Promise.resolve();
        },
      },
    });
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`${url}: console: ${m.text()}`);
  });
  await p.goto(`${s!.base}${url}`);
  await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
  return p;
}

async function termUp(p: Page, id: string): Promise<void> {
  await p.waitForFunction(
    (i) =>
      (
        document.querySelector(`.pane[data-id="${i}"] .xterm-rows`)
          ?.textContent ?? ""
      ).includes("ready"),
    sid[id],
    { timeout: 20_000 },
  );
}

const opened = (p: Page) =>
  p.evaluate(() => (window as unknown as { __opened: unknown[][] }).__opened);
const copied = (p: Page) =>
  p.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

/** The middle of cell (col, row), 0-based, of the pane's terminal. */
async function cell(
  p: Page,
  id: string,
  col: number,
  row: number,
): Promise<{ x: number; y: number }> {
  return p.$eval(
    `.pane[data-id="${sid[id]}"]`,
    (el, [c, r]) => {
      const scr = el.querySelector(".xterm-screen")!.getBoundingClientRect();
      const cols = Number((el as HTMLElement).dataset.cols);
      const rows = Number((el as HTMLElement).dataset.rows);
      return {
        x: scr.left + (c + 0.5) * (scr.width / cols),
        y: scr.top + (r + 0.5) * (scr.height / rows),
      };
    },
    [col, row] as const,
  );
}

/** Whether the pointer over (col, row) is over a link (xterm's pointer). */
async function linkAt(
  p: Page,
  id: string,
  col: number,
  row: number,
): Promise<boolean> {
  const at = await cell(p, id, col, row);
  // Off it first, so a hover is a new one.
  await p.mouse.move(at.x, at.y + 400);
  await p.mouse.move(at.x, at.y, { steps: 2 });
  const pointer = () =>
    p.$eval(
      `.pane[data-id="${sid[id]}"]`,
      (e) => e.querySelector(".xterm-cursor-pointer") !== null,
    );
  try {
    await eventually(pointer, 1_500);
    return true;
  } catch {
    return false;
  }
}

async function modClick(p: Page, id: string, col: number, row: number) {
  const at = await cell(p, id, col, row);
  await p.mouse.move(at.x, at.y, { steps: 2 });
  await p.keyboard.down(MOD);
  await p.mouse.click(at.x, at.y);
  await p.keyboard.up(MOD);
}

describe("an agent's pane as a terminal (AG-4b)", () => {
  it.each([
    ["planner", "Claude Code: ESC CR", "a\u001b\rb\r"],
    ["coder", "Codex: Ctrl+J", "a\nb\r"],
    ["shell", "a plain session: Enter", "a\rb\r"],
  ])(
    "Shift+Enter in %s's pane is its soft newline (%s), and no CR goes with it",
    async (id, _what, want) => {
      if (skip()) return;
      const p = await page(`/agents?open=${sid[id]}&layout=tabs`);
      await termUp(p, id);
      await p.click(`.pane[data-id="${sid[id]}"] .term`);
      const from = pty(id).writes.length;
      await p.keyboard.type("a");
      await p.keyboard.press("Shift+Enter");
      await p.keyboard.type("b");
      await p.keyboard.press("Enter");
      await eventually(() => typed(id, from).length >= want.length);
      await new Promise((r) => setTimeout(r, 200));
      expect(JSON.stringify(typed(id, from))).toBe(JSON.stringify(want));
      await p.context().close();
    },
    60_000,
  );

  it("the session's name: Claude Code's /rename shows in the header, the tab, the list and ⌘K; a Den rename after it wins", async () => {
    if (skip()) return;
    const p = await page(`/agents?open=${sid.planner}&layout=tabs`);
    await termUp(p, "planner");
    const bar = p.locator(`.pane[data-id="${sid.planner}"] .bar2`);
    const tab = p.locator(`#agr [role="tab"][data-id="${sid.planner}"]`);
    const row = p.locator(`.agr[data-id="${sid.planner}"]`);
    expect(await bar.locator(".where").textContent()).toBe(
      "north · den-claude",
    );
    fs.appendFileSync(
      transcript(),
      JSON.stringify({ type: "custom-title", customTitle: "api spike" }) + "\n",
    );
    // Within the list's refresh (5 s).
    await eventually(
      async () =>
        (await bar.locator(".where").textContent()) ===
        "north · den-claude · api spike",
      8_000,
    );
    expect((await bar.locator("b").textContent())?.trim()).toBe("planner");
    expect(await tab.locator(".tn").textContent()).toBe("planner");
    expect(await tab.locator(".tm").textContent()).toBe(
      "planner · north · api spike",
    );
    expect(await row.locator(".nm").textContent()).toContain("api spike");
    await p.click("#den-search");
    await p.fill("#den-pal-q", "api spike");
    await p.waitForSelector('#den-pal-list li[role="option"]');
    expect(
      await p
        .locator('#den-pal-list li[role="option"] .den-pal-l')
        .first()
        .textContent(),
    ).toBe("Agents › north / planner · api spike");
    await p.keyboard.press("Escape");
    if (SHOTS) {
      await p.setViewportSize({ width: 1440, height: 900 });
      await bar.screenshot({ path: path.join(SHOTS, "header-name-1440.png") });
      await p.screenshot({
        path: path.join(SHOTS, "header-name-page-1440.png"),
      });
    }
    // A Den rename after it: Den's wins, and the header says it once.
    await tab.dblclick();
    const input = p.locator(`#agr .agtab-w[data-id="${sid.planner}"] input`);
    await input.fill("Night watch");
    await input.press("Enter");
    await eventually(
      async () => (await tab.locator(".tn").textContent()) === "Night watch",
    );
    await eventually(
      async () =>
        (await bar.locator(".where").textContent()) === "north · den-claude",
    );
    expect((await bar.locator("b").textContent())?.trim()).toBe("Night watch");
    await p.context().close();
  }, 60_000);

  it("a Codex agent has no name of its own, and nothing breaks", async () => {
    if (skip()) return;
    const p = await page(`/agents?open=${sid.coder}&layout=tabs`);
    await termUp(p, "coder");
    expect(
      await p
        .locator(`.pane[data-id="${sid.coder}"] .bar2 .where`)
        .textContent(),
    ).toBe("north · codex");
    const list = (await (await fetch(`${s!.base}/api/sessions`)).json()) as {
      sessions: Record<string, unknown>[];
    };
    expect(list.sessions.find((x) => x.agent === "coder")).not.toHaveProperty(
      "sessionName",
    );
    await p.context().close();
  }, 60_000);

  it("links: URLs and OSC 8 http links open with ⌘/Ctrl-click (noopener); javascript: never; paths inside the workspace copy or open the editor; outside ones aren't links", async () => {
    if (skip()) return;
    await s!.settings({ editor_open: null });
    const p = await page(`/agents?open=${sid.planner}&layout=tabs`);
    await termUp(p, "planner");
    const lines = [
      "url https://example.test/docs here",
      "osc \u001b]8;;https://example.test/osc\u0007OSC LINK\u001b]8;;\u0007 end",
      "bad \u001b]8;;javascript:alert(1)\u0007JS LINK\u001b]8;;\u0007 end",
      "in src/x.ts:10 ok",
      "out ../../outside/y.ts and /etc/hosts",
      "missing src/nope.ts:3",
    ];
    pty("planner").emit("\u001b[2J\u001b[H" + lines.join("\r\n") + "\r\n");
    await p.waitForFunction(
      (i) =>
        (
          document.querySelector(`.pane[data-id="${i}"] .xterm-rows`)
            ?.textContent ?? ""
        ).includes("missing src/nope.ts"),
      sid.planner,
    );
    // Which are links (xterm's pointer over them).
    expect(await linkAt(p, "planner", 10, 0)).toBe(true); // the URL
    expect(await linkAt(p, "planner", 1, 0)).toBe(false); // "url"
    expect(await linkAt(p, "planner", 6, 1)).toBe(true); // OSC 8 http
    expect(await linkAt(p, "planner", 6, 2)).toBe(false); // OSC 8 javascript:
    expect(await linkAt(p, "planner", 6, 3)).toBe(true); // src/x.ts:10
    if (SHOTS)
      await p
        .locator(`.pane[data-id="${sid.planner}"]`)
        .screenshot({ path: path.join(SHOTS, "link-hover-1440.png") });
    expect(await linkAt(p, "planner", 8, 4)).toBe(false); // outside the workspace
    expect(await linkAt(p, "planner", 30, 4)).toBe(false); // /etc/hosts
    expect(await linkAt(p, "planner", 12, 5)).toBe(false); // missing

    // A plain click opens nothing.
    const at = await cell(p, "planner", 10, 0);
    await p.mouse.click(at.x, at.y);
    await p.waitForTimeout(200);
    expect(await opened(p)).toEqual([]);
    // ⌘/Ctrl-click: a new tab, noopener.
    await modClick(p, "planner", 10, 0);
    await eventually(async () => (await opened(p)).length === 1);
    await modClick(p, "planner", 6, 1);
    await eventually(async () => (await opened(p)).length === 2);
    expect(await opened(p)).toEqual([
      ["https://example.test/docs", "_blank", "noopener"],
      ["https://example.test/osc", "_blank", "noopener"],
    ]);
    // javascript: does nothing.
    await modClick(p, "planner", 6, 2);
    await p.waitForTimeout(300);
    expect((await opened(p)).length).toBe(2);
    // A path, with editor_open none: its absolute path is copied.
    await modClick(p, "planner", 6, 3);
    const abs = fs.realpathSync(path.join(s!.wsDir("north"), "src", "x.ts"));
    await eventually(async () => (await copied(p)).length === 1);
    expect(await copied(p)).toEqual([abs]);
    await p.getByText("Copied", { exact: true }).first().waitFor();
    // Outside the workspace: nothing.
    await modClick(p, "planner", 8, 4);
    await p.waitForTimeout(300);
    expect((await copied(p)).length).toBe(1);
    expect((await opened(p)).length).toBe(2);
    await p.context().close();

    // editor_open zed: the editor's URL, at the line.
    expect(await s!.settings({ editor_open: "zed" })).toBe(200);
    const q = await page(`/agents?open=${sid.planner}&layout=tabs`);
    // Its scrollback ends on the screen the last test cleared.
    await q.waitForSelector(`.pane[data-id="${sid.planner}"] .xterm-screen`);
    await q.waitForTimeout(300);
    pty("planner").emit("\u001b[2J\u001b[Hin src/x.ts:10 ok\r\n");
    await q.waitForFunction(
      (i) =>
        (
          document.querySelector(`.pane[data-id="${i}"] .xterm-rows`)
            ?.textContent ?? ""
        ).includes("in src/x.ts:10 ok"),
      sid.planner,
    );
    expect(await linkAt(q, "planner", 6, 0)).toBe(true);
    await modClick(q, "planner", 6, 0);
    await eventually(async () => (await opened(q)).length === 1);
    expect(await opened(q)).toEqual([[`zed://file${abs}:10`, "_self"]]);
    expect(await copied(q)).toEqual([]);
    await q.context().close();
    await s!.settings({ editor_open: null });
  }, 90_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
