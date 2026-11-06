/**
 * The Agents tab's server side (AG-4a-term, AG spec §5d) on the real
 * server: GET /api/sessions, and /api/sessions/<id>/io as a WebSocket
 * bridged to the session host's attach.
 *
 *   - the list: plain sessions (kind "session") and agents (kind "agent",
 *     persona, runtime), workspace by workspace; an agent whose token
 *     `web logout --all` revoked is marked;
 *   - attach replays the scrollback, then live output; input and resize
 *     reach the PTY; two browsers and the CLI attach at once and each sees
 *     every byte; closing the socket detaches and never kills, and a
 *     reattach replays what was missed; the session's exit is reported;
 *   - the request checks on the upgrade: Host, Origin (a cross-origin
 *     upgrade), the CSRF subprotocol, sign-in beyond loopback, an agent's
 *     token on another session's io; a plain GET is 426;
 *   - the attach and the detach are in the audit trail.
 *
 * The demo distribution (acme; workspaces north and south), a session host
 * in this process with a scripted PTY: nothing really runs, so no native
 * module is needed. No token, cookie or CSRF value is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as path from "path";
import {
  bindActorSession,
  mintActorToken,
  revokeAllActorTokens,
} from "../../../src/shared/actor-token.js";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { SessionInfo } from "../../../src/shared/sessions/types.js";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { clientFrame, wsConnect, type TestWs } from "./helpers/ws-client.js";

let s: AgentsPageServer;
let host: HostClient;
let csrf = "";
const sess: Record<string, SessionInfo> = {};
let agentToken = "";

const start = async (ws: string, name: string) => {
  const info = await host.start({
    name: `acme-${ws}:${name}`,
    cwd: s.wsDir(ws),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  sess[name] = info;
  return s.made[s.made.length - 1];
};
const pty = (name: string) => s.made.find((p) => p.pid === sess[name].pid)!;

beforeAll(async () => {
  s = await startAgentsPageServer();
  host = await connectHost(sessionPaths(s.stateDir).socket);
  (await start("north", "shell")).emit("hello from north\r\n");
  await start("south", "logs");
  // An agent bound to a live session, whose token `web logout --all`
  // revoked (SEC-1 §6c.2).
  await start("north", "scout");
  s.seed({
    id: "scout",
    persona: "reviewer",
    workspace: "north",
    session: { backend: "den-pty", id: sess.scout.ref.id },
    sessionName: "acme-north:scout",
  });
  const k = mintActorToken(s.stateDir, {
    agentId: "scout",
    workspace: "north",
    sessionName: "acme-north:scout",
  });
  bindActorSession(s.stateDir, k.key, sess.scout.ref.id);
  revokeAllActorTokens(s.stateDir);
  // An agent with a live token: its own session's io only.
  await start("north", "planner");
  const t = mintActorToken(s.stateDir, {
    agentId: "planner",
    workspace: "north",
    sessionName: "acme-north:planner",
  });
  bindActorSession(s.stateDir, t.key, sess.planner.ref.id);
  agentToken = t.token;
  const r = await fetch(`${s.base}/api/session`, {
    headers: { "sec-fetch-site": "same-origin" },
  });
  csrf = String(((await r.json()) as { csrf: unknown }).csrf ?? "");
}, 60_000);

afterAll(async () => {
  host?.close();
  await s?.stop();
});

/** What a page on this server sends: its Origin and the CSRF subprotocol. */
const browser = (extra: Record<string, string> = {}) => ({
  origin: s.base,
  "sec-websocket-protocol": `den.io, den.csrf.${csrf}`,
  ...extra,
});
const io = (name: string) => `/api/sessions/${sess[name].ref.id}/io`;
async function attach(
  name: string,
  headers: Record<string, string> = browser(),
): Promise<TestWs> {
  const r = await wsConnect(s.port, io(name), headers);
  if (!r.ok)
    throw new Error(`upgrade refused: ${r.status} ${String(r.body.code)}`);
  return r.ws;
}
async function refusal(
  p: string,
  headers: Record<string, string>,
): Promise<[number, unknown]> {
  const r = await wsConnect(s.port, p, headers);
  if (r.ok) {
    r.ws.close();
    return [101, "upgraded"];
  }
  return [r.status, r.body.code];
}
const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));
async function eventually(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out");
    await settle(25);
  }
}

describe("GET /api/sessions", () => {
  it("lists the active workspaces' sessions and agents: kind, workspace, label, persona, runtime, state; a revoked token is marked", async () => {
    const r = await fetch(`${s.base}/api/sessions`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      sessions: Record<string, unknown>[];
      workspaces: string[];
      io: { allowed: boolean };
      host: boolean;
    };
    expect(j.workspaces).toEqual(["north", "south"]);
    expect(j.host).toBe(true);
    expect(j.io.allowed).toBe(true);
    const by = (label: string) => j.sessions.find((x) => x.label === label);
    expect(by("shell")).toMatchObject({
      id: sess.shell.ref.id,
      name: "acme-north:shell",
      workspace: "north",
      kind: "session",
      state: "running",
      exited: false,
      attachable: true,
    });
    expect(by("shell")).not.toHaveProperty("persona");
    expect(by("logs")).toMatchObject({ workspace: "south", kind: "session" });
    expect(by("scout")).toMatchObject({
      kind: "agent",
      agent: "scout",
      persona: "reviewer",
      runtime: "den-claude",
      state: "running",
      tokenRevoked: true,
    });
    expect(by("planner")).toMatchObject({ kind: "session" });
    expect(by("planner")).not.toHaveProperty("tokenRevoked");
    // Grouped by workspace, in the active order.
    expect(j.sessions.map((x) => x.workspace)).toEqual([
      "north",
      "north",
      "north",
      "south",
    ]);
    // Nothing the host doesn't know: no approval state yet (AG-6a).
    expect(j.sessions.some((x) => "waiting" in x)).toBe(false);
  });
});

describe("the io WebSocket", () => {
  it("attaches: a session frame, then the scrollback replay, then live output; the den.io subprotocol", async () => {
    const ws = await attach("shell");
    expect(ws.headers["sec-websocket-protocol"]).toBe("den.io");
    await ws.until(() => ws.output().includes("hello from north"));
    expect(ws.controls()[0]).toMatchObject({
      type: "session",
      id: sess.shell.ref.id,
      name: "acme-north:shell",
      workspace: "north",
      label: "shell",
      exited: false,
    });
    pty("shell").emit("live line\r\n");
    await ws.until(() => ws.output().includes("live line"));
    ws.close();
    expect(await ws.closed).toBe(1000);
  });

  it("input (binary frames, or an input control) and resize reach the PTY", async () => {
    const ws = await attach("shell");
    const p = pty("shell");
    const before = p.writes.length;
    ws.sendBinary("ls -la\r");
    ws.sendText(JSON.stringify({ type: "input", data: "pwd\r" }));
    ws.sendText(JSON.stringify({ type: "resize", cols: 132, rows: 41 }));
    // Out of range or not JSON: ignored, the socket stays.
    ws.sendText(JSON.stringify({ type: "resize", cols: 0, rows: 99999 }));
    ws.sendText("not json");
    await eventually(() => p.writes.length >= before + 2);
    expect(Buffer.concat(p.writes.slice(before)).toString("utf-8")).toBe(
      "ls -la\rpwd\r",
    );
    await eventually(() => p.resizes.some(([c, r]) => c === 132 && r === 41));
    expect(p.resizes.some(([c]) => c === 0)).toBe(false);
    // A fragmented message is one input.
    ws.raw(
      Buffer.concat([
        clientFrame(0x2, Buffer.from("ech"), false),
        clientFrame(0x0, Buffer.from("o hi\r"), true),
      ]),
    );
    await eventually(() =>
      Buffer.concat(p.writes).toString("utf-8").endsWith("echo hi\r"),
    );
    ws.close();
    await ws.closed;
  });

  it("two browsers and the CLI attach at once: each sees every byte, and either browser's typing reaches the session", async () => {
    const a = await attach("shell");
    const b = await attach("shell");
    const cli: Buffer[] = [];
    const cliHost = await connectHost(sessionPaths(s.stateDir).socket);
    const att = cliHost.attach(
      sess.shell.ref.id,
      { onData: (d) => cli.push(d) },
      { replay: 0 },
    );
    await att.ready;
    await a.until(() => a.controls().length > 0);
    await b.until(() => b.controls().length > 0);
    pty("shell").emit("for everyone\r\n");
    await a.until(() => a.output().includes("for everyone"));
    await b.until(() => b.output().includes("for everyone"));
    await eventually(() =>
      Buffer.concat(cli).toString("utf-8").includes("for everyone"),
    );
    const p = pty("shell");
    const before = p.writes.length;
    b.sendBinary("from b\r");
    await eventually(() => p.writes.length > before);
    expect(p.writes[p.writes.length - 1].toString()).toBe("from b\r");
    att.detach();
    cliHost.close();
    a.close();
    b.close();
    await Promise.all([a.closed, b.closed]);
  });

  it("closing the socket detaches and never kills: the session runs on, and a reattach replays what was missed", async () => {
    const ws = await attach("shell");
    await ws.until(() => ws.controls().length > 0);
    ws.close();
    await ws.closed;
    await settle(200);
    expect(pty("shell").signals).toEqual([]);
    const listed = (await host.list()).find(
      (x) => x.ref.id === sess.shell.ref.id,
    )!;
    expect(listed.exited).toBeFalsy();
    // Output while nobody is attached is kept (the scrollback).
    pty("shell").emit("while you were away\r\n");
    // A socket that just drops (no closing handshake) detaches too.
    const dropped = await attach("shell");
    await dropped.until(() => dropped.output().includes("while you were away"));
    expect(dropped.output()).toMatch(/hello from north[\s\S]*live line/);
    dropped.destroy();
    await dropped.closed;
    await settle(200);
    expect(pty("shell").signals).toEqual([]);
  });

  it("reports the session's exit, after which the replay still opens", async () => {
    const ws = await attach("logs");
    await ws.until(() => ws.controls().length > 0);
    pty("logs").emit("last words\r\n");
    pty("logs").exit(3);
    await ws.until(() => ws.controls().some((c) => c.type === "exit"));
    expect(ws.controls().find((c) => c.type === "exit")).toEqual({
      type: "exit",
      exitCode: 3,
    });
    ws.close();
    await ws.closed;
    const again = await attach("logs");
    await again.until(() => again.controls().some((c) => c.type === "exit"));
    expect(again.output()).toContain("last words");
    expect(again.controls()[0]).toMatchObject({ exited: true, exitCode: 3 });
    again.close();
    await again.closed;
  });

  it("an unmasked client frame is a protocol error (1002)", async () => {
    const ws = await attach("shell");
    ws.raw(Buffer.from([0x82, 0x02, 0x68, 0x69]));
    expect(await ws.closed).toBe(1002);
  });

  it("a plain GET is 426 (it is a WebSocket); an unknown session or another distribution's is 404", async () => {
    // A shell-grade GET: same-origin only (the mutating-GET check), then 426.
    expect((await fetch(`${s.base}${io("shell")}`)).status).toBe(403);
    const r = await fetch(`${s.base}${io("shell")}`, {
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(r.status).toBe(426);
    expect(((await r.json()) as { code: string }).code).toBe(
      "upgrade_required",
    );
    expect(await refusal("/api/sessions/nope/io", browser())).toEqual([
      404,
      "not_found",
    ]);
    const other = await host.start({
      name: "other-north:shell",
      cwd: s.wsDir("north"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    expect(
      await refusal(`/api/sessions/${other.ref.id}/io`, browser()),
    ).toEqual([404, "not_found"]);
    const list = (await (await fetch(`${s.base}/api/sessions`)).json()) as {
      sessions: { name: string }[];
    };
    expect(list.sessions.map((x) => x.name)).not.toContain("other-north:shell");
  });
});

describe("the request checks on the io upgrade", () => {
  it("refuses a cross-origin upgrade, one with no Origin and no bearer, and one without the CSRF subprotocol (403)", async () => {
    expect(
      await refusal(io("shell"), browser({ origin: "http://evil.example" })),
    ).toEqual([403, "origin_rejected"]);
    expect(
      await refusal(io("shell"), {
        origin: `http://localhost:${s.port + 1}`,
        "sec-websocket-protocol": `den.io, den.csrf.${csrf}`,
      }),
    ).toEqual([403, "origin_rejected"]);
    expect(
      await refusal(io("shell"), { "sec-websocket-protocol": "den.io" }),
    ).toEqual([403, "origin_rejected"]);
    expect(
      await refusal(io("shell"), {
        origin: s.base,
        "sec-websocket-protocol": "den.io",
      }),
    ).toEqual([403, "csrf"]);
    expect(
      await refusal(io("shell"), {
        origin: s.base,
        "sec-websocket-protocol": "den.io, den.csrf.wrong",
      }),
    ).toEqual([403, "csrf"]);
  });

  it("refuses a Host it doesn't answer to (421) and, beyond loopback, a browser with no session (401 signin_required)", async () => {
    expect(
      await refusal(io("shell"), browser({ host: "evil.example" })),
    ).toEqual([421, "misdirected"]);
    // The edge hostname is beyond loopback: no session, no terminal.
    const edgeHost = "acme.acme.localhost";
    expect(
      await refusal(
        io("shell"),
        browser({ host: edgeHost, origin: `http://${edgeHost}` }),
      ),
    ).toEqual([401, "signin_required"]);
  });

  it("an agent's token opens its own session's io (by id or name), never another's (403 agent_forbidden)", async () => {
    const bearer = { authorization: `Bearer ${agentToken}` };
    expect(await refusal(io("shell"), bearer)).toEqual([
      403,
      "agent_forbidden",
    ]);
    expect(await refusal(io("planner"), bearer)).toEqual([101, "upgraded"]);
    expect(
      await refusal(
        `/api/sessions/${encodeURIComponent("acme-north:planner")}/io`,
        bearer,
      ),
    ).toEqual([101, "upgraded"]);
  });

  it("the CLI's person token opens any session's io, with no Origin", async () => {
    expect(await refusal(io("shell"), denAuth(s.stateDir))).toEqual([
      101,
      "upgraded",
    ]);
  });
});

describe("the audit trail", () => {
  it("records each attach and detach with the actor from the credential", async () => {
    const ws = await attach("planner", {
      authorization: `Bearer ${agentToken}`,
    });
    await ws.until(() => ws.controls().length > 0);
    ws.close();
    await ws.closed;
    await eventually(() =>
      /▶ sessions detach acme-north:planner \(browser, \d+s\) · by agent:planner/.test(
        s.log(),
      ),
    );
    const lines = s
      .log()
      .split("\n")
      .filter((l) => /▶ sessions (attach|detach) /.test(l));
    expect(
      lines.some((l) => /attach acme-north:shell \(browser\)/.test(l)),
    ).toBe(true);
    expect(
      lines.some((l) =>
        /attach acme-north:planner \(browser\) · by agent:planner/.test(l),
      ),
    ).toBe(true);
    // The CLI's call is the person's.
    expect(
      lines.some((l) =>
        /attach acme-north:shell \(browser\) · as person:/.test(l),
      ),
    ).toBe(true);
    // Never a token or the CSRF value.
    expect(s.log().includes(agentToken)).toBe(false);
    expect(s.log().includes(csrf)).toBe(false);
    expect(path.basename(s.stateDir)).toBe(".acme");
  });
});
