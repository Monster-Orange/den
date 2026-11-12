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
// The page's own rule (term-input.js isMac): a browser in a Linux
// container is "elsewhere" even on a Mac.
let MOD: "Meta" | "Control" = "Control";

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    // DEN_TERMINAL_BROWSER=webkit (Safari's engine) or firefox runs the
    // same tests there. DEN_PW_WS=ws://localhost:<port>/ uses a browser
    // behind a Playwright run-server (when this shell can't start a GUI
    // app); its localhost is this machine's (exposeNetwork).
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_TERMINAL_BROWSER ?? "")
        ? process.env.DEN_TERMINAL_BROWSER
        : "chromium"
    ) as "chromium" | "firefox" | "webkit";
    const ws = process.env.DEN_PW_WS;
    browser = ws
      ? await pw[engine].connect(ws, { exposeNetwork: "<loopback>" })
      : await pw[engine].launch();
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

async function page(url: string, stub = true): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(
    ([v, stubbed]) => {
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, v);
      } catch {
        /* none */
      }
      if (!stubbed) return;
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
      // D35: a web link opens through a real link (term-input.js linkOpen).
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        w.__opened.push([this.href, this.target, this.rel]);
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
    },
    [latest, stub] as const,
  );
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`${url}: console: ${m.text()}`);
  });
  await p.goto(`${s!.base}${url}`);
  await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
  MOD = (await p.evaluate(() => {
    const n = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    return /mac|iphone|ipad/i.test(
      n.userAgentData?.platform || n.platform || "",
    );
  }))
    ? "Meta"
    : "Control";
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
      // `/rename "api spike"` keeps the quotes; the header doesn't (0.4.13).
      JSON.stringify({ type: "custom-title", customTitle: '"api spike"' }) +
        "\n",
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
    // The API's name shown is sessionTitle; its handle is `name` (0.4.13).
    const listed = (
      (await (await fetch(`${s!.base}/api/sessions`)).json()) as {
        sessions: Record<string, unknown>[];
      }
    ).sessions.find((x) => x.agent === "planner");
    expect(listed).toMatchObject({ sessionTitle: "api spike" });
    expect(listed).not.toHaveProperty("sessionName");
    expect(String(listed?.name)).toMatch(/:planner$/);
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
      "sessionTitle",
    );
    await p.context().close();
  }, 60_000);

  it("links: URLs and OSC 8 http links open with ⌘/Ctrl-click (noopener); javascript: never; paths inside the workspace open a menu (Download, the editor, Copy path); outside ones aren't links", async () => {
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
      ["https://example.test/docs", "_blank", "noopener noreferrer"],
      ["https://example.test/osc", "_blank", "noopener noreferrer"],
    ]);
    // javascript: does nothing.
    await modClick(p, "planner", 6, 2);
    await p.waitForTimeout(300);
    expect((await opened(p)).length).toBe(2);
    // A path: its menu (AG-DROP-2). With editor_open none: Download and
    // Copy path, no editor; Copy path copies its absolute path.
    await modClick(p, "planner", 6, 3);
    const menu = p.locator('.den-pop[role="menu"]');
    await menu.waitFor();
    expect(await menu.locator(".den-mi").allTextContents()).toEqual([
      "Download",
      "Copy path",
    ]);
    await menu.getByRole("menuitem", { name: "Copy path" }).click();
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
    const qm = q.locator('.den-pop[role="menu"]');
    await qm.waitFor();
    expect(await qm.locator(".den-mi").allTextContents()).toEqual([
      "Download",
      "Open in Zed",
      "Copy path",
    ]);
    await qm.getByRole("menuitem", { name: "Open in Zed" }).click();
    await eventually(async () => (await opened(q)).length === 1);
    expect(await opened(q)).toEqual([[`zed://file${abs}:10`, "_self"]]);
    expect(await copied(q)).toEqual([]);
    await q.context().close();
    await s!.settings({ editor_open: null });
  }, 90_000);

  it("D35: a ⌘/Ctrl-click on a URL opens a real new tab, noopener (no stub: Safari's engine too)", async () => {
    if (skip()) return;
    const p = await page(`/agents?open=${sid.planner}&layout=tabs`, false);
    await p.waitForSelector(`.pane[data-id="${sid.planner}"] .xterm-screen`);
    // Sent again until the pane shows it (its socket may still be opening).
    await eventually(async () => {
      pty("planner").emit(
        `\u001b[2J\u001b[Hurl ${s!.base}/d35 here\r\n` +
          `osc \u001b]8;;${s!.base}/d35-osc\u0007OSC LINK\u001b]8;;\u0007 end\r\n`,
      );
      await new Promise((r) => setTimeout(r, 500));
      return p.evaluate(
        (i) =>
          (
            document.querySelector(`.pane[data-id="${i}"] .xterm-rows`)
              ?.textContent ?? ""
          )
            .replace(/\u00a0/g, " ")
            .includes("OSC LINK"),
        sid.planner,
      );
    }, 20_000);
    for (const [row, want] of [
      [0, `${s!.base}/d35`],
      [1, `${s!.base}/d35-osc`],
    ] as const) {
      expect(await linkAt(p, "planner", 10, row)).toBe(true);
      const popup = p.context().waitForEvent("page", { timeout: 5_000 });
      await modClick(p, "planner", 10, row);
      const tab = await popup;
      // Where it went (Den answers 404 there: the navigation is enough).
      await eventually(() => tab.url() !== "about:blank", 5_000).catch(
        () => undefined,
      );
      expect(tab.url()).toBe(want);
      // noopener: the new tab has no handle back to Den.
      expect(
        await tab.evaluate(() => window.opener === null).catch(() => true),
      ).toBe(true);
      await tab.close();
    }
    // The hover hint says how.
    const at = await cell(p, "planner", 10, 0);
    await p.mouse.move(at.x, at.y + 400);
    await p.mouse.move(at.x, at.y, { steps: 2 });
    await eventually(
      async () =>
        (await p
          .locator(`.pane[data-id="${sid.planner}"] .term`)
          .getAttribute("title")) ===
        (MOD === "Meta" ? "⌘-click to open" : "Ctrl-click to open"),
      3_000,
    );
    await p.mouse.move(at.x, at.y + 400);
    await eventually(
      async () =>
        !(await p
          .locator(`.pane[data-id="${sid.planner}"] .term`)
          .getAttribute("title")),
      3_000,
    );
    await p.context().close();
  }, 60_000);

  describe("D40: picking an agent puts the keyboard in its terminal", () => {
    const row = (id: string) => `#agl .agr[data-id="${sid[id]}"]`;
    /** Type `text` where the keyboard is, and say which pty got it. */
    async function typedInto(p: Page, text: string): Promise<string[]> {
      const from = Object.fromEntries(
        Object.keys(sid).map((id) => [id, pty(id).writes.length]),
      );
      await p.keyboard.type(text);
      await new Promise((r) => setTimeout(r, 400));
      return Object.keys(sid).filter((id) =>
        typed(id, from[id]).includes(text),
      );
    }

    /**
     * Hold every terminal socket's open, and the frames after it, until
     * releaseIo: a slow socket. Reload the page after.
     */
    async function holdIo(p: Page): Promise<void> {
      await p.context().addInitScript(() => {
        const W = window.WebSocket;
        const held: { k: string; f: () => void }[] = [];
        const go = new Set<string>();
        // Open first, then (on a second call) the frames: a socket whose
        // first frame comes late.
        (
          window as unknown as { __releaseIo: (k: string[]) => void }
        ).__releaseIo = (ks) => {
          for (const k of ks) go.add(k);
          for (const h of held.splice(0))
            if (go.has(h.k)) h.f();
            else held.push(h);
        };
        class Held extends W {
          constructor(url: string | URL, prot?: string | string[]) {
            super(url, prot);
            if (!String(url).endsWith("/io")) return;
            const fns: Record<string, ((e: Event) => void) | null> = {
              open: null,
              message: null,
            };
            for (const k of ["open", "message"] as const) {
              Object.defineProperty(this, `on${k}`, {
                get: () => fns[k],
                set: (f) => (fns[k] = f),
              });
              super.addEventListener(k, (e) => {
                const f = () => fns[k]?.call(this, e);
                if (go.has(k)) f();
                else held.push({ k, f });
              });
            }
            Object.defineProperty(this, "readyState", {
              get: () => (go.has("open") ? super.readyState : W.CONNECTING),
            });
          }
        }
        window.WebSocket = Held as typeof WebSocket;
      });
    }
    const releaseIo = async (p: Page, gapMs = 0) => {
      const rel = (ks: string[]) =>
        p.evaluate(
          (k) =>
            (
              window as unknown as { __releaseIo: (k: string[]) => void }
            ).__releaseIo(k),
          ks,
        );
      await rel(gapMs ? ["open"] : ["open", "message"]);
      if (gapMs) {
        await new Promise((r) => setTimeout(r, gapMs));
        await rel(["message"]);
      }
    };

    it("D43: a link to a running agent (?agent=&ws=) opens its pane, and typing reaches it", async () => {
      if (skip()) return;
      const p = await page(`/agents?layout=focus&ws=north&agent=planner`);
      await p.waitForSelector(`.pane[data-id="${sid.planner}"] .xterm-rows`);
      await eventually(async () =>
        (await typedInto(p, "l1")).includes("planner"),
      );
      expect(await typedInto(p, "l2")).toEqual(["planner"]);
      const q = new URL(p.url()).searchParams;
      expect(q.has("agent")).toBe(false);
      expect(q.get("open")).toBe(sid.planner);
      await p.context().close();
    }, 60_000);

    it("a new pane: click the row, type, and the agent gets it", async () => {
      if (skip()) return;
      const p = await page(`/agents?layout=focus`);
      await p.click(row("planner"));
      await p.waitForSelector(`.pane[data-id="${sid.planner}"] .xterm-rows`);
      await eventually(async () => (await typedInto(p, "q1")).length > 0);
      expect(await typedInto(p, "q2")).toEqual(["planner"]);
      await p.context().close();
    }, 60_000);

    it("a pane already open: picking its row takes the keyboard there", async () => {
      if (skip()) return;
      const p = await page(
        `/agents?open=${sid.planner},${sid.coder}&layout=tabs`,
      );
      for (const id of ["planner", "coder"])
        await p.waitForSelector(`.pane[data-id="${sid[id]}"] .xterm-rows`, {
          state: "attached",
        });
      await p.click(row("coder"));
      await eventually(async () =>
        (await typedInto(p, "c1")).includes("coder"),
      );
      await p.click(row("planner"));
      await eventually(async () =>
        (await typedInto(p, "p1")).includes("planner"),
      );
      expect(await typedInto(p, "p2")).toEqual(["planner"]);
      await p.context().close();
    }, 60_000);

    it("an add (Shift-click) keeps the keyboard where it was", async () => {
      if (skip()) return;
      const p = await page(`/agents?layout=focus`);
      await p.click(row("planner"));
      await p.waitForSelector(`.pane[data-id="${sid.planner}"] .xterm-rows`);
      await eventually(async () =>
        (await typedInto(p, "a1")).includes("planner"),
      );
      await p.click(row("coder"), { modifiers: ["Shift"] });
      await p.waitForSelector(`.pane[data-id="${sid.coder}"] .xterm-rows`);
      await new Promise((r) => setTimeout(r, 300));
      expect(await typedInto(p, "a2")).toEqual(["planner"]);
      // Its pane already open: the same.
      await p.click(row("coder"), { modifiers: ["Shift"] });
      await new Promise((r) => setTimeout(r, 300));
      expect(await typedInto(p, "a3")).toEqual(["planner"]);
      await p.context().close();
    }, 60_000);

    for (const how of ["click", "Tab"] as const)
      it(`a pick whose socket opens late doesn't take the keyboard once the person has gone elsewhere (${how})`, async () => {
        if (skip()) return;
        const p = await page(`/agents?layout=focus`);
        await holdIo(p);
        await p.reload();
        await p.waitForSelector(row("planner"));
        await p.click(row("planner"));
        await p.waitForSelector(`.pane[data-id="${sid.planner}"] .xterm-rows`);
        // Elsewhere: the list's heading, not a row (a click that picks nothing).
        if (how === "click")
          await p.locator("#agl").click({ position: { x: 4, y: 2 } });
        else await p.keyboard.press("Tab");
        await releaseIo(p);
        await new Promise((r) => setTimeout(r, 500));
        expect(
          await p.evaluate(() => !!document.activeElement?.closest(".pane")),
        ).toBe(false);
        expect(await typedInto(p, "z1")).toEqual([]);
        await p.context().close();
      }, 60_000);

    for (const [where, url, width] of [
      ["at 375px (Tabs, one pane in sight)", "/agents?layout=focus", 375],
      ["in Tabs at 1440", "/agents?layout=tabs", 1440],
    ] as const)
      it(`an add ${where}: the added pane is in front, and the keyboard goes there`, async () => {
        if (skip()) return;
        const p = await page(url);
        await p.setViewportSize({ width, height: 800 });
        await p.click(row("planner"));
        await p.waitForSelector(`.pane[data-id="${sid.planner}"] .xterm-rows`);
        await eventually(async () =>
          (await typedInto(p, "n1")).includes("planner"),
        );
        await p.click(row("coder"), { modifiers: ["Shift"] });
        await p.waitForSelector(`.pane[data-id="${sid.coder}"] .xterm-rows`);
        await eventually(async () =>
          (await typedInto(p, "n2")).includes("coder"),
        );
        expect(await typedInto(p, "n3")).toEqual(["coder"]);
        await p.context().close();
      }, 60_000);

    it("a stopped agent's row never puts the keyboard in its ended pane, even after a pick whose socket is slow", async () => {
      if (skip()) return;
      // An agent whose session has ended (its output kept).
      const info = await host!.start({
        name: "acme-north:ender",
        cwd: s!.wsDir("north"),
        argv: ["sh"],
        env: {},
        cols: 80,
        rows: 24,
      });
      sid.ender = info.ref.id;
      pid.ender = info.pid;
      s!.seed({
        id: "ender",
        persona: "builder",
        runtime: "den-claude",
        workspace: "north",
        session: { backend: "den-pty", id: info.ref.id },
        sessionName: "acme-north:ender",
        resumeToken: "6a0c2d1e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
      });
      pty("ender").emit("ender done\r\n");
      pty("ender").exit(0);
      for (const slow of [false, true]) {
        const p = await page(`/agents?layout=focus`);
        if (slow) {
          await holdIo(p);
          await p.reload();
        }
        await p.waitForSelector(row("ender"));
        await p.click(row("planner"));
        await p.click(row("ender"));
        // Slow: the socket opens, and its first frame (ended) comes later.
        if (slow) await releaseIo(p, 300);
        await new Promise((r) => setTimeout(r, 600));
        expect(
          await p.evaluate(
            (id) => !!document.activeElement?.closest(`.pane[data-id="${id}"]`),
            sid.ender,
          ),
        ).toBe(false);
        await p.context().close();
      }
    }, 60_000);
  });

  it("D47: a den-claude pane says which services it reaches only through their API; a codex pane says it isn't held to it", async () => {
    if (skip()) return;
    const rules = path.join(s!.stateDir, "guardrails", "api-only.json");
    const tag = (p: Page, id: string) =>
      p.locator(`.pane[data-id="${sid[id]}"] .bar2 [data-api-only]`);
    // None declared: no tag.
    let p = await page(`/agents?open=${sid.planner}&layout=focus`);
    await p.waitForSelector(`.pane[data-id="${sid.planner}"] .bar2 b`);
    expect(await tag(p, "planner").count()).toBe(0);
    await p.context().close();
    fs.mkdirSync(path.dirname(rules), { recursive: true });
    fs.writeFileSync(
      rules,
      JSON.stringify({ services: [{ name: "vault", project: "vault" }] }),
    );
    try {
      p = await page(`/agents?open=${sid.planner}&layout=focus`);
      await tag(p, "planner").waitFor({ timeout: 15_000 });
      expect(await tag(p, "planner").textContent()).toBe("API only: vault");
      expect(await tag(p, "planner").getAttribute("title")).toContain(
        "A guardrail, not a security boundary",
      );
      await p.context().close();
      p = await page(`/agents?open=${sid.coder}&layout=focus`);
      await tag(p, "coder").waitFor({ timeout: 15_000 });
      expect(await tag(p, "coder").textContent()).toBe("API-only not enforced");
      expect(await tag(p, "coder").getAttribute("data-api-only")).toBe("off");
      await p.context().close();
    } finally {
      fs.rmSync(rules, { force: true });
    }
  }, 60_000);

  it("D44: a running agent whose tools predate Hub's Connect says so, on its row and pane; Restart asks for it at its next idle", async () => {
    if (skip()) return;
    const p = await page(`/agents?open=${sid.planner}&layout=focus`);
    await p.route("**/api/sessions*", async (r) => {
      // A poll in flight when the page reloads is dropped (its response is
      // disposed); the next one carries it.
      try {
        const res = await r.fetch();
        const body = (await res.json()) as {
          sessions: { agent?: string; mcpStale?: unknown }[];
        };
        for (const x of body.sessions)
          if (x.agent === "planner") x.mcpStale = { adds: ["hub"], drops: [] };
        await r.fulfill({ response: res, json: body });
      } catch {
        await r.abort().catch(() => undefined);
      }
    });
    const posted: { url: string; body: unknown }[] = [];
    await p.route("**/agents/planner/restart", (r) => {
      posted.push({
        url: new URL(r.request().url()).pathname,
        body: r.request().postDataJSON(),
      });
      return r.fulfill({
        status: 202,
        contentType: "application/json",
        body: '{"ok":true,"agent":"planner","pending":true}',
      });
    });
    await p.reload();
    const row = (id: string) => `#agl .agr[data-id="${sid[id]}"]`;
    const bar = `.pane[data-id="${sid.planner}"] .bar2`;
    await p.waitForSelector(`${bar} [data-mcp-stale="adds"]`, {
      timeout: 15_000,
    });
    expect(await p.textContent(`${bar} [data-mcp-stale]`)).toBe(
      "Hub tools arrive on restart",
    );
    expect(await p.textContent(`${row("planner")} [data-mcp-stale]`)).toBe(
      "Hub tools arrive on restart",
    );
    // Not on the codex agent, whose tools are current.
    expect(await p.locator(`${row("coder")} [data-mcp-stale]`).count()).toBe(0);
    await p.click(`${bar} [data-act="tools-restart"]`);
    await p.waitForFunction(() =>
      /restarts at its next idle/.test(document.body.textContent ?? ""),
    );
    expect(posted).toEqual([
      {
        url: "/api/workspaces/north/agents/planner/restart",
        body: { when: "after-turn" },
      },
    ]);
    await p.context().close();
  }, 60_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
