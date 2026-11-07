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
      const Real = window.WebSocket;
      window.WebSocket = class extends Real {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          this.addEventListener("message", (e) => {
            if (typeof e.data !== "string") return;
            const f = JSON.parse(e.data) as { type?: string };
            // An older session host (one that outlived an upgrade) sends no
            // size frames: drop them before the page sees one.
            if (w.__dropSize && f.type === "size") {
              e.stopImmediatePropagation();
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
/** The size frames the page has had, in order. */
const sizeFrames = (p: Page) =>
  p.evaluate(() =>
    (
      window as unknown as {
        __frames: { type: string; cols: number; rows: number }[];
      }
    ).__frames
      .filter((f) => f.type === "size")
      .map((f) => [f.cols, f.rows]),
  );

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
const same = (a: readonly number[], b: readonly number[]) =>
  a[0] === b[0] && a[1] === b[1];

describe("the Agents tab's terminal size", () => {
  it("two viewers at different widths: the one focused or typing wins, the other hears the size; a hidden pane never resizes", async () => {
    if (skip()) return;
    const [sid, pty] = await session("pair");
    const wide = await viewer(sid, 1440);
    await eventually(async () => same(last(pty), await termSize(wide.p)));
    const wideSize = await termSize(wide.p);

    // A narrower viewer opens the same session: it takes the PTY.
    const narrow = await viewer(sid, 900);
    await eventually(async () => same(last(pty), await termSize(narrow.p)));
    const narrowSize = await termSize(narrow.p);
    expect(narrowSize[0]).toBeLessThan(wideSize[0]);
    // The wide one heard it (the server's size frame).
    await eventually(async () =>
      same((await sizeFrames(wide.p)).at(-1) ?? [], narrowSize),
    );

    // Focus the wide pane: its size again, and the narrow one hears it.
    await wide.p.bringToFront();
    await wide.p.click(`.pane[data-id="${sid}"] .term`);
    await eventually(() => same(last(pty), wideSize));
    await eventually(async () =>
      same((await sizeFrames(narrow.p)).at(-1) ?? [], wideSize),
    );

    // Type in the narrow one (no focus first): its size goes before the key.
    const writes = pty.writes.length;
    await narrow.p.evaluate(() =>
      (
        window as unknown as {
          __terms: { input(d: string, user: boolean): void }[];
        }
      ).__terms[0].input("x", true),
    );
    await eventually(() => pty.writes.length > writes);
    expect(last(pty)).toEqual(narrowSize);
    expect(await termSize(narrow.p)).toEqual(narrowSize);

    // Shown again (visibilitychange): the wide one says its size.
    await wide.p.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await eventually(() => same(last(pty), wideSize));

    // A hidden page's pane never resizes the PTY, even typing.
    const resizes = pty.resizes.length;
    await narrow.p.evaluate(() => {
      Object.defineProperty(document, "hidden", { get: () => true });
      Object.defineProperty(document, "visibilityState", {
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      (
        window as unknown as {
          __terms: { input(d: string, user: boolean): void }[];
        }
      ).__terms[0].input("y", true);
    });
    await eventually(() => Buffer.concat(pty.writes).toString().includes("y"));
    await new Promise((r) => setTimeout(r, 200));
    expect(pty.resizes.length).toBe(resizes);
    expect(last(pty)).toEqual(wideSize);
    // Never under 2x2, whatever was measured.
    expect(pty.resizes.every(([c, r]) => c >= 2 && r >= 2)).toBe(true);
    await narrow.ctx.close();
    await wide.ctx.close();
  }, 60_000);

  it("with an older host (no size frames), typing in the wide viewer again takes the PTY back from the narrow one", async () => {
    if (skip()) return;
    const [sid, pty] = await session("old-host");
    const wide = await viewer(sid, 1440, { noSizeFrames: true });
    await eventually(async () => same(last(pty), await termSize(wide.p)));
    const wideSize = await termSize(wide.p);
    const narrow = await viewer(sid, 900, { noSizeFrames: true });
    await eventually(async () => same(last(pty), await termSize(narrow.p)));
    const narrowSize = await termSize(narrow.p);
    expect(narrowSize[0]).toBeLessThan(wideSize[0]);
    const type = (v: { p: Page }, d: string) =>
      v.p.evaluate(
        (ch) =>
          (
            window as unknown as {
              __terms: { input(d: string, user: boolean): void }[];
            }
          ).__terms[0].input(ch, true),
        d,
      );
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
