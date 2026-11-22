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
import * as http from "http";
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
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
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
const pane = (p: Page, id: string) => p.locator(`.pane[data-id="${sid[id]}"]`);
const box = (p: Page, id: string) => pane(p, id).locator(".agc .agc-in");
const sendBtn = (p: Page, id: string) => pane(p, id).locator(".agc .agc-send");
const frameTick = (p: Page) =>
  p.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))),
  );

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
    expect(await pane(p, "scout").locator(".agc .agc-close").count()).toBe(0);
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
        ...document.querySelectorAll<HTMLElement>(
          ".den-top button, .den-top a[href]",
        ),
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
    await pane(p, "scout").locator(".xterm-helper-textarea").waitFor({
      state: "attached",
    });
    expect(
      await pane(p, "scout")
        .locator(".xterm-helper-textarea")
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
    expect(await p.locator(".den-top").isVisible()).toBe(false);
    expect(await p.locator("#den-dock").isVisible()).toBe(false);
    // The mock's frame 3: the pane's own bar steps aside too.
    expect(await pane(p, "scout").locator(".bar2").isVisible()).toBe(false);
    const b = (await box(p, "scout").boundingBox())!;
    const send = (await sendBtn(p, "scout").boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height).toBeLessThanOrEqual(508);
    expect(send.y + send.height).toBeLessThanOrEqual(508);
    // The terminal still reads above it.
    const term = (await pane(p, "scout").locator(".term").boundingBox())!;
    expect(term.height).toBeGreaterThan(100);
    expect(term.y).toBeGreaterThanOrEqual(0);
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
    const t0 = Date.now();
    while (!typed("scout", from).includes("\r") && Date.now() - t0 < 15_000)
      await new Promise((r) => setTimeout(r, 100));
    expect(typed("scout", from)).toContain(`hello from a phone (${engine})`);
    expect(typed("scout", from).endsWith("\r")).toBe(true);
    await pane(p, "scout").locator('.agc .agc-msg[data-tone="ok"]').waitFor();
    expect(await box(p, "scout").inputValue()).toBe("");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("words typed while a message goes stay, and only they: a second Send never sends the first again", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    // The send takes a moment, as on a phone's network.
    await p.route("**/say", async (r) => {
      await new Promise((res) => setTimeout(res, 1500));
      await r.continue();
    });
    const from = pty.scout.writes.length;
    await box(p, "scout").fill("first");
    await sendBtn(p, "scout").tap();
    await box(p, "scout").press("End");
    await box(p, "scout").pressSequentially(" second");
    await pane(p, "scout").locator('.agc .agc-msg[data-tone="ok"]').waitFor();
    expect((await box(p, "scout").inputValue()).trim()).toBe("second");
    expect(typed("scout", from)).toContain("first");
    expect(typed("scout", from)).not.toContain("second");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("a draft survives a reload, per agent; sent, a reload brings back nothing", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    await box(p, "scout").fill("half a thought for scout");
    await p.reload();
    await box(p, "scout").waitFor({ timeout: 20_000 });
    expect(await box(p, "scout").inputValue()).toBe("half a thought for scout");
    // Another agent's box is its own.
    await openAgent(p, "planner");
    expect(await box(p, "planner").inputValue()).toBe("");
    await box(p, "planner").fill("for planner");
    await openAgent(p, "scout");
    expect(await box(p, "scout").inputValue()).toBe("half a thought for scout");
    // Sent: gone, and a reload doesn't bring it back.
    const from = pty.scout.writes.length;
    await sendBtn(p, "scout").tap();
    const t0 = Date.now();
    while (!typed("scout", from).includes("\r") && Date.now() - t0 < 15_000)
      await new Promise((r) => setTimeout(r, 100));
    await pane(p, "scout").locator('.agc .agc-msg[data-tone="ok"]').waitFor();
    await p.reload();
    await box(p, "scout").waitFor({ timeout: 20_000 });
    expect(await box(p, "scout").inputValue()).toBe("");
    // The person's own clear: gone too.
    await openAgent(p, "planner");
    expect(await box(p, "planner").inputValue()).toBe("for planner");
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
        await openAgent(p, "scout");
        // Frame 2: no dock with an agent open, and never drawn open.
        expect(await p.locator("#den-dock").isVisible()).toBe(false);
        expect(await seen()).toEqual([]);
        await new Promise((r) => setTimeout(r, 500));
        // Frame 1: the list, no agent open: the dock is there, shut.
        await p.goto(`${s.base}/agents`);
        // The Agents page is up (its list drawn), not only the shell.
        await p.waitForSelector("#agl:not([aria-busy]) .agr", {
          timeout: 20_000,
        });
        expect(await p.locator("#agr .pane").count()).toBe(0);
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
        await d.locator("#den-dock.open").waitFor({ timeout: 20_000 });
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
const row = (id: string) => `#agl .agr[data-id="${sid[id]}"]`;
const back = (id: string) =>
  `.pane[data-id="${sid[id]}"] .bar2 [data-act="back"]`;
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
      // Frame 2: no list, no page header, no tab strip; the pane fills
      // the window under the top bar; a 44px Back named for the list.
      expect(await shown(p, "#agl")).toBeNull();
      expect(await shown(p, "#den-content > .ph")).toBeNull();
      expect(await shown(p, "#agr > .agtabs")).toBeNull();
      const pn = (await shown(p, `.pane[data-id="${sid.scout}"]`))!;
      expect(pn).not.toBeNull();
      expect(pn.y + pn.h).toBeLessThanOrEqual(height + 1);
      expect(pn.h).toBeGreaterThanOrEqual(height * 0.75);
      const b = (await shown(p, back("scout")))!;
      expect(b).not.toBeNull();
      expect(Math.round(b.w)).toBeGreaterThanOrEqual(44);
      expect(Math.round(b.h)).toBeGreaterThanOrEqual(44);
      expect(await p.locator(back("scout")).getAttribute("aria-label")).toBe(
        "Back to agents",
      );
      // Stop and ⋯ in the bar are 44px too.
      const more = (await shown(
        p,
        `.pane[data-id="${sid.scout}"] .bar2 [data-act="more"]`,
      ))!;
      expect(Math.round(more.h)).toBeGreaterThanOrEqual(44);
      expect(Math.round(more.w)).toBeGreaterThanOrEqual(44);
      expect(await sideways(p)).toBeLessThanOrEqual(0);
      const before = new URL(p.url());
      // Back: the list, with the runs dock as on frame 1; the agent stays
      // open (the address keeps it).
      await p.locator(back("scout")).tap();
      await p.locator(row("scout")).waitFor({ state: "visible" });
      expect(await shown(p, `.pane[data-id="${sid.scout}"]`)).toBeNull();
      expect(await p.locator("#den-dock").isVisible()).toBe(true);
      const after = new URL(p.url());
      expect(after.pathname).toBe(before.pathname);
      expect(after.searchParams.get("open")).toBe(
        before.searchParams.get("open"),
      );
      expect(await sideways(p)).toBeLessThanOrEqual(0);
      // A row: its agent, the whole screen again.
      await p.locator(row("planner")).tap();
      await pane(p, "planner").locator(".agc .agc-in").waitFor();
      expect(await shown(p, `.pane[data-id="${sid.planner}"]`)).not.toBeNull();
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
    await pane(p, "planner").locator(".agc .agc-in").waitFor();
    expect(await shown(p, `.pane[data-id="${sid.planner}"]`)).not.toBeNull();
    expect(await shown(p, "#agl")).toBeNull();
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("above 480px nothing changes: the list and the agent side by side or stacked, no Back", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine, { width: 600, height: 900 });
    await openAgent(p, "scout");
    expect(await shown(p, "#agl")).not.toBeNull();
    expect(await shown(p, `.pane[data-id="${sid.scout}"]`)).not.toBeNull();
    expect(await shown(p, back("scout"))).toBeNull();
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("⋯ → Terminal keys: a row of 44px keys above the box; Esc, Ctrl-C and the arrows reach the agent; ⋯ → Hide terminal keys", async () => {
    if (!browsers[engine]) return;
    const { p, errors } = await phone(engine);
    await openAgent(p, "scout");
    const keys = pane(p, "scout").locator(".agkeys");
    expect(await keys.count()).toBe(0);
    await pane(p, "scout").locator('.bar2 [data-act="more"]').tap();
    await p.getByRole("menuitem", { name: "Terminal keys" }).tap();
    await keys.waitFor({ state: "visible" });
    expect(await keys.getAttribute("aria-label")).toBe("Terminal keys");
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
      "Up arrow",
      "Down arrow",
      "Left arrow",
      "Right arrow",
    ]);
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
        const t1 = Date.now();
        while (!typed("scout", from).includes(want) && Date.now() - t1 < 1_000)
          await new Promise((r) => setTimeout(r, 100));
      }
      expect(typed("scout", from)).toContain(want);
    };
    await press("Control-C", "\x03");
    await press("Escape", "\x1b");
    await press("Up arrow", "\x1b[A");
    await press("Right arrow", "\x1b[C");
    // ⋯ again: Hide terminal keys.
    await pane(p, "scout").locator('.bar2 [data-act="more"]').tap();
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
      await pane(p, "scout").locator(".term").getAttribute("data-kbd-dismiss"),
    ).not.toBeNull();
    await pane(p, "scout").locator(".term").tap();
    await frameTick(p);
    expect(
      await p.evaluate(() => "kbdUp" in document.documentElement.dataset),
    ).toBe(false);
    expect(
      await box(p, "scout").evaluate((el) => el === document.activeElement),
    ).toBe(false);
    // Its hidden input asks for no on-screen keyboard.
    expect(
      await pane(p, "scout")
        .locator(".xterm-helper-textarea")
        .getAttribute("inputmode"),
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
  while (Date.now() - t0 < 30_000) {
    for (const f of p.frames()) {
      if (f === p.mainFrame()) continue;
      const has = await f
        .evaluate(() => !!document.querySelector(".agc-in"))
        .catch(() => false);
      if (has) return f;
      const btn = f.locator("#emb-signin");
      if (await btn.isVisible().catch(() => false)) {
        const [pop] = await Promise.all([p.waitForEvent("popup"), btn.click()]);
        await pop.locator("#emc-allow").click();
        if (!pop.isClosed())
          await pop.waitForEvent("close", { timeout: 10_000 });
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("the embedded pane's composer never came");
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
      let f = await embFrame(p);
      await f.locator(".agc-in").fill("a draft in the frame");
      await f.evaluate(() => location.reload());
      await new Promise((r) => setTimeout(r, 300));
      f = await embFrame(p);
      expect(await f.locator(".agc-in").inputValue()).toBe(
        "a draft in the frame",
      );
      const from = pty.scout.writes.length;
      await f.locator(".agc-send").click();
      const t0 = Date.now();
      while (!typed("scout", from).includes("\r") && Date.now() - t0 < 15_000)
        await new Promise((r) => setTimeout(r, 100));
      expect(typed("scout", from)).toContain("a draft in the frame");
      await f.locator('.agc-msg[data-tone="ok"]').waitFor();
      await f.evaluate(() => location.reload());
      await new Promise((r) => setTimeout(r, 300));
      f = await embFrame(p);
      expect(await f.locator(".agc-in").inputValue()).toBe("");
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
      await openAgent(p, "scout");
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
