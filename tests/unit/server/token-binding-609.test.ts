/**
 * Issue 609: when Den can't place an agent's caller, the audit says why
 * (the lookup timed out, failed, found no matching connection or several,
 * or was still running when the wait ended), and a caller that had
 * already closed its connection is told apart ("the caller had gone"):
 * nothing answers it, so it isn't counted as a refusal of a live agent.
 * The binding is unchanged: an unplaced caller is still refused.
 *
 * A real loopback server; the lookups are fakes (no real lsof or /proc).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as tb from "../../../src/ui/server/token-binding.js";
import { loopbackPeerFind } from "../../../src/shared/peer-process.js";
import { LookupTimeoutError } from "../../../src/shared/proc-lookup.js";

const ROOT = 200;
const AGENT = "den_at_TESTONLY_609";

let server: http.Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  server = null;
});

interface Judged {
  from: tb.TokenCaller;
  why: tb.PeerMiss | null;
}

/** A server as Den's; each request waits `before`, then for the lookup. */
async function serve(
  d: tb.BindingDeps,
  before: () => Promise<void> = async () => undefined,
  waitMs = 2_000,
): Promise<{ port: number; judged: Promise<Judged> }> {
  let done!: (v: Judged) => void;
  const judged = new Promise<Judged>((r) => (done = r));
  server = http.createServer((req, res) => {
    void (async () => {
      await before();
      await tb.peerSettled(req, waitMs, d);
      const from = tb.tokenCaller(req, ROOT, d);
      done({ from, why: tb.callerMiss(req) });
      res.end(from);
    })();
  });
  server.on("connection", (s) => tb.watchPeer(s, d));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, judged };
}

function agentCall(port: number, closeAfterSend = false): net.Socket {
  const c = net.connect(port, "127.0.0.1");
  c.on("connect", () => {
    c.write(
      `POST /api/agents/self/attention HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${AGENT}\r\nContent-Length: 0\r\n\r\n`,
    );
    if (closeAfterSend) c.destroy();
  });
  c.on("error", () => undefined);
  return c;
}

const descends = () => false;

describe("issue 609: an unplaced caller's reason", () => {
  for (const miss of ["timeout", "none", "several", "failed"] as const)
    it(`the lookup's own answer (${miss}) is kept, and still refused`, async () => {
      const { port, judged } = await serve({
        peer: async () => ({ miss }),
        descends,
      });
      const c = agentCall(port);
      const j = await judged;
      c.destroy();
      expect(j.from).toBe("unknown");
      expect(j.why).toBe(miss);
    });

  it("the wait ended while the lookup still ran: waiting", async () => {
    const { port, judged } = await serve(
      { peer: () => new Promise<null>(() => undefined), descends },
      undefined,
      200,
    );
    const c = agentCall(port);
    const j = await judged;
    c.destroy();
    expect(j.from).toBe("unknown");
    expect(j.why).toBe("waiting");
  });

  it("the caller closed before it could be placed: gone, still refused", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { port, judged } = await serve(
      { peer: async () => null, descends },
      () => held,
    );
    const c = agentCall(port, true);
    c.on("close", () => setTimeout(release, 50));
    const j = await judged;
    expect(j.from).toBe("unknown");
    expect(j.why).toBe("gone");
  });

  it("a caller still connected that the lookup didn't find: none, not gone", async () => {
    const { port, judged } = await serve({ peer: async () => null, descends });
    const c = agentCall(port);
    const j = await judged;
    c.destroy();
    expect(j.why).toBe("none");
  });

  it("the audit detail names the reason", () => {
    const base = {
      actor: "agent:planner",
      from: "unknown" as const,
      caller: null,
      root: ROOT,
      method: "POST",
      path: "/api/agents/self/attention",
    };
    expect(tb.refusalDetail({ ...base, why: "timeout" })).toBe(
      `agent:planner's token from a process Den couldn't place (the lookup timed out; pid ?, agent pid ${ROOT}): POST /api/agents/self/attention`,
    );
    expect(tb.refusalDetail({ ...base, why: "none" })).toContain(
      "(no matching connection;",
    );
    expect(tb.refusalDetail({ ...base, why: "several" })).toContain(
      "(more than one matching connection;",
    );
    expect(tb.refusalDetail({ ...base, why: "failed" })).toContain(
      "(the lookup failed;",
    );
    expect(tb.refusalDetail({ ...base, why: "waiting" })).toContain(
      "(the lookup was still running;",
    );
    expect(tb.refusalDetail({ ...base, why: "gone" })).toContain(
      "(the caller had gone;",
    );
  });
});

describe("issue 609: the lookup says why it found no caller (macOS, fake lsof)", () => {
  const PORT = 52922;
  const TO = 7777;
  const row = (pid: number) => `p${pid}\nn127.0.0.1:${PORT}->127.0.0.1:${TO}\n`;
  const find = (run: (cmd: string) => Promise<string>) =>
    loopbackPeerFind(PORT, TO, {
      platform: "darwin",
      self: 1,
      run: (cmd) => run(cmd),
    });

  it("one caller: its line", async () => {
    expect(
      await find(async (cmd) =>
        cmd.endsWith("lsof") ? row(4242) : "4242 200\n200 1\n",
      ),
    ).toEqual({ line: [4242, 200, 1] });
  });
  it("no row: none; two: several", async () => {
    expect(await find(async () => "")).toEqual({ miss: "none" });
    expect(
      await find(async (cmd) =>
        cmd.endsWith("lsof") ? row(11) + row(12) : "",
      ),
    ).toEqual({ miss: "several" });
  });
  it("a lookup that timed out: timeout; one that couldn't run: failed", async () => {
    expect(
      await find(async () => {
        throw new LookupTimeoutError("lsof");
      }),
    ).toEqual({ miss: "timeout" });
    expect(
      await find(async () => {
        throw new Error("ENOENT");
      }),
    ).toEqual({ miss: "failed" });
  });
});
