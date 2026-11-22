/**
 * Issue 302: chat with an agent on an iPhone. The Agents page at 390x844
 * with touch, in Chromium and WebKit (an iPhone's engine), through the
 * real routes:
 *
 *   - an agent opened shows a message box at its foot, with no deep link:
 *     16px text (iOS zooms under 16), Send at least 44px, inside the
 *     window, and nothing scrolls sideways;
 *   - every top-bar button is at least 44px each way;
 *   - the keyboard up (the visual viewport cut by 336px, an iOS keyboard;
 *     a real one can't be emulated): the top bar and the runs dock step
 *     aside, and the message box and Send are inside the visible height;
 *   - the terminal's own hidden input is 16px too;
 *   - Send reaches the agent: the message, then Enter;
 *   - an unsent draft survives a reload, per agent (another agent's box is
 *     its own); sent, a reload brings back nothing. The same in the
 *     embedded pane, framed by a listed origin: type, reload the frame,
 *     the words are back; send, reload, empty.
 *
 * The demo distribution with a session host in this process and scripted
 * PTYs (helpers/agents-page-server.ts). The visual viewport is a stand-in
 * (window.visualViewport), set before the page's scripts run. Invented
 * names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { AddressInfo } from "net";
import type { Browser, Frame, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { signInUrl } from "./helpers/den-auth.js";
import { enCatalog } from "./helpers/en-catalog.js";
import { signIn } from "./helpers/signed-in.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINES = ["chromium", "webkit"] as const;
type Engine = (typeof ENGINES)[number];
const browsers: Partial<Record<Engine, Browser>> = {};
let s: AgentsPageServer;
const sid: Record<string, string> = {};
const pty: Record<string, ScriptedPty> = {};
let hostServer: http.Server;
let LISTED = "";
/** Den's newest version: What's new seen, so it never opens over the page. */
let latest = "";
/** Each write an agent's PTY gets ("write"): what a wait listens for. */
const wrote = new EventEmitter();
/** shell.js's English catalog: the page's words, as a browser in English shows them. */
const en = enCatalog();
/** en's words for `key`, its {vars} filled. */
const words = (key: string, vars: Record<string, string | number> = {}) =>
  (en[key] ?? key).replace(/\{(\w+)\}/g, (m, k: string) =>
    vars[k] == null ? m : String(vars[k]),
  );

/** A host page: frames `target`, says hello to Den, logs what Den says. */
function hostPage(target: string, den: string): string {
  const cfg = JSON.stringify({ target, den }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>host</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="margin:0">
<iframe id="f" style="width:100%;height:400px;border:0"></iframe>
<script>
const C = ${cfg};
window.got = [];
const f = document.getElementById("f");
const hello = () => f.contentWindow && f.contentWindow.postMessage({ type: "den:hello" }, C.den);
addEventListener("message", (e) => {
  window.got.push({ origin: e.origin, data: e.data });
  if (e.data && e.data.type === "den:ready") hello();
});
f.addEventListener("load", hello);
f.src = C.target;
</script></body></html>`;
}

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  for (const id of ["scout", "planner"]) {
    const info = await host.start({
      name: `acme-north:${id}`,
      cwd: s.wsDir("north"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    sid[id] = info.ref.id;
    pty[id] = s.made.at(-1)!;
    const made = pty[id];
    const write = made.write.bind(made);
    made.write = (d: Buffer) => {
      write(d);
      wrote.emit("write");
    };
    s.seed({
      id,
      persona: "builder",
      runtime: "den-claude",
      workspace: "north",
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: `acme-north:${id}`,
    });
    // At its input prompt: a message is typed only there (issue 664).
    pty[id].emit(`${id} ready\r\n> `);
  }
  host.close();
  hostServer = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(hostPage(u.searchParams.get("target") ?? "", s.base));
  });
  await new Promise<void>((r) => hostServer.listen(0, "::", r));
  LISTED = `http://127.0.0.1:${(hostServer.address() as AddressInfo).port}`;
  expect(await s.settings({ embed: { origins: [LISTED] } })).toBe(200);
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [hostServer, s],
  });
});

/** Before any script: a visual viewport the test sets (vv(height)). */
function fakeViewport() {
  const vv = new EventTarget() as EventTarget & { height: number };
  let h = window.innerHeight;
  Object.defineProperty(vv, "height", { get: () => h });
  Object.defineProperty(vv, "width", { get: () => window.innerWidth });
  Object.defineProperty(vv, "offsetTop", { get: () => 0 });
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    get: () => vv,
  });
  (window as unknown as { vv: (n: number) => void }).vv = (n: number) => {
    h = n;
    vv.dispatchEvent(new Event("resize"));
  };
}

async function phone(
  engine: Engine,
  viewport = { width: 390, height: 844 },
): Promise<{ p: Page; errors: string[] }> {
  const ctx = await browsers[engine]!.newContext({
    viewport,
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  // Signed in, as a person on this machine is (0.4.71).
  await signIn(ctx, s.stateDir, s.base);
  await ctx.addInitScript(fakeViewport);
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  const errors: string[] = [];
  // WebKit refuses a fetch a page starts while a reload is already loading
  // the next page, and reports it as a page error ("… <url> due to access
  // control checks."): the page's timed polls can start in that gap. Only
  // that message, for this server's own URL, is not the page's.
  const own = `/${new URL(s.base).host}/`;
  p.on("pageerror", (e) => {
    const m = e.message;
    if (m.endsWith(" due to access control checks.") && m.includes(own)) return;
    errors.push(m);
  });
  return { p, errors };
}

const typed = (id: string, from: number) =>
  Buffer.concat(pty[id].writes.slice(from)).toString("utf8");
/**
 * Until what agent `id` got since write `from` holds `want`, or `ms` pass:
 * each write it gets is a look, never a fixed pause.
 */
function typedUntil(
  id: string,
  from: number,
  want: string,
  ms = 15_000,
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wrote.off("write", look);
      resolve();
    };
    const look = () => {
      if (typed(id, from).includes(want)) done();
    };
    const timer = setTimeout(done, ms);
    wrote.on("write", look);
    look();
  });
}
/** An agent's pane (a section keyed by its session), and its parts. */
const PANE = (id: string) => `section[data-id="${sid[id]}"]`;
const pane = (p: Page, id: string) => p.locator(PANE(id));
const box = (p: Page, id: string) => pane(p, id).locator('[data-agc="in"]');
const sendBtn = (p: Page, id: string) =>
  pane(p, id).locator('[data-agc="send"]');
/** The composer's line, saying the message went. */
const sentOk = (p: Page, id: string) =>
  pane(p, id).locator('[data-agc="msg"][data-tone="ok"]');
/** The pane's own bar (Back, Stop, ⋯) and its terminal. */
const bar = (p: Page, id: string) => pane(p, id).locator("[data-pane-bar]");
const term = (p: Page, id: string) => pane(p, id).locator("[data-term]");
/** The top bar: the header that holds ☰. */
const TOP = "header:has(#den-menu-btn)";
const frameTick = (p: Page) =>
  p.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))),
  );

/** DEN_PHONE_SHOTS=<dir>: each frame's screenshot, Chromium only (for a design check). */
const SHOTS = process.env.DEN_PHONE_SHOTS ?? "";
async function shot(p: Page, engine: Engine, name: string): Promise<void> {
  if (!SHOTS || engine !== "chromium") return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await frameTick(p);
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function openAgent(p: Page, id: string): Promise<void> {
  const res = await p.goto(`${s.base}/p/north/agents/${id}`);
  expect(res?.status()).toBe(200);
  await box(p, id).waitFor({ timeout: 20_000 });
}

describe.each(ENGINES)("issue 302: an agent on a phone, in %s", (engine) => {
  it("a message box at the agent's foot: 16px, Send 44px, inside the window, no sideways scroll", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    const b = (await box(p, "scout").boundingBox())!;
    const send = (await sendBtn(p, "scout").boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(844);
    expect(send.y + send.height).toBeLessThanOrEqual(844);
    expect(send.x + send.width).toBeLessThanOrEqual(390);
    expect(Math.round(send.height)).toBeGreaterThanOrEqual(44);
    expect(Math.round(send.width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(b.height)).toBeGreaterThanOrEqual(44);
    expect(
      await box(p, "scout").evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe("16px");
    // The mock's frame 2: an agent open on a phone has no runs dock.
    expect(await p.locator("#den-dock").isVisible()).toBe(false);
    // A phone's box is always there: no Close.
    expect(await pane(p, "scout").locator('[data-agc="close"]').count()).toBe(
      0,
    );
    const over = await p.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("every top-bar button is at least 44px each way; the terminal's hidden input is 16px", async () => {
    if (!browsers[engine]) return;
    const { p } = await phone(engine);
    await openAgent(p, "scout");
    const small = await p.evaluate(() =>
      [
        ...(document
          .getElementById("den-menu-btn")
          ?.closest("header")
          ?.querySelectorAll<HTMLElement>("button, a[href]") ?? []),
      ]
        .filter((b) => b.offsetParent !== null)
        .map((b) => {
          const r = b.getBoundingClientRect();
          return {
            what: b.id || b.className || b.textContent?.trim(),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        })
        .filter((b) => b.w > 0 && (b.w < 44 || b.h < 44)),
    );
    expect(small).toEqual([]);
    // xterm's own hidden input, the one field in the terminal.
    await term(p, "scout").locator("textarea").waitFor({
      state: "attached",
    });
    expect(
      await term(p, "scout")
        .locator("textarea")
        .evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe("16px");
    await p.context().close();
  }, 90_000);

  it("the keyboard up: the top bar and the dock step aside, the box and Send are above the keyboard", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    await box(p, "scout").tap();
    await p.evaluate(() =>
      (window as unknown as { vv: (n: number) => void }).vv(844 - 336),
    );
    await frameTick(p);
    expect(
      await p.evaluate(() => "kbdUp" in document.documentElement.dataset),
    ).toBe(true);
    expect(await p.locator(TOP).isVisible()).toBe(false);
    expect(await p.locator("#den-dock").isVisible()).toBe(false);
    // The mock's frame 3: the pane's own bar steps aside too.
    expect(await bar(p, "scout").isVisible()).toBe(false);
    const b = (await box(p, "scout").boundingBox())!;
    const send = (await sendBtn(p, "scout").boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height).toBeLessThanOrEqual(508);
    expect(send.y + send.height).toBeLessThanOrEqual(508);
    // The terminal still reads above it.
    const tb = (await term(p, "scout").boundingBox())!;
    expect(tb.height).toBeGreaterThan(100);
    expect(tb.y).toBeGreaterThanOrEqual(0);
    await shot(p, engine, "3-keyboard-up-390");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("Send reaches the agent: the message, then Enter; the box empties", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    const from = pty.scout.writes.length;
    await box(p, "scout").fill(`hello from a phone (${engine})`);
    await sendBtn(p, "scout").tap();
    await typedUntil("scout", from, "\r");
    expect(typed("scout", from)).toContain(`hello from a phone (${engine})`);
    expect(typed("scout", from).endsWith("\r")).toBe(true);
    await sentOk(p, "scout").waitFor();
    expect(await box(p, "scout").inputValue()).toBe("");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("words typed while a message goes stay, and only they: a second Send never sends the first again", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    // The send takes a while, as on a phone's network: it is held on its
    // way until the words below are typed.
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await p.route("**/say", async (r) => {
      await held;
      await r.continue();
    });
    const from = pty.scout.writes.length;
    await box(p, "scout").fill("first");
    const asked = p.waitForRequest((r) =>
      new URL(r.url()).pathname.endsWith("/say"),
    );
    await sendBtn(p, "scout").tap();
    await asked;
    await box(p, "scout").press("End");
    await box(p, "scout").pressSequentially(" second");
    release();
    await sentOk(p, "scout").waitFor();
    expect((await box(p, "scout").inputValue()).trim()).toBe("second");
    expect(typed("scout", from)).toContain("first");
    expect(typed("scout", from)).not.toContain("second");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("a draft survives a reload, per agent; sent, a reload brings back nothing", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    // The words each box is given (typed by the test, not the page's).
    const SCOUT_DRAFT = "half a thought for scout";
    const PLANNER_DRAFT = "for planner";
    await openAgent(p, "scout");
    await box(p, "scout").fill(SCOUT_DRAFT);
    await p.reload();
    await box(p, "scout").waitFor({ timeout: 20_000 });
    expect(await box(p, "scout").inputValue()).toBe(SCOUT_DRAFT);
    // Another agent's box is its own.
    await openAgent(p, "planner");
    expect(await box(p, "planner").inputValue()).toBe("");
    await box(p, "planner").fill(PLANNER_DRAFT);
    await openAgent(p, "scout");
    expect(await box(p, "scout").inputValue()).toBe(SCOUT_DRAFT);
    // Sent: gone, and a reload doesn't bring it back.
    const from = pty.scout.writes.length;
    await sendBtn(p, "scout").tap();
    await typedUntil("scout", from, "\r");
    await sentOk(p, "scout").waitFor();
    await p.reload();
    await box(p, "scout").waitFor({ timeout: 20_000 });
    expect(await box(p, "scout").inputValue()).toBe("");
    // The person's own clear: gone too.
    await openAgent(p, "planner");
    expect(await box(p, "planner").inputValue()).toBe(PLANNER_DRAFT);
    await box(p, "planner").fill("");
    await p.reload();
    await box(p, "planner").waitFor({ timeout: 20_000 });
    expect(await box(p, "planner").inputValue()).toBe("");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 120_000);
});

describe.each(ENGINES)(
  "issue 302: the person's dock choice, in %s",
  (engine) => {
    it("a phone hides the dock with an agent open and shows it shut on the list, never saving: back at 1440 it is still open", async () => {
      if (!browsers[engine]) return;
      expect(await s.settings({ shell: { dock: true } })).toBe(200);
      try {
        const { p, errors } = await phone(engine);
        // From the first parse on: every time the dock is drawn open and
        // shown, before or after the Agents page mounts. It never is on a
        // phone (no flash open on the list, none behind an open agent).
        await p.context().addInitScript(() => {
          const w = window as unknown as { dockOpenSeen: string[] };
          w.dockOpenSeen = [];
          const look = () => {
            const d = document.getElementById("den-dock");
            if (
              d &&
              d.classList.contains("open") &&
              getComputedStyle(d).display !== "none"
            )
              w.dockOpenSeen.push(location.pathname);
          };
          new MutationObserver(look).observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["class", "data-phone-agent"],
          });
          document.addEventListener("DOMContentLoaded", look);
        });
        const seen = () =>
          p.evaluate(
            () =>
              (window as unknown as { dockOpenSeen: string[] }).dockOpenSeen,
          );
        // The shell's saved choice (its GET /api/settings) arriving is when
        // the dock would open late.
        const prefs = p.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/api/settings" &&
            r.request().method() === "GET",
        );
        await openAgent(p, "scout");
        // Frame 2: no dock with an agent open, and never drawn open.
        expect(await p.locator("#den-dock").isVisible()).toBe(false);
        expect(await seen()).toEqual([]);
        // The choice in and applied (a frame on): still never drawn open.
        await (await prefs).finished();
        await frameTick(p);
        expect(await seen()).toEqual([]);
        // Frame 1: the list, no agent open: the dock is there, shut.
        await p.goto(`${s.base}/agents`);
        // The Agents page is up (its list drawn), not only the shell.
        await p.waitForSelector("#agl:not([aria-busy]) button[data-id]", {
          timeout: 20_000,
        });
        expect(await p.locator("#agr section[data-id]").count()).toBe(0);
        const shut = await p
          .waitForFunction(
            () => {
              const d = document.getElementById("den-dock");
              return !!d && !d.classList.contains("open");
            },
            undefined,
            { timeout: 10_000 },
          )
          .then(() => true)
          .catch(() => false);
        expect(shut).toBe(true);
        expect(await p.locator("#den-dock").isVisible()).toBe(true);
        // Never drawn open on the list, not even before the page mounted.
        expect(await seen()).toEqual([]);
        expect(errors).toEqual([]);
        await p.context().close();
        // The saved choice is the person's, as it was.
        const saved = (await s.settingsGet()) as { shell?: { dock?: unknown } };
        expect(saved.shell?.dock).toBe(true);
        // A desktop window: the dock is open, as the person left it.
        const ctx = await browsers[engine]!.newContext({
          viewport: { width: 1440, height: 900 },
          reducedMotion: "reduce",
        });
        await signIn(ctx, s.stateDir, s.base);
        await ctx.addInitScript((v) => {
          try {
            for (const k of ["den-changelog-seen", "acme-changelog-seen"])
              localStorage.setItem(k, v);
          } catch {
            /* none */
          }
        }, latest);
        const d = await ctx.newPage();
        await d.goto(`${s.base}/p/north/agents/scout`);
        // Open: the dock's output is drawn (only an open dock has it).
        await d
          .locator("#den-dock-out")
          .waitFor({ state: "attached", timeout: 20_000 });
        await ctx.close();
      } finally {
        await s.settings({ shell: { dock: null } });
      }
    }, 120_000);
  },
);

/** An element's box, or null when it isn't drawn. */
const shown = (p: Page, sel: string) =>
  p.evaluate((q) => {
    const el = document.querySelector<HTMLElement>(q);
    if (!el || el.offsetParent === null) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      ? { x: r.x, y: r.y, w: r.width, h: r.height }
      : null;
  }, sel);
const row = (id: string) => `#agl button[data-id="${sid[id]}"]`;
/** A button in agent `id`'s pane bar, by its data-act. */
const inBar = (id: string, act: string) =>
  `${PANE(id)} [data-pane-bar] [data-act="${act}"]`;
const back = (id: string) => inBar(id, "back");
const sideways = (p: Page) =>
  p.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );

// Slice 2, the mock's frames 1, 2 and 6: at 480px and under the Agents
// page is two screens, the list and the agent. Back (‹) is the switch:
// it returns to the list and keeps ?open=; a row opens its agent again.
describe.each(ENGINES)("issue 302: two screens on a phone, in %s", (engine) => {
  it.each([
    [390, 844],
    [430, 932],
  ])(
    "at %ipx an agent open is the whole screen, Back shows the list with ?open= kept, a row opens the agent",
    async (width, height) => {
      if (!browsers[engine]) return;
      const { p, errors } = await phone(engine, { width, height });
      await openAgent(p, "scout");
      await shot(p, engine, `2-agent-open-${width}`);
      // The mock's frame 2: the box names the agent, and the bar is one
      // row: Change is in ⋯, not a link on its own line.
      expect(await box(p, "scout").getAttribute("placeholder")).toBe(
        words("agc.label", { name: "scout" }),
      );
      expect(await shown(p, inBar("scout", "link"))).toBeNull();
      expect(await shown(p, inBar("scout", "attach"))).toBeNull();
      const rowTops = await bar(p, "scout")
        .locator('[data-act="back"], [data-act="stop"], [data-act="more"]')
        .evaluateAll((bs) =>
          bs.map((b) => {
            const r = b.getBoundingClientRect();
            return Math.round(r.top + r.height / 2);
          }),
        );
      expect(rowTops).toHaveLength(3);
      expect(Math.max(...rowTops) - Math.min(...rowTops)).toBeLessThanOrEqual(
        2,
      );
      await bar(p, "scout").locator('[data-act="more"]').tap();
      await p
        .getByRole("menuitem", { name: "Change the repo scout works on" })
        .waitFor();
      await p
        .getByRole("menuitem", { name: "Attach a file to scout" })
        .waitFor();
      await p.keyboard.press("Escape");
      // Frame 2: no list, no page header, no tab strip; the pane fills
      // the window under the top bar; a 44px Back named for the list.
      expect(await shown(p, "#agl")).toBeNull();
      // The page header (the one holding the page's h1) and the tab strip.
      expect(await shown(p, "#den-content > div:has(#ag-h)")).toBeNull();
      expect(await shown(p, '#agr > [role="tablist"]')).toBeNull();
      const pn = (await shown(p, PANE("scout")))!;
      expect(pn).not.toBeNull();
      expect(pn.y + pn.h).toBeLessThanOrEqual(height + 1);
      expect(pn.h).toBeGreaterThanOrEqual(height * 0.75);
      const b = (await shown(p, back("scout")))!;
      expect(b).not.toBeNull();
      expect(Math.round(b.w)).toBeGreaterThanOrEqual(44);
      expect(Math.round(b.h)).toBeGreaterThanOrEqual(44);
      expect(await p.locator(back("scout")).getAttribute("aria-label")).toBe(
        en["ag.back"],
      );
      // Stop and ⋯ in the bar are 44px too.
      const more = (await shown(p, inBar("scout", "more")))!;
      expect(Math.round(more.h)).toBeGreaterThanOrEqual(44);
      expect(Math.round(more.w)).toBeGreaterThanOrEqual(44);
      expect(await sideways(p)).toBeLessThanOrEqual(0);
      const before = new URL(p.url());
      // Back: the list, with the runs dock as on frame 1; the agent stays
      // open (the address keeps it).
      await p.locator(back("scout")).tap();
      await p.locator(row("scout")).waitFor({ state: "visible" });
      await shot(p, engine, `1-list-${width}`);
      // The mock's frame 1: plain rows. The count, never the address; no
      // desktop hint, no Reorder, no drag handles.
      const counted = `${words("ag.sub.agents", { n: 2 })} · ${words("ag.sub.waiting", { w: 0 })} · `;
      expect(
        (await p.locator("#ag-count").textContent())?.slice(0, counted.length),
      ).toBe(counted);
      for (const sel of [
        "#ag-url",
        "#agl-hint",
        '#agl [data-act="reorder"]',
        "#agl [data-grip]",
      ])
        expect([sel, await shown(p, sel)]).toEqual([sel, null]);
      expect(await shown(p, PANE("scout"))).toBeNull();
      expect(await p.locator("#den-dock").isVisible()).toBe(true);
      const after = new URL(p.url());
      expect(after.pathname).toBe(before.pathname);
      expect(after.searchParams.get("open")).toBe(
        before.searchParams.get("open"),
      );
      expect(await sideways(p)).toBeLessThanOrEqual(0);
      // A row: its agent, the whole screen again.
      await p.locator(row("planner")).tap();
      await box(p, "planner").waitFor();
      expect(await shown(p, PANE("planner"))).not.toBeNull();
      expect(await shown(p, "#agl")).toBeNull();
      await p.locator(back("planner")).tap();
      await p.locator(row("scout")).tap();
      await p.locator(back("scout")).waitFor({ state: "visible" });
      expect(await shown(p, "#agl")).toBeNull();
      expect(errors).toEqual([]);
      await p.context().close();
    },
    90_000,
  );

  it("after Back, an agent opened by New agent comes to the front, not behind the list", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    await p.locator(back("scout")).tap();
    await p.locator(row("scout")).waitFor({ state: "visible" });
    // The start answers with an agent that is not open yet (planner's).
    await p.route("**/api/workspaces/*/agents", (r) =>
      r.request().method() === "POST"
        ? r.fulfill({
            status: 201,
            json: { agent: { sessionId: sid.planner }, warnings: [] },
          })
        : r.continue(),
    );
    await p.locator("#ag-start").tap();
    await p.waitForSelector("#ag-dlg[open]");
    await p.locator("#ag-go").tap();
    await box(p, "planner").waitFor();
    expect(await shown(p, PANE("planner"))).not.toBeNull();
    expect(await shown(p, "#agl")).toBeNull();
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("above 480px nothing changes: the list and the agent side by side or stacked, no Back", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine, { width: 600, height: 900 });
    await openAgent(p, "scout");
    expect(await shown(p, "#agl")).not.toBeNull();
    expect(await shown(p, PANE("scout"))).not.toBeNull();
    expect(await shown(p, back("scout"))).toBeNull();
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("⋯ → Terminal keys: a row of 44px keys above the box; Esc, Ctrl-C and the arrows reach the agent; ⋯ → Hide terminal keys", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    // The keys row: the group of buttons that carry a key.
    const keys = pane(p, "scout").locator('[role="group"]:has([data-key])');
    expect(await keys.count()).toBe(0);
    await bar(p, "scout").locator('[data-act="more"]').tap();
    await p.getByRole("menuitem", { name: "Terminal keys" }).tap();
    await keys.waitFor();
    await shot(p, engine, "4-terminal-keys-390");
    await keys.waitFor({ state: "visible" });
    expect(await keys.getAttribute("aria-label")).toBe(en["ag.keys.show"]);
    const sizes = await keys
      .locator("button")
      .evaluateAll((bs) =>
        bs.map((b) => [
          b.getAttribute("aria-label"),
          Math.round(b.getBoundingClientRect().width),
          Math.round(b.getBoundingClientRect().height),
        ]),
      );
    expect(sizes.map((s) => s[0])).toEqual([
      "Escape",
      "Control-C",
      "Tab",
      "Enter",
      "Left arrow",
      "Up arrow",
      "Down arrow",
      "Right arrow",
    ]);
    // Two lines of four (the mock): Esc Ctrl-C Tab Enter / ← ↑ ↓ →, every
    // key inside the window, nothing scrolled sideways.
    const at = await keys.locator("button").evaluateAll((bs) =>
      bs.map((b) => {
        const r = b.getBoundingClientRect();
        return { top: Math.round(r.top), right: r.right };
      }),
    );
    expect(new Set(at.slice(0, 4).map((a) => a.top)).size).toBe(1);
    expect(new Set(at.slice(4).map((a) => a.top)).size).toBe(1);
    expect(at[4].top).toBeGreaterThan(at[0].top);
    for (const a of at) expect(a.right).toBeLessThanOrEqual(390);
    expect(
      await keys.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(0);
    for (const [, w, h] of sizes) {
      expect(w).toBeGreaterThanOrEqual(44);
      expect(h).toBeGreaterThanOrEqual(44);
    }
    // Above the message box, inside the window.
    const k = (await keys.boundingBox())!;
    const bx = (await box(p, "scout").boundingBox())!;
    expect(k.y + k.height).toBeLessThanOrEqual(bx.y + 1);
    expect(k.x + k.width).toBeLessThanOrEqual(390);
    expect(await sideways(p)).toBeLessThanOrEqual(0);
    // Each key reaches the agent as the terminal's own bytes.
    const press = async (label: string, want: string) => {
      const from = pty.scout.writes.length;
      // A key tapped before the terminal's socket is open goes nowhere
      // (as a key typed into it would): tap again until one lands.
      const t0 = Date.now();
      while (!typed("scout", from).includes(want) && Date.now() - t0 < 15_000) {
        await keys.getByRole("button", { name: label }).tap();
        await typedUntil("scout", from, want, 1_000);
      }
      expect(typed("scout", from)).toContain(want);
    };
    await press("Control-C", "\x03");
    // A menu's Tab and Enter (the box sends no empty line).
    await press("Tab", "\t");
    await press("Enter", "\r");
    await press("Escape", "\x1b");
    await press("Up arrow", "\x1b[A");
    await press("Right arrow", "\x1b[C");
    // ⋯ again: Hide terminal keys.
    await bar(p, "scout").locator('[data-act="more"]').tap();
    await p.getByRole("menuitem", { name: "Hide terminal keys" }).tap();
    await keys.waitFor({ state: "detached" });
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("the keyboard up, a tap on the terminal puts it down; the terminal's own input never raises it", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    await box(p, "scout").tap();
    await p.evaluate(() =>
      (window as unknown as { vv: (n: number) => void }).vv(844 - 336),
    );
    await frameTick(p);
    expect(
      await p.evaluate(() => "kbdUp" in document.documentElement.dataset),
    ).toBe(true);
    // The terminal reads (the mock: a tap on the reading area puts the
    // keyboard down).
    expect(
      await term(p, "scout").getAttribute("data-kbd-dismiss"),
    ).not.toBeNull();
    await term(p, "scout").tap();
    await frameTick(p);
    expect(
      await p.evaluate(() => "kbdUp" in document.documentElement.dataset),
    ).toBe(false);
    expect(
      await box(p, "scout").evaluate((el) => el === document.activeElement),
    ).toBe(false);
    // Its hidden input asks for no on-screen keyboard.
    expect(
      await term(p, "scout").locator("textarea").getAttribute("inputmode"),
    ).toBe("none");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);
});

/**
 * The frame Den's embedded pane is in, once its composer is there. The
 * frame sends no cookie (0.4.71): each load offers Sign in to Den, and its
 * pop-up (a Den window, signed in) Allows in one click.
 */
async function embFrame(p: Page): Promise<Frame> {
  const t0 = Date.now();
  const left = () => Math.max(1, 30_000 - (Date.now() - t0));
  while (Date.now() - t0 < 30_000) {
    const frames = p.frames().filter((f) => f !== p.mainFrame());
    if (!frames.length)
      await p
        .waitForEvent("frameattached", { timeout: left() })
        .catch(() => undefined);
    for (const f of frames) {
      // The composer there, or Sign in to Den on view: whichever comes
      // first ("" when neither did in time, or the frame went away).
      const what = await f
        .waitForFunction(
          () => {
            if (document.querySelector('[data-agc="in"]')) return "composer";
            const b = document.getElementById("emb-signin");
            if (!b) return "";
            const r = b.getBoundingClientRect();
            const on =
              r.width > 0 &&
              r.height > 0 &&
              getComputedStyle(b).visibility !== "hidden";
            return on ? "signin" : "";
          },
          undefined,
          { timeout: Math.min(left(), 5_000) },
        )
        .then((h) => h.jsonValue())
        .catch(() => "");
      if (what === "composer") return f;
      if (what === "signin") {
        const btn = f.locator("#emb-signin");
        const [pop] = await Promise.all([p.waitForEvent("popup"), btn.click()]);
        await pop.locator("#emc-allow").click();
        if (!pop.isClosed())
          await pop.waitForEvent("close", { timeout: 10_000 });
        // Allowed: Sign in goes (or the frame loads again) before a look.
        await btn
          .waitFor({ state: "hidden", timeout: left() })
          .catch(() => undefined);
      }
    }
  }
  throw new Error("the embedded pane's composer never came");
}

/** Reloads frame `f`: back once the new page has replaced the old one. */
async function reloadFrame(p: Page, f: Frame): Promise<void> {
  const loaded = p.waitForEvent("framenavigated", {
    predicate: (x) => x === f,
  });
  await f.evaluate(() => location.reload());
  await loaded;
}

describe.each(ENGINES)(
  "issue 302: the embedded pane's draft, in %s",
  (engine) => {
    it("type, reload the frame, the words are back; send, reload, empty", async () => {
      if (!browsers[engine]) return;
      const { p } = await phone(engine);
      // Signed in at Den's own origin, as a person who embeds it is.
      await p.goto(signInUrl(s.stateDir, s.base, "/settings"));
      await p.goto(
        `${LISTED}/host?target=${encodeURIComponent(`${s.base}/embed/p/north/agents/scout`)}`,
      );
      // The words the test types in the frame's box.
      const DRAFT = "a draft in the frame";
      const IN = '[data-agc="in"]';
      let f = await embFrame(p);
      await f.locator(IN).fill(DRAFT);
      await reloadFrame(p, f);
      f = await embFrame(p);
      expect(await f.locator(IN).inputValue()).toBe(DRAFT);
      const from = pty.scout.writes.length;
      await f.locator('[data-agc="send"]').click();
      await typedUntil("scout", from, "\r");
      expect(typed("scout", from)).toContain(DRAFT);
      await f.locator('[data-agc="msg"][data-tone="ok"]').waitFor();
      await reloadFrame(p, f);
      f = await embFrame(p);
      expect(await f.locator(IN).inputValue()).toBe("");
      await p.context().close();
    }, 120_000);
  },
);

describe.each(ENGINES)(
  "issue 302: a tablet (touch, 1180x820) is not a phone, in %s",
  (engine) => {
    it("an agent open keeps the runs dock", async () => {
      if (!browsers[engine]) return;
      const { p, errors } = await phone(engine, { width: 1180, height: 820 });
      // A tablet's agent opens as on a desktop: its terminal, no message
      // box until the person asks for one.
      const res = await p.goto(`${s.base}/p/north/agents/scout`);
      expect(res?.status()).toBe(200);
      await term(p, "scout").waitFor({ timeout: 20_000 });
      const v = await p.evaluate(() => ({
        phoneAgent: document.body.hasAttribute("data-phone-agent"),
        dock:
          getComputedStyle(document.getElementById("den-dock")!).display !==
          "none",
      }));
      expect(v).toEqual({ phoneAgent: false, dock: true });
      expect(errors).toEqual([]);
      await p.context().close();
    }, 90_000);
  },
);
