/**
 * Issue 1528: holdIoScript, the slow terminal socket agents-terminal uses,
 * under a context that routes WebSockets. The box guard routes every one
 * (pw-guard: routeWebSocket), and Playwright's routed socket keeps its own
 * readyState, setting it as it opens and closes. A held socket that gave
 * readyState only a getter made each of those sets throw on the page
 * ("Cannot set property readyState of #<Held> which has only a getter"):
 * two page errors in agents-terminal on 2 of 3 box runs. Here the route is
 * this file's own, so it fails the same way on any machine.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import type { Browser, BrowserContext, Page } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { openBrowser } from "../helpers/browser.js";
import { holdIoScript } from "./helpers/hold-io.js";

let browser: Browser | null = null;
let server: http.Server | null = null;
let base = "";
const skip = () => !browser;

beforeAll(async () => {
  server = http.createServer((_q, r) => {
    r.setHeader("content-type", "text/html");
    r.end("<!doctype html><title>hold</title>");
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // DEN_TERMINAL_BROWSER=webkit or firefox runs it there, as
  // agents-terminal does: Playwright's routed socket is the same script.
  const engine = ["firefox", "webkit"].includes(
    process.env.DEN_TERMINAL_BROWSER ?? "",
  )
    ? (process.env.DEN_TERMINAL_BROWSER as "firefox" | "webkit")
    : "chromium";
  browser = await openBrowser(engine);
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [server] });
});

/**
 * A page whose /io sockets are routed (answered here, echoing each frame)
 * and held. `routed` resolves once the route has the page's socket: the
 * socket would be open now, were it not held.
 */
async function heldPage(): Promise<{
  p: Page;
  ctx: BrowserContext;
  errors: string[];
  routed: Promise<void>;
}> {
  const ctx = await browser!.newContext();
  let onRoute: () => void = () => undefined;
  const routed = new Promise<void>((r) => (onRoute = r));
  await ctx.routeWebSocket(/\/io$/, (ws) => {
    ws.onMessage((m) => ws.send(`echo ${String(m)}`));
    onRoute();
  });
  await ctx.addInitScript(holdIoScript);
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${base}/`);
  return { p, ctx, errors, routed };
}

type Win = {
  __releaseIo: (k: string[]) => void;
  s: WebSocket;
  out: (string | number)[];
  opened: Promise<void>;
  got: Promise<string>;
  closed: Promise<void>;
};

/** Opens the page's socket to /io, its events kept on window. */
async function openSocket(p: Page): Promise<void> {
  await p.evaluate(
    (url) => {
      const w = window as unknown as Win;
      w.out = [];
      w.s = new WebSocket(url);
      w.opened = new Promise<void>((r) => (w.s.onopen = () => r()));
      w.got = new Promise<string>(
        (r) => (w.s.onmessage = (e) => r(String(e.data))),
      );
      w.closed = new Promise<void>((r) =>
        w.s.addEventListener("close", () => r()),
      );
      w.out.push(w.s.readyState);
    },
    `${base.replace("http", "ws")}/io`,
  );
}

/**
 * The socket's readyState once it says closed (Playwright's routed socket
 * fires close just before it sets CLOSED), then any page errors: they are
 * reported before a later evaluate's answer comes back.
 */
async function closedState(p: Page): Promise<number> {
  // A socket that never says closed is answered with what it says.
  await p
    .waitForFunction(
      () => (window as unknown as Win).s.readyState === WebSocket.CLOSED,
      undefined,
      { timeout: 5_000 },
    )
    .catch(() => undefined);
  return p.evaluate(() => (window as unknown as Win).s.readyState);
}

describe("issue 1528: a held socket under a routed WebSocket", () => {
  it("opens when released, carries a frame and closes, with no page errors", async () => {
    if (skip()) return;
    const { p, ctx, errors, routed } = await heldPage();
    await openSocket(p);
    await routed;
    const seen = await p.evaluate(async () => {
      const w = window as unknown as Win;
      w.out.push(w.s.readyState); // routed, but held: still connecting
      w.__releaseIo(["open", "message"]);
      await w.opened;
      w.out.push(w.s.readyState);
      try {
        w.s.send("hi");
        w.out.push(await w.got);
      } catch (e) {
        w.out.push(`send: ${(e as Error).message}`);
      }
      w.s.close();
      await w.closed;
      return w.out;
    });
    seen.push(await closedState(p));
    expect({ seen, errors }).toEqual({
      seen: [0, 0, 1, "echo hi", 3],
      errors: [],
    });
    await ctx.close();
  }, 60_000);

  it("closes while still held (a pane left before its socket opened), with no page errors", async () => {
    if (skip()) return;
    const { p, ctx, errors, routed } = await heldPage();
    await openSocket(p);
    await routed;
    const seen = await p.evaluate(async () => {
      const w = window as unknown as Win;
      w.out.push(w.s.readyState); // held: still connecting
      try {
        w.s.close();
        await w.closed;
      } catch (e) {
        w.out.push(`close: ${(e as Error).message}`);
      }
      return w.out;
    });
    seen.push(await closedState(p));
    expect({ seen, errors }).toEqual({ seen: [0, 0, 3], errors: [] });
    await ctx.close();
  }, 60_000);
});
