/**
 * Issue 242: an agent's own calls (its attention hook, the Hub inbox)
 * were refused as from "a process Den couldn't place" when Den was busy.
 * The caller's pid was looked up late, in the request, by then the hook
 * had given up and its connection was gone. Now the lookup starts when
 * the connection arrives (watchPeer) and the request waits for it, at
 * most agents.token_peer_wait_ms (peerSettled). Binding stays on.
 *
 * A real loopback server here; the lookup is a fake that answers what it
 * saw when it was asked (as lsof does), a little later.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as tb from "../../../src/ui/server/token-binding.js";

const ROOT = 200;
const CALLER = 4242;
const OTHER = 5151;
const AGENT = "den_at_TESTONLY_242";

type Deps = tb.BindingDeps;
/** Present after the fix; before it, the server had no connection step. */
const watch = (s: net.Socket, d: Deps) =>
  (tb as { watchPeer?: (s: net.Socket, d: Deps) => void }).watchPeer?.(s, d);
const settled = (r: http.IncomingMessage, ms: number, d: Deps) =>
  (
    tb as {
      peerSettled?: (
        r: http.IncomingMessage,
        ms: number,
        d: Deps,
      ) => Promise<void>;
    }
  ).peerSettled?.(r, ms, d);

let server: http.Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = null;
});

/**
 * Client ports that have closed. A lookup sees any port not closed yet, as
 * lsof does: the socket exists from the kernel's accept, even before the
 * client's own "connect" callback runs (on Linux the server's "connection"
 * often comes first).
 */
const closed = new Set<number>();

/** Answers, after `ms`, the pid it saw when asked (null: nobody there). */
const lateLookup =
  (pid: number, ms = 30) =>
  (port: number): Promise<number | null> => {
    const there = closed.has(port) ? null : pid;
    return new Promise((r) => setTimeout(() => r(there), ms));
  };

const descends = (pid: number, root: number) => root === ROOT && pid === CALLER;

/**
 * A server as Den's: the lookup starts on "connection"; each request
 * waits `before` (a busy Den), then for the lookup, then is judged.
 */
async function serve(
  d: Deps,
  before: () => Promise<void> = async () => undefined,
  waitMs = 5_000,
): Promise<{
  port: number;
  judged: Promise<{ from: tb.TokenCaller; pid: number | null; ms: number }>;
}> {
  let done!: (v: {
    from: tb.TokenCaller;
    pid: number | null;
    ms: number;
  }) => void;
  const judged = new Promise<{
    from: tb.TokenCaller;
    pid: number | null;
    ms: number;
  }>((r) => (done = r));
  server = http.createServer((req, res) => {
    void (async () => {
      await before();
      const t0 = Date.now();
      await settled(req, waitMs, d);
      const from = tb.tokenCaller(req, ROOT, d);
      done({ from, pid: tb.callerPid(req, d), ms: Date.now() - t0 });
      res.end(from);
    })();
  });
  server.on("connection", (s) => watch(s, d));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, judged };
}

/** Connects, sends an agent's call, and keeps its port in `open` while connected. */
function agentCall(port: number, closeAfterSend = false): net.Socket {
  const c = net.connect(port, "127.0.0.1");
  c.on("connect", () => {
    c.write(
      `POST /api/agents/self/attention HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${AGENT}\r\nContent-Length: 0\r\n\r\n`,
    );
    if (closeAfterSend) c.end();
  });
  c.on("close", () => {
    if (c.localPort) closed.add(c.localPort);
  });
  c.on("error", () => undefined);
  return c;
}

describe("issue 242: the caller is found when it connects", () => {
  it("a caller that gave up before a busy Den read its request: found all the same (ok)", async () => {
    let gone!: () => void;
    const closed = new Promise<void>((r) => (gone = r));
    const { port, judged } = await serve(
      { peer: lateLookup(CALLER), descends },
      // Busy: the request is read only after the caller has gone.
      () => closed,
    );
    const c = agentCall(port, true);
    c.on("close", () => setTimeout(gone, 10));
    const j = await judged;
    expect(j.from).toBe("ok");
    expect(j.pid).toBe(CALLER);
  });

  it("a caller outside the agent's session is still refused (elsewhere)", async () => {
    const { port, judged } = await serve({
      peer: lateLookup(OTHER),
      descends,
    });
    agentCall(port);
    const j = await judged;
    expect(j.from).toBe("elsewhere");
    expect(j.pid).toBe(OTHER);
  });

  it("a lookup that never answers: refused as unknown after the bounded wait, both pids said", async () => {
    const { port, judged } = await serve(
      { peer: () => new Promise<number | null>(() => undefined), descends },
      undefined,
      300,
    );
    agentCall(port);
    const j = await judged;
    expect(j.from).toBe("unknown");
    expect(j.ms).toBeGreaterThanOrEqual(250);
    expect(j.ms).toBeLessThan(3_000);
    expect(
      tb.refusalDetail({
        actor: "agent:planner",
        from: "unknown",
        caller: j.pid,
        root: ROOT,
        method: "POST",
        path: "/api/agents/self/attention",
      }),
    ).toBe(
      `agent:planner's token from a process Den couldn't place (pid ?, agent pid ${ROOT}): POST /api/agents/self/attention`,
    );
    expect(
      tb.refusalDetail({
        actor: "agent:planner",
        from: "elsewhere",
        caller: OTHER,
        root: null,
        method: "GET",
        path: "/hub/api/inbox",
      }),
    ).toBe(
      `agent:planner's token from outside the agent's own processes (pid ${OTHER}, agent pid ?): GET /hub/api/inbox`,
    );
  });

  it("only an agent's token waits: a person's bearer, none, or binding off go on at once", () => {
    const req = (authorization?: string) =>
      ({
        headers: authorization ? { authorization } : {},
      }) as unknown as http.IncomingMessage;
    const on = { on: true, waitMs: 1234 };
    expect(tb.agentPeerWait(req(`Bearer ${AGENT}`), on)).toBe(1234);
    expect(tb.agentPeerWait(req("Bearer den_pt_TESTONLY_person"), on)).toBe(
      null,
    );
    expect(tb.agentPeerWait(req(), on)).toBe(null);
    expect(
      tb.agentPeerWait(req(`Bearer ${AGENT}`), { on: false, waitMs: 1234 }),
    ).toBe(null);
  });
});
