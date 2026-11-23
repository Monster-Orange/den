/**
 * Issue 168 (mock v2) in a real browser: each project has a colour and its
 * agents inherit it.
 *
 *   - two projects have different colours by default, and the same after
 *     a reload: each agent's row edge and letter tile, its project's group
 *     heading, its tab, its pane's band and its To line;
 *   - the top bar's project chip carries the project in view's colour;
 *   - the agent in front is outlined and bold, never an orange edge;
 *   - a person chooses a colour from the project's dot in Manage projects
 *     (the eight and Automatic): it survives a reload, in en, es and ja,
 *     at 1440 and 390; Settings › Project setup says it by name;
 *   - a colour chosen in one tab repaints another tab's top bar chip and
 *     agents at once, with no reload.
 *
 * Subjects: shell-prefs.ts (the saved colours) and theme-runtime.ts (the
 * colour tokens), with public/project-colour-picker.js.
 *
 * The demo distribution (acme; north, south) with a scripted PTY
 * (helpers/agents-page-server.ts). Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";
import { NotificationStore } from "../../../src/shared/notifications.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let browser: Browser | null = null;
let latest = "";
const errors: string[] = [];

/** Two agents, one in each project: id, persona, workspace. */
const AGENTS = [
  ["planner", "planner", "north"],
  ["builder", "builder", "south"],
] as const;
const sid: Record<string, string> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    browser = await launchBrowser(pw.chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  host = await connectHost(sessionPaths(s.stateDir).socket);
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
  for (const [id, persona, ws] of AGENTS) {
    const info = await host.start({
      name: `acme-${ws}:${id}`,
      cwd: s.wsDir(ws),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    sid[id] = info.ref.id;
    s.made[s.made.length - 1].emit(`${id} ready\r\n$ `);
    s.seed({
      id,
      persona,
      workspace: ws,
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: `acme-${ws}:${id}`,
    });
  }
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [host, s] });
});

const skip = () => !browser;

async function open(
  url: string,
  opts: {
    width?: number;
    before?: (ctx: BrowserContext) => Promise<void>;
  } = {},
): Promise<Page> {
  const width = opts.width ?? 1440;
  const ctx = await browser!.newContext({
    viewport: { width, height: width > 400 ? 900 : 844 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  await opts.before?.(ctx);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(`${s!.base}${url}`);
  return p;
}

// All active: no ?ws= (the scope, "all" here). ?ws=all would name a
// project called "all", which isn't one.
const agentsUrl = () =>
  `/agents?layout=tabs&open=${sid.planner},${sid.builder}`;

async function agentsPage(width?: number): Promise<Page> {
  const p = await open(agentsUrl(), { width });
  await p.waitForSelector("#agl:not([aria-busy]) button[data-id][data-pc]", {
    timeout: 20_000,
  });
  return p;
}

/** What each project's things on the Agents page say their colour is. */
const colours = (p: Page) =>
  p.evaluate(
    (rows) => {
      const pc = (sel: string) =>
        document.querySelector(sel)?.getAttribute("data-pc") ?? null;
      const out: Record<string, Record<string, string | null>> = {};
      for (const [id, ws] of rows)
        out[ws] = {
          row: pc(`#agl .agr[data-id="${id}"]`),
          group: pc(`#agl .wsg[data-ws="${ws}"]`),
        };
      return out;
    },
    AGENTS.map(([id, , ws]) => [sid[id], ws] as const),
  );

/**
 * The computed value of `prop` on the first match of `sel`, found and read
 * in one step: the list repaints on its own (a refresh), and a row read
 * after it was replaced has no style (issue 1315).
 */
const computed = (p: Page, sel: string, prop: string) =>
  p.evaluate(
    ([sl, pr]) => {
      const e = document.querySelector(sl);
      if (!e) throw new Error(`nothing matches ${sl}`);
      return getComputedStyle(e).getPropertyValue(pr);
    },
    [sel, prop] as const,
  );

describe("project colours (issue 168)", () => {
  // The issue's widths (1280 and 390) and the mock's (1440).
  it.each([1440, 1280, 390])(
    "two projects differ (Automatic); every part of an agent wears its project's colour, the same after a reload (%i)",
    async (width) => {
      if (skip()) return;
      expect(await s!.settings({ shell: { projectColours: null } })).toBe(200);
      const p = await agentsPage(width);
      const first = await colours(p);
      expect(first.north.row).toBeTruthy();
      expect(first.south.row).toBeTruthy();
      expect(first.north.row).not.toBe(first.south.row);
      expect(first.north.group).toBe(first.north.row);
      expect(first.south.group).toBe(first.south.row);
      // The tile, the row edge, the tab and the pane all use it.
      for (const [id] of AGENTS) {
        const row = `#agl .agr[data-id="${sid[id]}"]`;
        const want = await computed(p, row, "border-left-color");
        expect(await computed(p, `${row} .agtile`, "background-color")).toBe(
          want,
        );
        expect(
          await p.getAttribute(
            `#agr [role="tab"][data-id="${sid[id]}"]`,
            "data-pc",
          ),
        ).toBe(await p.getAttribute(row, "data-pc"));
        await p.click(`#agr [role="tab"][data-id="${sid[id]}"]`);
        const pane = `#agr .pane[data-id="${sid[id]}"]`;
        await p.waitForSelector(`${pane}[data-pc]`);
        expect(await computed(p, `${pane} .agto`, "border-left-color")).toBe(
          want,
        );
        expect(await computed(p, `${pane} .bar2`, "border-bottom-color")).toBe(
          want,
        );
        // The agent in front: outlined and bold, its edge its project's.
        const front = `#agl .agr[aria-current="true"]`;
        await p.waitForSelector(`${front}[data-id="${sid[id]}"]`);
        expect(await computed(p, front, "outline-style")).toBe("solid");
        expect(Number(await computed(p, `${front} .nm`, "font-weight"))).toBe(
          600,
        );
        expect(await computed(p, front, "border-left-color")).toBe(want);
      }
      await p.reload();
      await p.waitForSelector("#agl:not([aria-busy]) button[data-id][data-pc]");
      expect(await colours(p)).toEqual(first);
      await p.context().close();
    },
    60_000,
  );

  it("the bell's project groups carry their project's colour", async () => {
    if (skip()) return;
    expect(await s!.settings({ shell: { projectColours: null } })).toBe(200);
    const st = new NotificationStore(s!.stateDir);
    for (const [id, , ws] of AGENTS)
      st.add({
        // A kind that needs the person: drawn in its project's group (an
        // update folds into one Updates list, with no project heading).
        kind: "mention",
        subject: `agent:${id}`,
        scope: `workspace/${ws}`,
        text: `${id} mentioned you`,
      });
    const p = await agentsPage();
    const want = await colours(p);
    await p.click("#den-bell");
    for (const [, , ws] of AGENTS)
      expect(
        await p
          .locator(
            `#den-bell-pop section[data-scope="workspace/${ws}"] [data-pc]`,
          )
          .getAttribute("data-pc"),
      ).toBe(want[ws].row);
    // A dot's colour is the project's: the same computed colour as its row.
    for (const [id, , ws] of AGENTS)
      expect(
        await computed(
          p,
          `#den-bell-pop section[data-scope="workspace/${ws}"] [data-pc]`,
          "background-color",
        ),
      ).toBe(
        await computed(
          p,
          `#agl .agr[data-id="${sid[id]}"]`,
          "border-left-color",
        ),
      );
    await p.context().close();
  }, 60_000);

  it("the top bar's chip carries the project in view's colour", async () => {
    if (skip()) return;
    const p = await open("/agents?ws=north");
    await p.waitForSelector("#ws-pill [data-pc]", { timeout: 20_000 });
    const chip = await p.getAttribute("#ws-pill [data-pc]", "data-pc");
    await p.waitForSelector("#agl:not([aria-busy]) button[data-id][data-pc]");
    expect(chip).toBe(
      await p.getAttribute("#agl [data-ws][data-pc]", "data-pc"),
    );
    await p.context().close();
  }, 60_000);

  const TITLE = { en: "Colour for", es: "Color de", ja: "の色" } as const;
  const PICKS = [
    ["en", 1440, "teal"],
    ["en", 390, "gold"],
    ["es", 1440, "pink"],
    ["es", 390, "slate"],
    ["ja", 1440, "brown"],
    ["ja", 390, "purple"],
  ] as const;
  for (const [lang, width, pick] of PICKS)
    it(`a chosen colour survives a reload (${lang}, ${width})`, async () => {
      if (skip()) return;
      expect(await s!.settings({ language: lang === "en" ? null : lang })).toBe(
        200,
      );
      const p = await open("/local-dev", { width });
      const dot = `#ws-list [data-pc-pick="north"]`;
      await p.waitForSelector(dot, { state: "attached", timeout: 20_000 });
      await p.$eval(dot, (b) => (b as HTMLElement).click());
      await p.waitForSelector("#pcp-dlg[open]");
      expect(await p.textContent("#pcp-h")).toContain(TITLE[lang]);
      await p.click(`#pcp-dlg input[value="${pick}"]`, { force: true });
      await p.click('#pcp-dlg [data-dk="save"]');
      await p.waitForSelector("#pcp-dlg", { state: "detached" });
      await p.waitForFunction(
        (c) =>
          document
            .querySelector('#ws-list [data-name="north"]')
            ?.getAttribute("data-pc") === c,
        pick,
      );
      await p.context().close();
      // A new page reads it from the server: the agents and Settings.
      const a = await agentsPage(width);
      expect((await colours(a)).north.row).toBe(pick);
      await a.context().close();
      const set = await open("/settings?project=north#workspace", { width });
      await set.waitForSelector("[data-pc-now][data-pc]", { timeout: 20_000 });
      expect(await set.getAttribute("[data-pc-now]", "data-pc")).toBe(pick);
      await set.context().close();
    }, 90_000);

  it("Automatic again takes the choice away", async () => {
    if (skip()) return;
    expect(await s!.settings({ language: null })).toBe(200);
    expect(
      await s!.settings({ shell: { projectColours: { north: null } } }),
    ).toBe(200);
    const got = (await s!.settingsGet()) as {
      shell?: { projectColours?: Record<string, string> };
    };
    expect(got.shell?.projectColours).toEqual({});
  });

  it("a colour chosen in one tab repaints another's chip and agents, no reload", async () => {
    if (skip()) return;
    expect(await s!.settings({ language: null })).toBe(200);
    expect(
      await s!.settings({ shell: { projectColours: { north: null } } }),
    ).toBe(200);
    const a = await open("/agents?ws=north");
    await a.waitForSelector("#ws-pill [data-pc]", { timeout: 20_000 });
    await a.waitForSelector("#agl:not([aria-busy]) button[data-id][data-pc]");
    const was = await a.getAttribute("#ws-pill [data-pc]", "data-pc");
    const pick = was === "blue" ? "teal" : "blue";
    // The second tab shares the first one's browser (its storage).
    const b = await a.context().newPage();
    b.on("pageerror", (e) => errors.push(`/local-dev: ${e.message}`));
    await b.goto(`${s!.base}/local-dev`);
    const dot = `#ws-list [data-pc-pick="north"]`;
    await b.waitForSelector(dot, { state: "attached", timeout: 20_000 });
    await b.$eval(dot, (e) => (e as HTMLElement).click());
    await b.waitForSelector("#pcp-dlg[open]");
    await b.click(`#pcp-dlg input[value="${pick}"]`, { force: true });
    await b.click('#pcp-dlg [data-dk="save"]');
    await b.waitForSelector("#pcp-dlg", { state: "detached" });
    // The first tab, never reloaded: its chip, and its north agent's row.
    await a.waitForFunction(
      (c) =>
        document
          .querySelector("#ws-pill [data-pc]")
          ?.getAttribute("data-pc") === c,
      pick,
      { timeout: 10_000 },
    );
    await a.waitForFunction(
      ([id, c]) =>
        document
          .querySelector(`#agl button[data-id="${id}"]`)
          ?.getAttribute("data-pc") === c,
      [sid.planner, pick] as const,
      { timeout: 10_000 },
    );
    await a.context().close();
    expect(
      await s!.settings({ shell: { projectColours: { north: null } } }),
    ).toBe(200);
  }, 90_000);

  it("issue 1315: a tab picked while the page still opens its ?open= panes stays in front", async () => {
    if (skip()) return;
    // The terminal library held: the first pane waits for it, so the
    // second hasn't opened when the person picks the first's tab.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const p = await open(agentsUrl(), {
      before: async (ctx) => {
        await ctx.route(/\/vendor\/xterm\.mjs/, async (route) => {
          await held;
          await route.continue();
        });
      },
    });
    try {
      const tab = `#agr [role="tab"][data-id="${sid.planner}"]`;
      await p.waitForSelector(tab);
      expect(await p.$(`#agr .pane[data-id="${sid.builder}"]`)).toBeNull();
      await p.click(tab);
      release();
      // The second pane opens, behind the picked one (so it isn't visible).
      await p.waitForSelector(`#agr .pane[data-id="${sid.builder}"] .xterm`, {
        state: "attached",
      });
      // The tab in front (the list's mark is drawn only for a running
      // agent's row; these may have stopped by now).
      const selected = () =>
        p.$$eval('#agr [role="tab"][aria-selected="true"]', (ts) =>
          ts.map((t) => t.getAttribute("data-id")),
        );
      expect(await selected()).toEqual([sid.planner]);
    } finally {
      await p.context().close();
    }
  }, 60_000);

  it("issue 1315: once every pane is open, picks and ?front= work as before", async () => {
    if (skip()) return;
    const p = await open(agentsUrl());
    try {
      const tab = (id: string) => `#agr [role="tab"][data-id="${sid[id]}"]`;
      const inFront = (id: string) =>
        p.waitForSelector(`${tab(id)}[aria-selected="true"]`);
      // Start-up done: both panes open, the last one in front.
      await p.waitForSelector(`#agr .pane[data-id="${sid.planner}"] .xterm`, {
        state: "attached",
      });
      await p.waitForSelector(`#agr .pane[data-id="${sid.builder}"] .xterm`, {
        state: "attached",
      });
      await inFront("builder");
      // Picks after start-up move the front each time.
      await p.click(tab("planner"));
      await inFront("planner");
      await p.click(tab("builder"));
      await inFront("builder");
      // A later link with ?front= puts that pane in front.
      await p.goto(`${s!.base}${agentsUrl()}&front=${sid.planner}`);
      await inFront("planner");
    } finally {
      await p.context().close();
    }
  }, 60_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
