import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let webkit: Browser | null = null;
let chromium: Browser | null = null;
let latest = "";
let step = "start";
const errors: string[] = [];
const leaving = new Set<Page>();

const IPAD = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };
const SHOWS_SIZE =
  "trap 'echo \"SIZE $(stty size)\"' WINCH; echo READY; while :; do sleep 1 & wait $!; done";

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    webkit = await launchBrowser(pw.webkit);
    chromium = await launchBrowser(pw.chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  expect(loadPty().available).toBe(true);
  s = await startAgentsPageServer({ realPty: true });
  host = await connectHost(sessionPaths(s.stateDir).socket);
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [webkit, chromium],
    servers: [host, s],
  });
});

const skip = () => !webkit || !chromium;

interface View {
  ctx: BrowserContext;
  p: Page;
  name: string;
}

async function shell(name: string): Promise<string> {
  const info = await host!.start({
    name: `acme-north:${name}`,
    cwd: s!.wsDir("north"),
    argv: ["sh", "-c", SHOWS_SIZE],
    env: {},
    cols: 80,
    rows: 24,
  });
  await eventually(async () => (await output(info.ref.id)).includes("READY"));
  return info.ref.id;
}

async function output(sid: string): Promise<string> {
  return (await host!.scrollback(sid, 1 << 20)).toString("utf-8");
}

async function ptySize(sid: string): Promise<string> {
  const all = [...(await output(sid)).matchAll(/SIZE (\d+) (\d+)/g)];
  const at = all.at(-1);
  return at ? `${at[2]}x${at[1]}` : "80x24";
}

async function open(
  b: Browser,
  name: string,
  sid: string,
  size: { width: number; height: number },
  touch: boolean,
): Promise<View> {
  const ctx = await b.newContext({
    viewport: size,
    hasTouch: touch,
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch (e) {
      void e;
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
    if (!leaving.has(p)) errors.push(`${name} [${step}]: ${e.message}`);
  });
  const v = { ctx, p, name };
  await p.goto(`${s!.base}/terminals?open=${sid}`);
  await attached(v, 0);
  return v;
}

async function sockets(v: View): Promise<number> {
  return v.p.evaluate(
    () =>
      (window as unknown as { __socks?: WebSocket[] }).__socks?.length ?? 0,
  );
}

async function attached(v: View, before: number): Promise<void> {
  await v.p.waitForFunction(
    (n) => {
      const socks =
        (window as unknown as { __socks?: WebSocket[] }).__socks ?? [];
      return socks.length > n && socks.at(-1)!.readyState === WebSocket.OPEN;
    },
    before,
    { timeout: 20_000 },
  );
  await v.p.waitForSelector("[data-id] textarea", {
    state: "attached",
    timeout: 20_000,
  });
}

async function eventually(
  pred: () => Promise<boolean> | boolean,
  ms = 15_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out [${step}]`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function holds(sid: string, size: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    expect(await ptySize(sid)).toBe(size);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const following = async (v: View, sid: string) =>
  (await v.p.locator(`[data-id="${sid}"] [data-act="take-size"]`).count()) ===
  1;
const takeOver = (v: View, sid: string) =>
  v.p.locator(`[data-id="${sid}"] [data-act="take-size"]`).click();

async function sized(sid: string, to: string): Promise<void> {
  await eventually(async () => (await ptySize(sid)) === to);
}

async function appSwitch(v: View, width: number): Promise<void> {
  const before = await sockets(v);
  await v.p.evaluate(() => {
    const d = document as unknown as Record<string, unknown>;
    Object.defineProperty(d, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(d, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    for (const sk of (window as unknown as { __socks: WebSocket[] }).__socks)
      sk.close();
  });
  await v.p.setViewportSize({ width, height: IPAD.height });
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
  await attached(v, before);
}

async function reload(v: View): Promise<void> {
  leaving.add(v.p);
  try {
    await v.p.reload();
    await attached(v, 0);
  } finally {
    leaving.delete(v.p);
  }
}

async function closeSocketNormally(v: View): Promise<void> {
  const before = await sockets(v);
  await v.p.evaluate(() => {
    for (const sk of (window as unknown as { __socks: WebSocket[] }).__socks)
      if (sk.readyState === WebSocket.OPEN) sk.close(1000);
  });
  await attached(v, before);
}

async function shut(v: View): Promise<void> {
  leaving.add(v.p);
  await v.ctx.close();
}

async function ipadThenDesktop(
  sid: string,
): Promise<{ ipad: View; desktop: View; ipadSize: string; desk: string }> {
  step = "ipad opens";
  const ipad = await open(webkit!, "ipad", sid, IPAD, true);
  await eventually(async () => (await ptySize(sid)) !== "80x24");
  const ipadSize = await ptySize(sid);
  step = "desktop opens";
  const desktop = await open(chromium!, "desktop", sid, DESKTOP, false);
  await eventually(() => following(desktop, sid));
  expect(await ptySize(sid)).toBe(ipadSize);
  step = "desktop takes over";
  await takeOver(desktop, sid);
  await eventually(async () => (await ptySize(sid)) !== ipadSize);
  const desk = await ptySize(sid);
  await eventually(() => following(ipad, sid));
  expect(await following(desktop, sid)).toBe(false);
  return { ipad, desktop, ipadSize, desk };
}

describe("issue 1724: WebKit at an iPad's size and Chromium at a desktop's, one terminal, Den's own server, host and PTY", () => {
  it("1001: the desktop takes over, then reloads while the iPad comes back from an app switch; the desktop keeps the size; once it closes, the iPad gets it", async () => {
    if (skip()) return;
    const sid = await shell("leave-1001");
    const { ipad, desktop, desk } = await ipadThenDesktop(sid);

    step = "desktop reloads, ipad app switch";
    await Promise.all([reload(desktop), appSwitch(ipad, IPAD.width - 40)]);
    await eventually(() => following(ipad, sid));
    await holds(sid, desk);
    expect(await following(desktop, sid)).toBe(false);

    step = "ipad reloads";
    await reload(ipad);
    await eventually(() => following(ipad, sid));
    await holds(sid, desk);

    step = "desktop closes";
    await shut(desktop);
    await eventually(async () => (await ptySize(sid)) !== desk, 20_000);
    await eventually(() => following(ipad, sid).then((f) => !f));
    await shut(ipad);
    expect(errors).toEqual([]);
  }, 150_000);

  it("a normal close: the desktop takes over, its socket closes normally and comes back while the iPad comes back from an app switch; the desktop keeps the size", async () => {
    if (skip()) return;
    const sid = await shell("leave-normal");
    const { ipad, desktop, desk } = await ipadThenDesktop(sid);

    step = "desktop normal close, ipad app switch";
    await Promise.all([
      closeSocketNormally(desktop),
      appSwitch(ipad, IPAD.width - 40),
    ]);
    await eventually(() => following(ipad, sid));
    await holds(sid, desk);
    expect(await following(desktop, sid)).toBe(false);

    step = "ipad app switch again";
    await appSwitch(ipad, IPAD.width - 60);
    await eventually(() => following(ipad, sid));
    await holds(sid, desk);

    await shut(desktop);
    await shut(ipad);
    expect(errors).toEqual([]);
  }, 150_000);

  it("the person's Take over on the iPad while the desktop is away holds when the desktop comes back, after a 1001 and after a normal close", async () => {
    if (skip()) return;
    const sid = await shell("take-over");
    const { ipad, desktop, desk } = await ipadThenDesktop(sid);

    step = "desktop reloads, person takes over on ipad";
    leaving.add(desktop.p);
    const back = desktop.p.reload();
    await takeOver(ipad, sid);
    await eventually(async () => (await ptySize(sid)) !== desk);
    const ipadNow = await ptySize(sid);
    await back;
    await attached(desktop, 0);
    leaving.delete(desktop.p);
    await eventually(() => following(desktop, sid));
    await holds(sid, ipadNow);
    expect(await following(ipad, sid)).toBe(false);

    step = "desktop takes over again";
    await takeOver(desktop, sid);
    await sized(sid, desk);
    await eventually(() => following(ipad, sid));

    step = "desktop normal close, person takes over on ipad";
    const before = await sockets(desktop);
    await desktop.p.evaluate(() => {
      for (const sk of (window as unknown as { __socks: WebSocket[] }).__socks)
        if (sk.readyState === WebSocket.OPEN) sk.close(1000);
    });
    await takeOver(ipad, sid);
    await sized(sid, ipadNow);
    await attached(desktop, before);
    await eventually(() => following(desktop, sid));
    await holds(sid, ipadNow);
    expect(await following(ipad, sid)).toBe(false);

    await shut(desktop);
    await shut(ipad);
    expect(errors).toEqual([]);
  }, 150_000);
});
