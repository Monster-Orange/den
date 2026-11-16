/**
 * den#165: typing in capitals with an input method on garbled an agent's
 * prompt: text sent twice, the whole line sent again, letters dropped.
 * With a Japanese input source on a Mac, Caps Lock switches it to ABC and
 * each key arrives as an IME key (keyCode 229); xterm 6 sends such a key's
 * text by comparing its hidden input box before and after, a tick later,
 * and fast or held keys overlap (upstream: xterm.js issue 5778).
 *
 * The page gets the keys the way a browser sends them with an IME on: a
 * keydown with keyCode 229, then the text's beforeinput and input. They
 * come faster than a tick, and the key is held (no keyup until the end).
 * What the agent gets is what the scripted PTY was written: every key once,
 * in order. A real composition (kana to kanji) still goes in once.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts). Needs Playwright's
 * chromium; DEN_HELPERS_BROWSER=webkit runs it in Safari's engine.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";
let pty: ScriptedPty;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
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
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:typist",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  sid = info.ref.id;
  pty = s.made.at(-1)!;
  s.seed({
    id: "typist",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:typist",
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
});

/** Everything the page typed into the agent's PTY since `from`. */
const typed = (from: number) =>
  Buffer.concat(pty.writes.slice(from)).toString("utf8");

async function waitTyped(from: number, want: string, ms = 5000) {
  const t0 = Date.now();
  while (typed(from).length < want.length && Date.now() - t0 < ms)
    await new Promise((r) => setTimeout(r, 50));
  // A little longer: a late duplicate would come now.
  await new Promise((r) => setTimeout(r, 300));
  return typed(from);
}

async function open(width: number) {
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
  await p.evaluate(() =>
    (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
  );
  const mark = `ready-${Math.random().toString(36).slice(2, 8)}`;
  await p.locator(`.pane[data-id="${sid}"] .xterm`).waitFor();
  await new Promise((r) => setTimeout(r, 300));
  pty.emit(`${mark}$ `);
  await p.waitForFunction(
    (m) =>
      document.querySelector(".pane .xterm-rows")?.textContent?.includes(m),
    mark,
    { timeout: 15_000 },
  );
  await p.focus(`.pane[data-id="${sid}"] textarea.xterm-helper-textarea`);
  return { p, errors };
}

/**
 * `text` as IME keys, all in one go (faster than a tick) and held (one
 * keyup at the end): per key a keydown (keyCode 229), then, unless the
 * page took it, the box gets the letter and its input event.
 */
function imeKeys(p: Page, text: string) {
  return p.evaluate(
    ([sel, text]) => {
      const ta = document.querySelector(sel) as HTMLTextAreaElement;
      const key = (type: string, k: string) => {
        const e = new KeyboardEvent(type, {
          key: k,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        Object.defineProperty(e, "keyCode", { get: () => 229 });
        Object.defineProperty(e, "which", { get: () => 229 });
        ta.dispatchEvent(e);
      };
      for (const ch of text) {
        key("keydown", "Process");
        const before = new InputEvent("beforeinput", {
          data: ch,
          inputType: "insertText",
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        if (!ta.dispatchEvent(before)) continue;
        ta.value += ch;
        ta.dispatchEvent(
          new InputEvent("input", {
            data: ch,
            inputType: "insertText",
            bubbles: true,
            composed: true,
          }),
        );
      }
      key("keyup", "Process");
    },
    [`.pane[data-id="${sid}"] textarea.xterm-helper-textarea`, text] as const,
  );
}

/**
 * The report itself: Tab held while typing. Before each key of `text`, a
 * Tab keydown (repeat after the first, as a held key auto-repeats; no
 * keyup until the end), then the key as an IME key (keyCode 229).
 */
function tabHeldIme(p: Page, text: string) {
  return p.evaluate(
    ([sel, text]) => {
      const ta = document.querySelector(sel) as HTMLTextAreaElement;
      const key = (type: string, k: string, code: number, repeat = false) => {
        const e = new KeyboardEvent(type, {
          key: k,
          code: k === "Tab" ? "Tab" : "",
          repeat,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        Object.defineProperty(e, "keyCode", { get: () => code });
        Object.defineProperty(e, "which", { get: () => code });
        ta.dispatchEvent(e);
      };
      let first = true;
      for (const ch of text) {
        key("keydown", "Tab", 9, !first);
        first = false;
        key("keydown", "Process", 229);
        const before = new InputEvent("beforeinput", {
          data: ch,
          inputType: "insertText",
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        if (!ta.dispatchEvent(before)) continue;
        ta.value += ch;
        ta.dispatchEvent(
          new InputEvent("input", {
            data: ch,
            inputType: "insertText",
            bubbles: true,
            composed: true,
          }),
        );
      }
      key("keyup", "Process", 229);
      key("keyup", "Tab", 9);
    },
    [`.pane[data-id="${sid}"] textarea.xterm-helper-textarea`, text] as const,
  );
}

/** A kana-to-kanji composition that commits `out` (it shows `reading`). */
function compose(p: Page, reading: string, out: string) {
  return p.evaluate(
    ([sel, reading, out]) => {
      const ta = document.querySelector(sel) as HTMLTextAreaElement;
      const start = ta.value.length;
      ta.dispatchEvent(
        new CompositionEvent("compositionstart", { data: "", bubbles: true }),
      );
      for (let i = 1; i <= reading.length; i++) {
        const k = new KeyboardEvent("keydown", {
          key: "Process",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        });
        Object.defineProperty(k, "keyCode", { get: () => 229 });
        ta.dispatchEvent(k);
        ta.value = ta.value.slice(0, start) + reading.slice(0, i);
        ta.dispatchEvent(
          new CompositionEvent("compositionupdate", {
            data: reading.slice(0, i),
            bubbles: true,
          }),
        );
      }
      ta.value = ta.value.slice(0, start) + out;
      ta.dispatchEvent(
        new CompositionEvent("compositionend", { data: out, bubbles: true }),
      );
    },
    [
      `.pane[data-id="${sid}"] textarea.xterm-helper-textarea`,
      reading,
      out,
    ] as const,
  );
}

describe.each([1440, 375])("den#165 at %i px", (width) => {
  it("capitals, then IME keys typed fast and held, reach the agent once each, in order", async () => {
    if (!browser) return;
    const { p, errors } = await open(width);
    const from = pty.writes.length;
    // Capitals through the keyboard first (xterm lets A-Z into its box).
    await p.keyboard.type("I DID ");
    await waitTyped(from, "I DID ");
    const want = "I DID NOT SAY REMOVE IT! I SAID FIX.";
    await imeKeys(p, want.slice("I DID ".length));
    const got = await waitTyped(from, want);
    expect(JSON.stringify(got)).toBe(JSON.stringify(want));
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("Tab held while typing (the report): each key and each Tab once, in order", async () => {
    if (!browser) return;
    const { p, errors } = await open(width);
    // Real keys: Tab goes down and auto-repeats between the letters.
    let from = pty.writes.length;
    await p.keyboard.down("Tab");
    for (const ch of "GIVE ME") {
      await p.keyboard.type(ch);
      await p.keyboard.down("Tab");
    }
    await p.keyboard.up("Tab");
    let want = "\tG\tI\tV\tE\t \tM\tE\t";
    let got = await waitTyped(from, want);
    expect(JSON.stringify(got)).toBe(JSON.stringify(want));
    // The same with an input method on (each letter an IME key).
    from = pty.writes.length;
    await tabHeldIme(p, "I SAID FIX.");
    want = [..."I SAID FIX."].map((c) => `\t${c}`).join("");
    got = await waitTyped(from, want);
    expect(JSON.stringify(got)).toBe(JSON.stringify(want));
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("a kana composition still goes in once, and IME keys after it too", async () => {
    if (!browser) return;
    const { p, errors } = await open(width);
    const from = pty.writes.length;
    await compose(p, "にほん", "日本");
    const first = await waitTyped(from, "日本");
    expect(JSON.stringify(first)).toBe(JSON.stringify("日本"));
    await imeKeys(p, "OK");
    const got = await waitTyped(from, "日本OK");
    expect(JSON.stringify(got)).toBe(JSON.stringify("日本OK"));
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);
});
