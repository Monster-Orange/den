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
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let browser: Browser | null = null;
let latest = "";
const errors: string[] = [];
const leaving = new Set<Page>();
const refusedOwnFetch = (msg: string) =>
  msg.endsWith(" due to access control checks.") &&
  msg.includes(`/${new URL(s!.base).host}/`);

beforeAll(async () => {
  try {
    const { webkit } = await import("playwright");
    browser = await launchBrowser(webkit);
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
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [host, s] });
});

const skip = () => !browser;

async function session(name: string): Promise<[string, ScriptedPty]> {
  const info = await host!.start({
    name: `acme-north:${name}`,
    cwd: s!.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  return [info.ref.id, s!.made.at(-1)!];
}

const IPAD = { width: 820, height: 1180 };
const LAPTOP = { width: 1440, height: 900 };

interface View {
  ctx: BrowserContext;
  p: Page;
}

async function browserWindow(
  size: { width: number; height: number },
  touch = false,
): Promise<View> {
  const ctx = await browser!.newContext({
    viewport: size,
    hasTouch: touch,
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  await ctx.route("**/vendor/xterm.mjs?v=*", (r) =>
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
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
    const w = window as unknown as Record<string, unknown>;
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        ((w.__socks ??= []) as WebSocket[]).push(this);
      }
    };
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => {
    if (leaving.has(p) && refusedOwnFetch(e.message)) return;
    errors.push(`${size.width}: ${e.message}`);
  });
  return { ctx, p };
}

async function terms(v: View): Promise<void> {
  await v.p.waitForFunction(
    () => (window as unknown as { __terms?: unknown[] }).__terms?.length === 1,
    null,
    { timeout: 20_000 },
  );
}

async function away(v: View, go: () => Promise<unknown>): Promise<void> {
  leaving.add(v.p);
  try {
    await go();
    await terms(v);
    await settle(500);
  } finally {
    leaving.delete(v.p);
  }
}

async function blip(v: View, meanwhile?: () => Promise<void>): Promise<void> {
  leaving.add(v.p);
  try {
    await reconnect(v, meanwhile);
  } finally {
    leaving.delete(v.p);
  }
}

async function reconnect(
  v: View,
  meanwhile?: () => Promise<void>,
): Promise<void> {
  const n = await v.p.evaluate(() => {
    const socks = (window as unknown as { __socks: WebSocket[] }).__socks;
    for (const sk of socks) sk.close();
    return socks.length;
  });
  await meanwhile?.();
  await v.p.waitForFunction(
    (k) => {
      const socks = (window as unknown as { __socks: WebSocket[] }).__socks;
      return socks.length > k && socks.at(-1)!.readyState === WebSocket.OPEN;
    },
    n,
    { timeout: 20_000 },
  );
}

async function openByUrl(
  sid: string,
  size: { width: number; height: number },
  touch = false,
): Promise<View> {
  const v = await browserWindow(size, touch);
  await v.p.goto(`${s!.base}/agents?open=${sid}`);
  await terms(v);
  return v;
}

const termSize = (v: View) =>
  v.p.evaluate(() => {
    const t = (
      window as unknown as { __terms: { cols: number; rows: number }[] }
    ).__terms.at(-1)!;
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
const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));
const last = (pty: ScriptedPty) => pty.resizes.at(-1) ?? [0, 0];
const following = (v: View, sid: string) =>
  v.p.locator(`.pane[data-id="${sid}"] .agfollow`).count();
const takeOver = (v: View, sid: string) =>
  v.p.locator(`.pane[data-id="${sid}"] [data-act="take-size"]`).click();
const type = async (v: View, d: string) => {
  await v.p.focus(".pane .xterm-helper-textarea");
  await v.p.keyboard.type(d);
};

async function appSwitch(v: View): Promise<void> {
  const sockets = await v.p.evaluate(() => {
    const d = document as unknown as Record<string, unknown>;
    Object.defineProperty(d, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(d, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const socks = (window as unknown as { __socks: WebSocket[] }).__socks;
    for (const sk of socks) sk.close();
    return socks.length;
  });
  await v.p.setViewportSize({ width: IPAD.width - 40, height: IPAD.height });
  await v.p.evaluate(() => {
    const d = document as unknown as Record<string, unknown>;
    Object.defineProperty(d, "hidden", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(d, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
  });
  await v.p.waitForFunction(
    (n) => {
      const socks = (window as unknown as { __socks: WebSocket[] }).__socks;
      return socks.length > n && socks.at(-1)!.readyState === WebSocket.OPEN;
    },
    sockets,
    { timeout: 20_000 },
  );
}

describe("issue 1724: an idle browser never takes the size back after Take over", () => {
  it("WebKit at an iPad's size: after Take over on the laptop, the iPad's app switch, reattach, reload and its terminal's own answers keep the laptop's size; typing or Take over on the iPad moves it", async () => {
    if (skip()) return;
    const [sid, pty] = await session("ipad");
    const ipad = await openByUrl(sid, IPAD, true);
    await eventually(async () => {
      const [c, r] = await termSize(ipad);
      const [lc, lr] = last(pty);
      return c === lc && r === lr;
    });
    const laptop = await openByUrl(sid, LAPTOP);
    await eventually(async () => (await following(laptop, sid)) === 1);
    await takeOver(laptop, sid);
    const laptopSize = await termSize(laptop);
    await eventually(() => {
      const [c, r] = last(pty);
      return c === laptopSize[0] && r === laptopSize[1];
    });
    await eventually(async () => (await following(ipad, sid)) === 1);
    const n = pty.resizes.length;

    await blip(laptop, async () => {
      await ipad.p.setViewportSize({
        width: IPAD.width - 20,
        height: IPAD.height,
      });
      await settle(700);
    });
    await settle();
    expect(last(pty)).toEqual(laptopSize);
    expect(await following(laptop, sid)).toBe(0);
    await eventually(async () => (await following(ipad, sid)) === 1);

    await away(laptop, () => laptop.p.reload());
    await settle();
    expect(last(pty)).toEqual(laptopSize);
    expect(await following(laptop, sid)).toBe(0);
    await eventually(async () => (await following(ipad, sid)) === 1);

    await appSwitch(ipad);
    await settle();
    expect(pty.resizes.slice(n).filter((z) => z[0] !== laptopSize[0])).toEqual(
      [],
    );
    expect(last(pty)).toEqual(laptopSize);
    expect(await following(ipad, sid)).toBe(1);

    await away(ipad, () => ipad.p.reload());
    await settle();
    expect(last(pty)).toEqual(laptopSize);
    await eventually(async () => (await following(ipad, sid)) === 1);

    const asked = pty.writes.length;
    pty.emit("\x1b[c\x1b[6n\x1b[?1004h> ready\r\n");
    await eventually(() =>
      Buffer.concat(pty.writes.slice(asked)).toString().includes("\x1b[?"),
    );
    await settle(700);
    expect(last(pty)).toEqual(laptopSize);
    expect(await following(laptop, sid)).toBe(0);

    await type(ipad, "x");
    const ipadSize = await termSize(ipad);
    await eventually(() => {
      const [c, r] = last(pty);
      return c === ipadSize[0] && r === ipadSize[1];
    });
    await eventually(async () => (await following(laptop, sid)) === 1);
    await takeOver(laptop, sid);
    await eventually(() => {
      const [c, r] = last(pty);
      return c === laptopSize[0] && r === laptopSize[1];
    });
    await takeOver(ipad, sid);
    await eventually(() => {
      const [c, r] = last(pty);
      return c === ipadSize[0] && r === ipadSize[1];
    });
    await ipad.ctx.close();
    await laptop.ctx.close();
  }, 120_000);

  it("a deliberate open (a click on the row) takes the size at once; loading that page's address again in another browser does not", async () => {
    if (skip()) return;
    const [sid, pty] = await session("pick");
    const ipad = await openByUrl(sid, IPAD, true);
    await eventually(async () => {
      const [c] = await termSize(ipad);
      return c === last(pty)[0];
    });
    const laptop = await browserWindow(LAPTOP);
    await laptop.p.goto(`${s!.base}/terminals`);
    await laptop.p.locator(`.agr[data-id="${sid}"]`).click();
    await terms(laptop);
    const laptopSize = await termSize(laptop);
    await eventually(() => {
      const [c, r] = last(pty);
      return c === laptopSize[0] && r === laptopSize[1];
    });
    expect(await following(laptop, sid)).toBe(0);
    await eventually(async () => (await following(ipad, sid)) === 1);

    await away(ipad, () => ipad.p.goto(laptop.p.url()));
    await settle();
    expect(last(pty)).toEqual(laptopSize);
    await eventually(async () => (await following(ipad, sid)) === 1);

    await away(laptop, () => laptop.p.reload());
    await settle();
    expect(last(pty)).toEqual(laptopSize);
    expect(await following(laptop, sid)).toBe(0);
    await ipad.ctx.close();
    await laptop.ctx.close();
  }, 120_000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
