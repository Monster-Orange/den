/**
 * Issue 1131: under load, Den's lookup of an agent's caller (the loopback
 * peer, by client and server port) can find no connection on its first
 * try, or two processes holding it. The agent's call was then refused,
 * though it came from the agent's own processes.
 *
 *   - A lookup that finds nothing tries again while an agent's request
 *     waits for it (agents.token_peer_wait_ms); a later answer is judged
 *     exactly as a first one would be. Other callers get one try.
 *   - Two (or more) processes on the connection: accepted only when every
 *     one of them runs inside the agent's own session. One outside, or no
 *     line to check, and it is refused as before.
 *   - Neither ever widens what is accepted: a caller outside the agent's
 *     processes is still refused, and sign-in's caller (callerPid) stays
 *     unplaced for two matches.
 *
 * A real loopback server; the lookups are fakes (no real lsof or /proc).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as tb from "../../../src/ui/server/token-binding.js";
import { loopbackPeerFind } from "../../../src/shared/peer-process.js";

const ROOT = 200;
const AGENT = "den_at_TESTONLY_1131";

let server: http.Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = null;
});

interface Judged {
  from: tb.TokenCaller;
  why: tb.PeerMiss | null;
  pid: number | null;
}

/** A server as Den's: each agent request waits for its caller, then is judged. */
async function serve(
  d: tb.BindingDeps,
  waitMs = 3_000,
): Promise<{ port: number; judged: Promise<Judged> }> {
  let done!: (v: Judged) => void;
  const judged = new Promise<Judged>((r) => (done = r));
  server = http.createServer((req, res) => {
    void (async () => {
      await tb.peerSettled(req, waitMs, d);
      const from = tb.tokenCaller(req, ROOT, d);
      done({ from, why: tb.callerMiss(req), pid: tb.callerPid(req, d) });
      res.end(from);
    })();
  });
  server.on("connection", (s) => tb.watchPeer(s, d));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, judged };
}

function agentCall(port: number): net.Socket {
  const c = net.connect(port, "127.0.0.1");
  c.on("connect", () =>
    c.write(
      `POST /hub/mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${AGENT}\r\nContent-Length: 0\r\n\r\n`,
    ),
  );
  c.on("error", () => undefined);
  return c;
}

/** The lookup's answers in turn; the last one repeats. */
function answers(
  ...a: Awaited<ReturnType<NonNullable<tb.BindingDeps["peer"]>>>[]
) {
  let i = 0;
  const calls = { n: 0 };
  const peer = async () => {
    calls.n++;
    return a[Math.min(i++, a.length - 1)];
  };
  return { peer, calls };
}

/** 201 and 202 run inside the agent's session; 900 doesn't. */
const descends = (pid: number, root: number) =>
  root === ROOT && (pid === 201 || pid === 202);

async function judge(d: tb.BindingDeps, waitMs = 3_000): Promise<Judged> {
  const { port, judged } = await serve(d, waitMs);
  const c = agentCall(port);
  const j = await judged;
  c.destroy();
  return j;
}

describe("issue 1131: a lookup that finds nothing tries again", () => {
  it("misses once, then finds the agent's own process: placed, and accepted", async () => {
    const a = answers({ miss: "none" }, 201);
    const j = await judge({ peer: a.peer, descends }, 1_000);
    expect(j).toEqual({ from: "ok", why: null, pid: 201 });
    expect(a.calls.n).toBe(2);
  });

  it("finds nothing for its whole window: still refused, and says why", async () => {
    const a = answers({ miss: "none" });
    const j = await judge({ peer: a.peer, descends }, 400);
    expect(j.from).toBe("unknown");
    expect(j.why).toBe("none");
    expect(a.calls.n).toBeGreaterThan(1);
  });

  it("a retry that finds a process outside the agent's: refused, as a first answer would be", async () => {
    const a = answers({ miss: "none" }, 900);
    const j = await judge({ peer: a.peer, descends }, 1_000);
    expect(j.from).toBe("elsewhere");
    expect(j.pid).toBe(900);
  });

  it("with no window (0): one try, as before", async () => {
    const a = answers({ miss: "none" }, 201);
    const j = await judge({ peer: a.peer, descends }, 0);
    expect(j.from).toBe("unknown");
    expect(a.calls.n).toBe(1);
  });

  it("only a miss of no connection is tried again: a timeout or a failure is answered at once", async () => {
    for (const miss of ["timeout", "failed", "several"] as const) {
      const a = answers({ miss }, 201);
      const j = await judge({ peer: a.peer, descends }, 1_000);
      expect(j.from).toBe("unknown");
      expect(a.calls.n).toBe(1);
    }
  });
});

describe("issue 1131: only an agent's request pays for another try", () => {
  it("a connection with no agent request waiting on it gets one lookup", async () => {
    const a = answers({ miss: "none" }, 201);
    server = http.createServer((_req, res) => res.end("ok"));
    server.on("connection", (s) => tb.watchPeer(s, { peer: a.peer, descends }));
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    await fetch(`http://127.0.0.1:${port}/`);
    await new Promise((r) => setTimeout(r, 300));
    expect(a.calls.n).toBe(1);
  });
});

describe("issue 1131: two processes on the agent's connection", () => {
  it("both inside the agent's session (a helper and its parent): accepted", async () => {
    const a = answers({ miss: "several", lines: [[201], [202]] });
    const j = await judge({ peer: a.peer, descends });
    expect(j.from).toBe("ok");
    // Sign-in's caller stays unplaced: it never takes two matches.
    expect(j.pid).toBeNull();
  });

  it("one inside the agent's session and one outside: refused", async () => {
    const a = answers({ miss: "several", lines: [[201], [900]] });
    const j = await judge({ peer: a.peer, descends });
    expect(j.from).toBe("unknown");
    expect(j.why).toBe("several");
  });

  it("from two sessions (none of them the agent's): refused", async () => {
    const other = (pid: number, root: number) => root !== ROOT && pid > 0;
    const a = answers({ miss: "several", lines: [[201], [202]] });
    const j = await judge({ peer: a.peer, descends: other });
    expect(j.from).toBe("unknown");
  });

  it("two matches with no lines to check (two connections): refused", async () => {
    const a = answers({ miss: "several" });
    const j = await judge({ peer: a.peer, descends });
    expect(j.from).toBe("unknown");
    expect(j.why).toBe("several");
  });

  it("the real lookup's lines: accepted only when every line runs through the agent's root", async () => {
    const inside = answers({
      miss: "several",
      lines: [
        [201, ROOT, 1],
        [202, 201, ROOT, 1],
      ],
    });
    expect((await judge({ peer: inside.peer })).from).toBe("ok");
    const mixed = answers({
      miss: "several",
      lines: [
        [201, ROOT, 1],
        [900, 1],
      ],
    });
    expect((await judge({ peer: mixed.peer })).from).toBe("unknown");
  });
});

describe("issue 1131: never wider than before", () => {
  it("a single caller outside the agent's processes is still refused", async () => {
    const a = answers(900);
    expect((await judge({ peer: a.peer, descends }, 1_000)).from).toBe(
      "elsewhere",
    );
  });
});

describe("issue 1131: the real lookup gives each process's line for several", () => {
  const PORT = 50111;
  const TO = 7777;
  const row = (pid: number) => `p${pid}\nn127.0.0.1:${PORT}->127.0.0.1:${TO}\n`;
  const find = (ps: string) =>
    loopbackPeerFind(PORT, TO, {
      platform: "darwin",
      self: 1,
      run: async (cmd) => (cmd.endsWith("lsof") ? row(11) + row(12) : ps),
    });

  it("two processes with whole lines: several, with both lines", async () => {
    expect(await find("11 200\n12 11\n200 1\n")).toEqual({
      miss: "several",
      lines: [
        [11, 200, 1],
        [12, 11, 200, 1],
      ],
    });
  });

  it("a line that can't be read up to init: several, with no lines (refused)", async () => {
    expect(await find("11 200\n200 1\n")).toEqual({ miss: "several" });
  });
});
