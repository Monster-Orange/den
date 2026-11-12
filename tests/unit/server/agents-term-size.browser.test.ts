/**
 * The Agents tab's terminal size, in a real browser: a session has one PTY
 * size, shared by every viewer (last writer wins), so
 *
 *   - two viewers at different widths: the one in use wins. Focusing the
 *     wide one's pane, or typing in the narrow one, makes the PTY that
 *     pane's size, and the other viewer hears it (the server's `size`
 *     frame); a hidden pane never resizes it;
 *   - a font that loads after the first fit (a theme's --mono as a web
 *     font) has the cells measured again, and the PTY follows; so does a
 *     theme applied without a reload (den:appearance).
 *
 * Nothing here knows a font's metrics: the "font" is a scale on the canvas
 * text measure xterm uses, and every check compares the PTY's cols to
 * xterm's own term.cols (each Terminal the page makes is kept on window).
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts): nothing really runs.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let browser: Browser | null = null;
let latest = "";
const errors: string[] = [];

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
}, 60_000);

afterAll(async () => {
  await browser?.close();
  host?.close();
  await s?.stop();
});

const skip = () => !browser;

/** A plain session at the CLI's default size; its scripted PTY. */
async function session(name: string): Promise<[string, ScriptedPty]> {
  const info = await host!.start({
    name: `acme-north:${name}`,
    cwd: s!.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  return [info.ref.id, s!.made.find((p) => p.pid === info.pid)!];
}

/**
 * A page with the session's pane open. Each Terminal is kept on
 * window.__terms, each text frame the server sends on window.__frames,
 * and the canvas text measure is scaled by window.__fontScale.
 */
async function viewer(
  sid: string,
  width: number,
  opts: { noSizeFrames?: boolean } = {},
): Promise<{ ctx: BrowserContext; p: Page }> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.route("**/vendor/xterm.mjs", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body:
        'import * as X from "/vendor/xterm.mjs?real";' +
        "export class Terminal extends X.Terminal {" +
        "constructor(o) { super(o); (window.__terms ??= []).push(this); } }",
    }),
  );
  await ctx.route("**/vendor/xterm.mjs?real", async (r) =>
    r.fulfill({
      response: await r.fetch({ url: r.request().url().split("?")[0] }),
    }),
  );
  await ctx.addInitScript(
    ([v, drop]) => {
      (window as unknown as Record<string, unknown>).__dropSize = drop;
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, v);
      } catch {
        /* none */
      }
      const w = window as unknown as Record<string, unknown>;
      w.__frames = [];
      w.__releaseSize = () => {
        w.__holdSize = false;
        for (const [sock, data] of (w.__held ?? []) as [WebSocket, string][])
          sock.dispatchEvent(new MessageEvent("message", { data }));
        w.__held = [];
      };
      const Real = window.WebSocket;
      window.WebSocket = class extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          ((w.__socks ??= []) as WebSocket[]).push(this);
          const send = this.send.bind(this);
          this.send = (
            data: string | ArrayBufferLike | Blob | ArrayBufferView,
          ) => {
            if (typeof data === "string" && data.includes('"resize"'))
              ((w.__sent ??= []) as string[]).push(data);
            send(data);
          };
          this.addEventListener("message", (e) => {
            if (typeof e.data !== "string") return;
            const f = JSON.parse(e.data) as { type?: string };
            // An older session host (one that outlived an upgrade) sends no
            // size frames: drop them before the page sees one.
            if (w.__dropSize && f.type === "size") {
              e.stopImmediatePropagation();
              return;
            }
            // A slow link: the host's size frames held back until released
            // (window.__releaseSize); an injected frame passes.
            const inj = (f as { injected?: boolean }).injected;
            if (w.__holdSize && f.type === "size" && !inj) {
              e.stopImmediatePropagation();
              ((w.__held ??= []) as [WebSocket, string][]).push([this, e.data]);
              return;
            }
            (w.__frames as unknown[]).push(f);
          });
        }
      };
      for (const C of [
        (globalThis as Record<string, unknown>)
          .OffscreenCanvasRenderingContext2D,
        globalThis.CanvasRenderingContext2D,
      ] as Array<{ prototype: CanvasRenderingContext2D } | undefined>) {
        if (!C) continue;
        const real = C.prototype.measureText;
        C.prototype.measureText = function (text: string) {
          const m = real.call(this, text);
          const k = (w.__fontScale as number | undefined) ?? 1;
          if (k === 1) return m;
          return new Proxy(m, {
            get: (o, key) =>
              key === "width"
                ? o.width * k
                : (o as unknown as Record<string | symbol, unknown>)[key],
          });
        };
      }
    },
    [latest, !!opts.noSizeFrames] as const,
  );
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${width}: ${e.message}`));
  await p.goto(`${s!.base}/agents?open=${sid}`);
  await p.waitForFunction(
    () => (window as unknown as { __terms?: unknown[] }).__terms?.length === 1,
    null,
    { timeout: 20_000 },
  );
  return { ctx, p };
}

/** xterm's own size for the page's pane. */
const termSize = (p: Page) =>
  p.evaluate(() => {
    const t = (
      window as unknown as { __terms: { cols: number; rows: number }[] }
    ).__terms[0];
    return [t.cols, t.rows] as [number, number];
  });
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
const last = (pty: ScriptedPty) => pty.resizes.at(-1) ?? [0, 0];
/**
 * Type `d` into the page's terminal as a person does: real key presses in
 * its textarea. (Not term.input: that is the path xterm's own replies to
 * the agent's queries take too.)
 */
const type = async (v: { p: Page }, d: string) => {
  await v.p.focus(".pane .xterm-helper-textarea");
  await v.p.keyboard.type(d);
};
const same = (a: readonly number[], b: readonly number[]) =>
  a[0] === b[0] && a[1] === b[1];

describe("the Agents tab's terminal size", () => {
  it("two viewers at different widths: the one typing sizes the PTY, the other draws at the PTY's size (D54); focus, a look or a hidden pane never resize it", async () => {
    if (skip()) return;
    const [sid, pty] = await session("pair");
    // Alone: the first viewer sizes the PTY.
    const wide = await viewer(sid, 1440);
    await eventually(async () => same(last(pty), await termSize(wide.p)));
    const wideSize = await termSize(wide.p);

    // A narrower viewer opens the same session: it follows the PTY's size
    // (the wide one's), and says so; the PTY stays as it was.
    const narrow = await viewer(sid, 900);
    await eventually(async () => same(await termSize(narrow.p), wideSize));
    expect(last(pty)).toEqual(wideSize);
    await narrow.p
      .locator(`.pane[data-id="${sid}"] .agfollow`)
      .waitFor({ timeout: 10_000 });

    // Focusing it, or showing it again, is a look: still the wide size.
    const resizes = pty.resizes.length;
    await narrow.p.click(`.pane[data-id="${sid}"] .term .xterm-screen`, {
      position: { x: 20, y: 20 },
    });
    await narrow.p.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(pty.resizes.length).toBe(resizes);

    // Typing in it: its own size goes before the key, and the wide one
    // now draws at that size (term.cols equals the PTY's).
    const writes = pty.writes.length;
    await type(narrow, "x");
    await eventually(() => pty.writes.length > writes);
    const narrowSize = last(pty);
    expect(narrowSize[0]).toBeLessThan(wideSize[0]);
    expect(await termSize(narrow.p)).toEqual(narrowSize);
    await eventually(async () => same(await termSize(wide.p), narrowSize));
    await wide.p
      .locator(`.pane[data-id="${sid}"] .agfollow`)
      .waitFor({ timeout: 10_000 });

    // Take over: the wide one's size again; the narrow one follows. A
    // size frame from before the take-over that lands after it (a slow
    // link) is an older one, not another view taking the size back.
    await wide.p.evaluate(() => {
      (window as unknown as { __holdSize: boolean }).__holdSize = true;
    });
    await wide.p.click(`.pane[data-id="${sid}"] [data-act="take-size"]`);
    await eventually(() => same(last(pty), wideSize));
    // The older frame lands while the host's answer to the take-over is
    // still on its way; then the answer.
    await wide.p.evaluate(
      ([c, r]) =>
        (window as unknown as { __socks: WebSocket[] }).__socks
          .at(-1)!
          .dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "size",
                cols: c,
                rows: r,
                injected: true,
              }),
            }),
          ),
      narrowSize,
    );
    await wide.p.evaluate(() =>
      (window as unknown as { __releaseSize: () => void }).__releaseSize(),
    );
    await eventually(() => same(last(pty), wideSize));
    await eventually(async () => same(await termSize(narrow.p), wideSize));
    const chips = await wide.p.locator(".agfollow").count();
    if (chips)
      throw new Error(
        `the wide one follows after Take over: ${JSON.stringify(
          await wide.p.evaluate(
            () => (window as unknown as { __frames: unknown[] }).__frames,
          ),
        )} pty resizes ${JSON.stringify(pty.resizes)}`,
      );
    expect(await termSize(wide.p)).toEqual(wideSize);

    // A hidden page's pane never resizes the PTY, even typing.
    const before = pty.resizes.length;
    await narrow.p.evaluate(() => {
      Object.defineProperty(document, "hidden", { get: () => true });
      Object.defineProperty(document, "visibilityState", {
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await type(narrow, "y");
    await eventually(() => Buffer.concat(pty.writes).toString().includes("y"));
    await new Promise((r) => setTimeout(r, 200));
    expect(pty.resizes.length).toBe(before);
    expect(last(pty)).toEqual(wideSize);
    // Never under 2x2, whatever was measured.
    expect(pty.resizes.every(([c, r]) => c >= 2 && r >= 2)).toBe(true);
    await narrow.ctx.close();
    await wide.ctx.close();
  }, 60_000);

  it("D54: a window opened from the agent's link follows, though the agent asks the terminal questions (a real Claude Code does): xterm's answers reach the agent, and never take the size", async () => {
    if (skip()) return;
    const [sid, pty] = await session("asks");
    const wide = await viewer(sid, 1440);
    await eventually(async () => same(last(pty), await termSize(wide.p)));
    const wideSize = last(pty);
    // What a TUI asks on start: the terminal's kind (DA1), the cursor's
    // place (DSR), focus reports on. A view that opens replays them, and
    // its xterm answers each.
    pty.emit("\x1b[c\x1b[6n\x1b[?1004h> ready\r\n");
    await new Promise((r) => setTimeout(r, 300));
    const resizes = pty.resizes.length;
    const writes = pty.writes.length;
    const narrow = await viewer(sid, 900);
    await narrow.p
      .locator(`.pane[data-id="${sid}"] .agfollow`)
      .waitFor({ timeout: 10_000 });
    // Its answers reached the agent…
    await eventually(() =>
      Buffer.concat(pty.writes.slice(writes)).toString().includes("\x1b[?"),
    );
    await new Promise((r) => setTimeout(r, 500));
    // …and the size stayed the wide one's: no redraw there.
    const sent = await narrow.p.evaluate(
      () => (window as unknown as { __sent?: string[] }).__sent ?? [],
    );
    expect({ resizes: pty.resizes.slice(resizes), sent }).toEqual({
      resizes: [],
      sent: [],
    });
    expect(await termSize(narrow.p)).toEqual(wideSize);
    expect(await wide.p.locator(".agfollow").count()).toBe(0);
    // The person types in it: now it leads.
    await type(narrow, "x");
    await eventually(() => !same(last(pty), wideSize));
    expect(last(pty)).toEqual(await termSize(narrow.p));
    await narrow.ctx.close();
    await wide.ctx.close();
  }, 60_000);

  it("D54: a prompt the agent redraws at the PTY's width shows once in every view, not once per redraw", async () => {
    if (skip()) return;
    const [sid, pty] = await session("redraw");
    const wide = await viewer(sid, 1440);
    await eventually(async () => same(last(pty), await termSize(wide.p)));
    const narrow = await viewer(sid, 700);
    await new Promise((r) => setTimeout(r, 500));
    // The person types in the wide one: the PTY is its width.
    const writes = pty.writes.length;
    await type(wide, "x");
    await eventually(() => pty.writes.length > writes);
    const [W] = last(pty);
    expect(W).toBe((await termSize(wide.p))[0]);
    await new Promise((r) => setTimeout(r, 300));
    // Claude Code's input box: the prompt hard-wrapped at the PTY's
    // width; each redraw moves up as many lines as it drew, clears them,
    // and draws again (Ink's log-update).
    const prompt = `> MARK-${"word ".repeat(70)}end`;
    const lines: string[] = [];
    for (let i = 0; i < prompt.length; i += W)
      lines.push(prompt.slice(i, i + W));
    const draw = lines.join("\r\n");
    const erase =
      Array.from({ length: lines.length }, (_, i) =>
        i < lines.length - 1 ? "\x1b[2K\x1b[1A" : "\x1b[2K",
      ).join("") + "\x1b[G";
    pty.emit(`\x1b[2J\x1b[H${draw}`);
    for (let i = 0; i < 3; i++) pty.emit(erase + draw);
    const marks = (v: { p: Page }) =>
      v.p.evaluate(() => {
        const t = (
          window as unknown as {
            __terms: {
              buffer: {
                active: {
                  length: number;
                  getLine(
                    y: number,
                  ): { translateToString(trim: boolean): string } | undefined;
                };
              };
            }[];
          }
        ).__terms[0];
        const b = t.buffer.active;
        let text = "";
        for (let y = 0; y < b.length; y++)
          text += b.getLine(y)?.translateToString(true) ?? "";
        return text.split("MARK-").length - 1;
      });
    await new Promise((r) => setTimeout(r, 500));
    expect(await marks(wide)).toBe(1);
    expect(await marks(narrow)).toBe(1);
    // The narrow view draws at the PTY's width (D54).
    expect((await termSize(narrow.p))[0]).toBe(W);
    // DEN_AGENTS_SHOTS=<dir>: both views, the narrow one with its chip.
    const shots = process.env.DEN_AGENTS_SHOTS;
    if (shots) {
      await wide.p.screenshot({ path: `${shots}/d54-wide.png` });
      await narrow.p.screenshot({ path: `${shots}/d54-narrow.png` });
    }
    // The view that sized it goes away: the one left sizes the PTY to its
    // own pane.
    expect(await narrow.p.locator(".agfollow").count()).toBe(1);
    await wide.ctx.close();
    await eventually(async () => {
      const [c] = last(pty);
      return c < W && c === (await termSize(narrow.p))[0];
    });
    expect(await narrow.p.locator(".agfollow").count()).toBe(0);
    await narrow.ctx.close();
  }, 60_000);

  it("with an older host (no size frames), typing in the wide viewer again takes the PTY back from the narrow one", async () => {
    if (skip()) return;
    const [sid, pty] = await session("old-host");
    const wide = await viewer(sid, 1440, { noSizeFrames: true });
    await eventually(async () => same(last(pty), await termSize(wide.p)));
    const wideSize = await termSize(wide.p);
    // A second view never takes the PTY by opening (D54); with no size
    // frames it can't follow it either, so it keeps its own fit until
    // typed in.
    const narrow = await viewer(sid, 900, { noSizeFrames: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(last(pty)).toEqual(wideSize);
    const narrowSize = await termSize(narrow.p);
    expect(narrowSize[0]).toBeLessThan(wideSize[0]);
    for (let round = 0; round < 3; round++) {
      // The narrow one types: its size.
      let writes = pty.writes.length;
      await type(narrow, "n");
      await eventually(() => pty.writes.length > writes);
      expect(last(pty)).toEqual(narrowSize);
      // The wide one types again, no focus first: its size again.
      writes = pty.writes.length;
      await type(wide, "w");
      await eventually(() => pty.writes.length > writes);
      expect(last(pty)).toEqual(wideSize);
    }
    await narrow.ctx.close();
    await wide.ctx.close();
  }, 60_000);

  it("a font that loads after the first fit measures the cells again, and the PTY follows; so does a theme applied without a reload", async () => {
    if (skip()) return;
    const [sid, pty] = await session("font");
    const v = await viewer(sid, 1440);
    await eventually(async () => same(last(pty), await termSize(v.p)));
    const [cols0] = await termSize(v.p);

    // The web font arrives: its glyphs are wider than the fallback's.
    await v.p.evaluate(() => {
      (window as unknown as { __fontScale: number }).__fontScale = 1.5;
      document.fonts.dispatchEvent(new Event("loadingdone"));
    });
    await eventually(async () => (await termSize(v.p))[0] < cols0);
    await eventually(async () => same(last(pty), await termSize(v.p)));

    // Another theme (den:appearance): measured again.
    await v.p.evaluate(() => {
      (window as unknown as { __fontScale: number }).__fontScale = 1;
      window.dispatchEvent(
        new CustomEvent("den:appearance", { detail: { what: "theme" } }),
      );
    });
    await eventually(async () => (await termSize(v.p))[0] === cols0);
    await eventually(async () => same(last(pty), await termSize(v.p)));
    await v.ctx.close();
  }, 60_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
