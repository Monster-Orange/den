/**
 * The Agents tab (AG-4a-term, AG spec §5d) in a real browser:
 *
 *   - the layout, measured against the prototype (den-shell.html's
 *     /agents at 1440x900: a 300px list beside the panes, 14px apart; the
 *     row fills the window to 14px above the runs dock (AG-4b, Ward
 *     2026-11-07: not the prototype's 100vh - 300px); at 390px one column,
 *     no sideways scroll);
 *   - the list, grouped by workspace and following ?ws=, plain sessions
 *     labelled "session", a revoked token marked;
 *   - a pane: the scrollback first, then live output, keystrokes to the
 *     session; up to four tile, the URL holds them (?open=), a fifth closes
 *     the oldest; Close detaches and never kills; an agent's pane is
 *     titled with its id, never its persona;
 *   - leaving the page detaches, and coming back reattaches with what was
 *     missed;
 *   - ⌘K offers each session ("Agents › <ws> / <name>") and Start agent;
 *   - no page errors.
 *
 * The demo distribution (acme; north, south) with a session host in this
 * process and a scripted PTY (helpers/agents-page-server.ts): nothing
 * really runs. On localhost nothing asks to sign in. No token, cookie or
 * CSRF value is printed. DEN_AGENTS_SHOTS=<dir> writes screenshots.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  bindActorSession,
  mintActorToken,
  revokeAllActorTokens,
} from "../../../src/shared/actor-token.js";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import type { SessionInfo } from "../../../src/shared/sessions/types.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let browser: Browser | null = null;
let latest = "";
const sess: Record<string, SessionInfo> = {};
const SHOTS = process.env.DEN_AGENTS_SHOTS;
// The server checks the PTY module is there before it starts an agent.
const PTY = loadPty().available;

const start = async (ws: string, name: string) => {
  const info = await host!.start({
    name: `acme-${ws}:${name}`,
    cwd: s!.wsDir(ws),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  sess[name] = info;
  return s!.made[s!.made.length - 1];
};
const pty = (name: string) => s!.made.find((p) => p.pid === sess[name].pid)!;
const id = (name: string) => sess[name].ref.id;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  // west: in workspaces.yml, not active.
  s = await startAgentsPageServer({ inactive: ["west"] });
  host = await connectHost(sessionPaths(s.stateDir).socket);
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  (await start("north", "shell")).emit("hello from north\r\n$ ");
  (await start("south", "logs")).emit("tail of south\r\n");
  await start("north", "build");
  await start("south", "watch");
  // An agent on a live session whose token `web logout --all` revoked.
  await start("north", "scout");
  s.seed({
    id: "scout",
    persona: "reviewer",
    workspace: "north",
    session: { backend: "den-pty", id: sess.scout.ref.id },
    sessionName: "acme-north:scout",
  });
  const k = mintActorToken(s.stateDir, {
    agentId: "scout",
    workspace: "north",
    sessionName: "acme-north:scout",
  });
  bindActorSession(s.stateDir, k.key, sess.scout.ref.id);
  revokeAllActorTokens(s.stateDir);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  host?.close();
  await s?.stop();
});

const skip = () => !browser;
const errors: string[] = [];

async function page(
  url: string,
  opts: { width?: number; height?: number; dark?: boolean } = {},
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 },
    reducedMotion: "reduce",
    colorScheme: opts.dark ? "dark" : "light",
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
    // The browser's own line for the 401 the signed-out test answers.
    if (m.type() === "error" && !/status of 401/.test(m.text()))
      errors.push(`${url}: console: ${m.text()}`);
  });
  await p.goto(`${s!.base}${url}`);
  await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
  return p;
}

const box = async (p: Page, sel: string) =>
  (await p.locator(sel).boundingBox())!;
const termText = (p: Page, sid: string) =>
  p
    .locator(`.pane[data-id="${sid}"] .xterm-rows`)
    .textContent()
    .then((x) => x ?? "");
async function waitTerm(p: Page, sid: string, text: string): Promise<void> {
  await p.waitForFunction(
    ([i, t]) =>
      (
        document.querySelector(`.pane[data-id="${i}"] .xterm-rows`)
          ?.textContent ?? ""
      ).includes(t),
    [sid, text],
    { timeout: 10_000 },
  );
}
const openIds = (p: Page) =>
  (new URL(p.url()).searchParams.get("open") ?? "").split(",").filter(Boolean);

describe("the Agents tab", () => {
  it("matches the prototype's layout at 1440x900: a 300px list, 14px gap, the row down to 14px above the runs dock", async () => {
    if (skip()) return;
    const p = await page("/agents");
    const [agx, agl, agr, dock] = await Promise.all([
      box(p, "#agx"),
      box(p, "#agl"),
      box(p, "#agr"),
      box(p, "#den-dock"),
    ]);
    expect(Math.abs(agl.width - 300)).toBeLessThanOrEqual(1);
    expect(Math.abs(agx.y + agx.height - (dock.y - 14))).toBeLessThanOrEqual(
      0.5,
    );
    expect(Math.abs(agl.height - agx.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(agr.x - (agl.x + agl.width + 14))).toBeLessThanOrEqual(1);
    expect(
      Math.abs(agr.x + agr.width - (agx.x + agx.width)),
    ).toBeLessThanOrEqual(1);
    // The prototype's panes are 845 wide beside its rail (a tolerance for
    // the rail and the scrollbar: it is the remainder, not a constant).
    expect(Math.abs(agr.width - 845)).toBeLessThanOrEqual(24);
    // The rail: Agents under Develop, after Graph, current here.
    expect(
      await p.$$eval(".den-rail [data-nav]", (as) =>
        as.map((a) => (a as HTMLElement).dataset.nav),
      ),
    ).toEqual(expect.arrayContaining(["graph", "agents"]));
    const navs = await p.$$eval(".den-rail [data-nav]", (as) =>
      as.map((a) => (a as HTMLElement).dataset.nav),
    );
    expect(navs.indexOf("agents")).toBe(navs.indexOf("graph") + 1);
    expect(
      await p.getAttribute('.den-rail [data-nav="agents"]', "aria-current"),
    ).toBe("page");
    expect((await p.textContent("#ag-h"))?.trim()).toBe("Agents");
    if (SHOTS)
      await p.screenshot({ path: path.join(SHOTS, "agents-empty-light.png") });
    await p.context().close();
  }, 45_000);

  it("lists sessions and agents by workspace: plain ones labelled session, the revoked token marked; ?ws= narrows it", async () => {
    if (skip()) return;
    const p = await page("/agents");
    expect(
      await p.$$eval(".wsg", (gs) =>
        gs.map((g) => (g as HTMLElement).dataset.ws),
      ),
    ).toEqual(["north", "south"]);
    const shell = p.locator(`.agr[data-id="${id("shell")}"]`);
    expect(await shell.locator(".sbdg").textContent()).toBe("session");
    expect(await shell.locator(".st").textContent()).toBe("running");
    const scout = p.locator(`.agr[data-id="${id("scout")}"]`);
    expect(await scout.getAttribute("data-kind")).toBe("agent");
    expect((await scout.locator(".nm").textContent())?.trim()).toBe(
      "reviewer scout",
    );
    expect(await scout.locator(".tagx.warn").textContent()).toBe(
      "token revoked",
    );
    expect(await p.textContent("#ag-count")).toBe(
      "5 sessions · 0 waiting · all workspaces",
    );
    await p.goto(`${s!.base}/agents?ws=south`);
    await p.waitForSelector("#agl:not([aria-busy]) .agr");
    expect(
      await p.$$eval(".wsg", (gs) =>
        gs.map((g) => (g as HTMLElement).dataset.ws),
      ),
    ).toEqual(["south"]);
    expect(await p.textContent("#ag-count")).toBe(
      "2 sessions · 0 waiting · south",
    );
    await p.context().close();
  }, 45_000);

  it("a pane: scrollback, then live output; keys reach the session; up to four tile in the URL, a fifth closes the oldest; Close detaches", async () => {
    if (skip()) return;
    // Tile (AG-4b): each click adds a pane.
    const p = await page("/agents?layout=tile");
    await p.click(`.agr[data-id="${id("shell")}"]`);
    await waitTerm(p, id("shell"), "hello from north");
    expect(openIds(p)).toEqual([id("shell")]);
    expect(await p.getAttribute("#agr", "class")).toBe("agp n1");
    // The pane fills the row.
    const [agr, pane] = await Promise.all([
      box(p, "#agr"),
      box(p, `.pane[data-id="${id("shell")}"]`),
    ]);
    expect(Math.abs(pane.height - agr.height)).toBeLessThanOrEqual(1);
    pty("shell").emit("live line\r\n");
    await waitTerm(p, id("shell"), "live line");
    await p.click(`.pane[data-id="${id("shell")}"] .term`);
    await p.keyboard.type("ls");
    await expectEventually(() =>
      Buffer.concat(pty("shell").writes).toString().includes("ls"),
    );
    // The terminal's size followed the pane.
    await expectEventually(() => pty("shell").resizes.length > 0);
    const [cols, rows] = pty("shell").resizes.at(-1)!;
    expect(cols).toBeGreaterThan(40);
    expect(rows).toBeGreaterThan(10);

    for (const n of ["logs", "build", "watch"])
      await p.click(`.agr[data-id="${id(n)}"]`);
    await waitTerm(p, id("logs"), "tail of south");
    expect(await p.getAttribute("#agr", "class")).toBe("agp n4");
    expect(openIds(p)).toEqual([
      id("shell"),
      id("logs"),
      id("build"),
      id("watch"),
    ]);
    // 2x2: two columns, two rows, the same size.
    const boxes = await Promise.all(
      ["shell", "logs", "build", "watch"].map((n) =>
        box(p, `.pane[data-id="${id(n)}"]`),
      ),
    );
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(1);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y + boxes[0].height);
    expect(Math.abs(boxes[0].width - boxes[3].width)).toBeLessThanOrEqual(1);
    if (SHOTS)
      await p.screenshot({ path: path.join(SHOTS, "agents-light.png") });

    // A fifth: the oldest pane closes (its session keeps running).
    await p.click(`.agr[data-id="${id("scout")}"]`);
    await p.waitForSelector(`.pane[data-id="${id("scout")}"]`);
    expect(openIds(p)).toEqual([
      id("logs"),
      id("build"),
      id("watch"),
      id("scout"),
    ]);
    expect(await p.locator(`.pane[data-id="${id("shell")}"]`).count()).toBe(0);
    // Its title and Close name the agent (its id until AG-10's display
    // name), never its persona ("reviewer"); the list row keeps the persona.
    expect(
      (await p.textContent(`.pane[data-id="${id("scout")}"] .bar2 b`))?.trim(),
    ).toBe("scout");
    expect(
      await p.getAttribute(
        `.pane[data-id="${id("scout")}"] [data-act="close"]`,
        "aria-label",
      ),
    ).toBe("Close scout's pane (it keeps running)");
    // The agent's pane has Stop; a plain session's doesn't.
    expect(
      await p
        .locator(`.pane[data-id="${id("scout")}"] [data-act="stop"]`)
        .count(),
    ).toBe(1);
    expect(
      await p
        .locator(`.pane[data-id="${id("logs")}"] [data-act="stop"]`)
        .count(),
    ).toBe(0);

    // Close: the pane goes, the URL follows, the session still runs.
    await p
      .getByRole("button", { name: "Close logs's pane (it keeps running)" })
      .click();
    expect(openIds(p)).toEqual([id("build"), id("watch"), id("scout")]);
    expect(await p.getAttribute("#agr", "class")).toBe("agp n3");
    await new Promise((r) => setTimeout(r, 200));
    expect(pty("logs").signals).toEqual([]);
    expect(pty("shell").signals).toEqual([]);
    const listed = await host!.list();
    const logs = listed.find((x) => x.ref.id === id("logs"));
    expect(logs).toBeDefined();
    expect(logs?.exited ?? false).toBe(false);
    await p.context().close();
  }, 60_000);

  it("leaving the page detaches; coming back reattaches from ?open= with what was missed", async () => {
    if (skip()) return;
    const p = await page(`/agents?open=${id("shell")}`);
    await waitTerm(p, id("shell"), "hello from north");
    await p.goto(`${s!.base}/edge`);
    pty("shell").emit("while you were away\r\n");
    await p.goBack();
    await p.waitForSelector(`.pane[data-id="${id("shell")}"] .xterm-rows`);
    await waitTerm(p, id("shell"), "while you were away");
    expect(await termText(p, id("shell"))).toContain("hello from north");
    expect(pty("shell").signals).toEqual([]);
    await p.context().close();
  }, 45_000);

  it("at 390px: one column, the pane under the list, no sideways scroll", async () => {
    if (skip()) return;
    const p = await page(`/agents?open=${id("shell")}`, {
      width: 390,
      height: 844,
    });
    await waitTerm(p, id("shell"), "hello from north");
    const [agl, pane] = await Promise.all([
      box(p, "#agl"),
      box(p, `.pane[data-id="${id("shell")}"]`),
    ]);
    expect(Math.abs(agl.x - pane.x)).toBeLessThanOrEqual(1);
    expect(pane.y).toBeGreaterThanOrEqual(agl.y + agl.height);
    expect(pane.height).toBeGreaterThanOrEqual(259);
    const over = await p.evaluate(() => {
      const c = document.getElementById("den-content")!;
      return {
        doc:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        content: c.scrollWidth - c.clientWidth,
      };
    });
    expect(over.doc).toBeLessThanOrEqual(0);
    expect(over.content).toBeLessThanOrEqual(0);
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "agents-390.png") });
    await p.context().close();
  }, 45_000);

  it("in dark mode the terminal takes the theme's colours", async () => {
    if (skip()) return;
    const p = await page(
      `/agents?open=${id("shell")},${id("scout")}&layout=tile`,
      {
        dark: true,
      },
    );
    await waitTerm(p, id("shell"), "hello from north");
    expect(await p.getAttribute("html", "data-mode")).toBe("dark");
    const [bg, sunken] = await p.evaluate((sid) => {
      // xterm draws on its scrollable element; its viewport (xterm.css:
      // black) must not show at the edges either.
      const els = [".xterm-scrollable-element", ".xterm-viewport"].map((c) =>
        document.querySelector(`.pane[data-id="${sid}"] ${c}`),
      );
      const probe = document.createElement("div");
      probe.style.background = "var(--sunken)";
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return [
        els.map((v) => (v ? getComputedStyle(v).backgroundColor : "")),
        want,
      ];
    }, id("shell"));
    expect(bg).toEqual([sunken, sunken]);
    if (SHOTS)
      await p.screenshot({ path: path.join(SHOTS, "agents-dark.png") });
    await p.context().close();
  }, 45_000);

  it("⌘K offers each session as Agents › <ws> / <name>, and Start agent…", async () => {
    if (skip()) return;
    const p = await page("/agents");
    await p.click("#den-search");
    await p.fill("#den-pal-q", "north / shell");
    await p.waitForSelector('#den-pal-list li[role="option"]');
    const first = p.locator('#den-pal-list li[role="option"]').first();
    expect(await first.locator(".den-pal-l").textContent()).toBe(
      "Agents › north / shell",
    );
    expect(await first.locator(".den-kind").textContent()).toBe("Agent");
    await p.fill("#den-pal-q", "start agent");
    await p.waitForFunction(() =>
      [...document.querySelectorAll("#den-pal-list .den-pal-l")].some(
        (e) => e.textContent === "Start agent…",
      ),
    );
    await p.fill("#den-pal-q", "north / shell");
    await p.waitForSelector('#den-pal-list li[role="option"]');
    await p.keyboard.press("Enter");
    await p.waitForURL((u) => u.searchParams.get("open") === id("shell"));
    await waitTerm(p, id("shell"), "hello from north");
    await p.context().close();
  }, 45_000);

  it("signed out (the list answers 401): the Sign in row, and no terminal opens; without the PTY module, says so", async () => {
    if (skip()) return;
    const p = await page("/agents");
    await p.route("**/api/sessions", (r) =>
      r.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "sign in", code: "signin_required" }),
      }),
    );
    await p.goto(`${s!.base}/agents?open=${id("shell")}`);
    await p.waitForSelector('#agl [data-note="signin"]');
    expect(await p.textContent('#agl [data-note="signin"]')).toBe(
      "Sign in to open terminals: run acme web login",
    );
    expect(await p.locator(".pane").count()).toBe(0);
    expect(openIds(p)).toEqual([]);
    // The PTY module absent (DIST_SMOKE_OMIT_OPTIONAL): the list still
    // shows, with the note, and nothing breaks.
    await p.unroute("**/api/sessions");
    await p.route("**/api/sessions", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await r.fulfill({
        response: res,
        body: JSON.stringify({
          ...body,
          backend: { id: "den-pty", available: false, reason: "absent" },
        }),
      });
    });
    await p.goto(`${s!.base}/agents`);
    await p.waitForSelector('#agl [data-note="backend"]');
    expect(await p.textContent('#agl [data-note="backend"]')).toContain(
      "acme doctor",
    );
    await p.context().close();
  }, 45_000);

  it.each([
    [1440, 900],
    [375, 812],
  ])(
    "AG-10.0: with a 200-character description, Cancel and Start sit inside the Start dialog at %ix%i",
    async (width, height) => {
      if (skip()) return;
      // An older answer: a role sentence and no category (normalized).
      const role = `${"Reviews every change for correctness ".repeat(6)}`.slice(
        0,
        200,
      );
      const p = await page("/agents", { width, height });
      // AG-0.5: the dialog asks for its workspace's (?workspace=).
      await p.route(/\/api\/personas(\?|$)/, (route) =>
        route.fulfill({
          json: {
            personas: [
              { id: "reviewer", role, standing: false, tools: [], context: [] },
              {
                id: "builder",
                role: "Builds it.",
                standing: false,
                tools: [],
                context: [],
              },
            ],
            runtimes: [
              {
                id: "den-claude",
                label: "Claude Code",
                available: true,
                resume: true,
                default: true,
              },
              {
                id: "generic",
                label: "Generic command",
                available: false,
                why: "no argv",
                resume: false,
                default: false,
              },
            ],
          },
        }),
      );
      await p.click("#ag-start");
      await p.waitForSelector("#ag-dlg[open]");
      const dlg = await box(p, "#ag-dlg");
      for (const sel of [
        "#ag-cancel",
        "#ag-go",
        "#ag-persona",
        "#ag-runtime",
      ]) {
        const b = await box(p, sel);
        expect(b.x).toBeGreaterThanOrEqual(dlg.x);
        expect(b.y).toBeGreaterThanOrEqual(dlg.y);
        expect(b.x + b.width).toBeLessThanOrEqual(dlg.x + dlg.width + 0.5);
        expect(b.y + b.height).toBeLessThanOrEqual(dlg.y + dlg.height + 0.5);
      }
      // AG-10.2: each row is the id with its one-line description, which
      // wraps inside the list; a pick checks it.
      expect(
        await p.$$eval("#ag-persona .pr .pn", (os) =>
          os.map((o) => o.textContent),
        ),
      ).toEqual(["reviewer", "builder", "Plain session"]);
      expect(await p.textContent('#ag-persona [data-pid="reviewer"] .pd')).toBe(
        role,
      );
      const list = await box(p, "#ag-persona");
      const row = await box(p, '#ag-persona [data-pid="reviewer"]');
      expect(row.x + row.width).toBeLessThanOrEqual(list.x + list.width + 0.5);
      await p.click('#ag-persona [data-pid="builder"]');
      expect(
        await p.getAttribute(
          '#ag-persona [data-pid="builder"]',
          "aria-checked",
        ),
      ).toBe("true");
      // The runtime names what it resolves to; one that can't run says why.
      expect(
        await p.$$eval("#ag-runtime option", (os) =>
          os.map((o) => [o.textContent, (o as HTMLOptionElement).disabled]),
        ),
      ).toEqual([
        ["Claude Code (persona default)", false],
        ["Claude Code", false],
        ["Generic command — no argv", true],
      ]);
      // Esc cancels.
      await p.keyboard.press("Escape");
      expect(await p.isVisible("#ag-dlg")).toBe(false);
      await p.context().close();
    },
  );

  it("Start agent (?start=1 opens the dialog): asks for the workspace under All, starts it, and opens its pane", async () => {
    if (skip() || !PTY) return;
    // Room under the host's cap (agents.max_concurrent): two sessions end.
    pty("build").exit(0);
    pty("watch").exit(0);
    const p = await page("/agents?start=1");
    await p.waitForSelector("#ag-dlg[open]");
    expect(await p.isVisible("#ag-ws-l")).toBe(true);
    await p.waitForSelector('#ag-persona [data-pid="planner"]');
    await p.selectOption("#ag-ws", "south");
    await p.waitForSelector('#ag-persona [data-pid="planner"]');
    await p.click('#ag-persona [data-pid="planner"]');
    await p.selectOption("#ag-runtime", "den-claude");
    const made = s!.made.length;
    const [res] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/workspaces/south/agents",
        { timeout: 20_000 },
      ),
      // AG-10.0: Enter on a field starts it.
      p.press("#ag-runtime", "Enter"),
    ]);
    expect(res.status()).toBe(200);
    const sid = ((await res.json()) as { agent: { sessionId: string } }).agent
      .sessionId;
    await p.waitForSelector(`.pane[data-id="${sid}"] .xterm-rows`);
    expect(openIds(p)).toEqual([sid]);
    expect(s!.made.length).toBe(made + 1);
    expect(await p.isVisible("#ag-dlg")).toBe(false);
    await p.context().close();
  }, 60_000);

  it("0.4.17: an agent links back to its workspace: the pane header, the list's group, and ⌘K Go to workspace", async () => {
    if (skip()) return;
    const p = await page(`/agents?open=${id("scout")}`);
    const head = `.pane[data-id="${id("scout")}"] .bar2 .where a.wslink`;
    await p.waitForSelector(head);
    expect(await p.getAttribute(head, "href")).toBe("/local-dev?ws=north");
    expect(await p.textContent(head)).toBe("north");
    const group = '#agl .wsg[data-ws="north"] .wsh a.wslink';
    expect(await p.getAttribute(group, "href")).toBe("/local-dev?ws=north");
    // ⌘K: an agent's name finds its workspace.
    await p.click("#den-search");
    await p.fill("#den-pal-q", "scout");
    await p.waitForFunction(() =>
      [...document.querySelectorAll("#den-pal-list .den-pal-l")].some(
        (e) => e.textContent === "Go to workspace north",
      ),
    );
    await p.fill("#den-pal-q", "go to workspace north");
    const opt = p
      .locator('#den-pal-list li[role="option"]')
      .filter({ hasText: "Go to workspace north" })
      .first();
    expect(await opt.locator(".den-kind").textContent()).toBe("Workspace");
    await opt.click();
    await p.waitForURL(
      (u) =>
        u.pathname === "/local-dev" && u.searchParams.get("ws") === "north",
    );
    await p.context().close();
  }, 45_000);

  it("0.4.17: a pane in a workspace that isn't active opens; a refused one says why; Sign in only when the person is signed out", async () => {
    if (skip()) return;
    fs.mkdirSync(s!.wsDir("west"), { recursive: true });
    (await start("west", "night")).emit("from west\r\n");
    const p = await page(`/agents?ws=west&open=${id("night")}`);
    await waitTerm(p, id("night"), "from west");
    await p.context().close();

    // A session the list shows but the io route refuses: its real reason.
    const url = "/agents?open=gone1";
    const q = await page(url);
    await q.route("**/api/sessions", async (r) => {
      const res = await r.fetch();
      const body = (await res.json()) as {
        sessions: Record<string, unknown>[];
      };
      const shell = body.sessions.find((x) => x.id === id("shell"))!;
      await r.fulfill({
        response: res,
        body: JSON.stringify({
          ...body,
          sessions: [
            ...body.sessions,
            { ...shell, id: "gone1", name: "acme-north:gone1", label: "gone1" },
          ],
        }),
      });
    });
    await q.goto(`${s!.base}${url}`);
    await waitTerm(q, "gone1", 'disconnected: no session "gone1" here');
    expect(await termText(q, "gone1")).not.toContain("Sign in");
    // Signed out (the route answers 401): then, and only then, Sign in.
    await q.route("**/api/sessions/gone1/io", (r) =>
      r.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "sign in", code: "signin_required" }),
      }),
    );
    await q.reload();
    await waitTerm(q, "gone1", "Sign in to open terminals: run acme web login");
    await q.context().close();
    // The refusals the browser logs on its own are this test's, expected.
    for (let i = errors.length - 1; i >= 0; i--)
      if (errors[i].startsWith(`${url}:`)) errors.splice(i, 1);
  }, 60_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});

async function expectEventually(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
