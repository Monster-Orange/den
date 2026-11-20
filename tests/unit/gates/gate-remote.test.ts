/**
 * Issue 621: a CI job in a runner VM takes a gate slot over HTTP, with a
 * gate-only runner token. It holds by lease (renewed every N seconds), not
 * by a host process. The same queue as local holders.
 *
 * In process: a temp gate dir and a temp state dir; the real request
 * checks (checkRequest) in front of the gate routes. No Den runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { GATE_DEFAULTS } from "../../../src/shared/gates/rules.js";
import { RunnerTokens } from "../../../src/shared/gates/runner-tokens.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { handleGateRoutes } from "../../../src/ui/server/gate-routes.js";
import {
  checkRequest,
  setPrincipal,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";

const tmps: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-remote-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-20T10:00:00Z");

function setup() {
  let now = T0;
  const store = new GateStore({
    dir: tmp(),
    now: () => now,
    alive: () => true,
  });
  const tokens = RunnerTokens.at(tmp(), () => now);
  return {
    store,
    tokens,
    advance: (s: number) => {
      now += s * 1000;
    },
  };
}

describe("lease holders in the store", () => {
  const remote = (s: GateStore, tokenId = "t1", runner = "ci-linux") =>
    s.askRemote({
      kind: "browser",
      who: `Acme · runner ${runner}`,
      label: "e2e",
      estimateMin: 6,
      runner,
      tokenId,
    });

  it("an ask waits behind a local holder, then gets the slot when it is released", () => {
    const { store } = setup();
    const local = store.ask({
      kind: "browser",
      who: "me",
      label: "local",
      pid: 1,
      estimateMin: 5,
    });
    const r = remote(store);
    expect(r.grantedAt).toBeUndefined();
    expect(store.place(r.id)).toBe(1);
    expect(store.release(local.id)).toBe(true);
    expect(store.get(r.id)?.grantedAt).toBeDefined();
    expect(store.place(r.id)).toBe(0);
  });

  it("a renewed lease holds past the lapse time", () => {
    const { store, advance } = setup();
    const r = remote(store);
    for (let i = 0; i < 5; i++) {
      advance(GATE_DEFAULTS.remoteRenewSeconds);
      expect(store.renew(r.id, "t1")).not.toBeNull();
    }
    advance(GATE_DEFAULTS.remoteLapseSeconds - 1);
    expect(store.get(r.id)?.grantedAt).toBeDefined();
  });

  it("a lapsed lease is taken back and recorded; the next in line starts", () => {
    const { store, advance } = setup();
    const r = remote(store);
    const next = store.ask({
      kind: "browser",
      who: "me",
      label: "next",
      pid: 1,
      estimateMin: 5,
    });
    expect(next.grantedAt).toBeUndefined();
    advance(GATE_DEFAULTS.remoteLapseSeconds + 1);
    expect(store.get(r.id)).toBeNull();
    expect(store.get(next.id)?.grantedAt).toBeDefined();
    expect(store.events().map((e) => e.event)).toContain("taken-back-lapsed");
    expect(store.renew(r.id, "t1")).toBeNull();
  });

  it("only the token that asked renews or releases its slot", () => {
    const { store } = setup();
    const r = remote(store, "t1");
    expect(store.renew(r.id, "t2")).toBeNull();
    expect(store.releaseRemote(r.id, "t2")).toBe(false);
    expect(store.releaseRemote(r.id, "t1")).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("local holders are unchanged: no lease, held by their process", () => {
    const { store, advance } = setup();
    const l = store.ask({
      kind: "cpu",
      who: "me",
      label: "unit",
      pid: 1,
      estimateMin: 5,
    });
    advance(GATE_DEFAULTS.remoteLapseSeconds * 10);
    expect(store.get(l.id)?.grantedAt).toBeDefined();
  });

  it("the view names the runner; renew and lapse are settings with permissive defaults", () => {
    const { store } = setup();
    remote(store, "t1", "ci-mac");
    expect(gateView(store).slots[0]).toMatchObject({ runner: "ci-mac" });
    expect(GATE_DEFAULTS.remoteRenewSeconds).toBe(30);
    expect(GATE_DEFAULTS.remoteLapseSeconds).toBe(120);
    expect(
      checkGatePatch({ remote_renew_seconds: 10, remote_lapse_seconds: 600 }),
    ).toEqual({
      ok: true,
      patch: { remote_renew_seconds: 10, remote_lapse_seconds: 600 },
    });
    store.writeSettings({ remote_lapse_seconds: 600 });
    expect(store.settings().remoteLapseSeconds).toBe(600);
  });
});

describe("runner tokens", () => {
  it("are kept hashed, listed without the token, and revocable", () => {
    const dir = tmp();
    const t = RunnerTokens.at(dir);
    const made = t.create("ci-linux");
    expect(made.token).toMatch(/^den_gr_/);
    expect(t.check(made.token)).toMatchObject({
      ok: true,
      runner: { name: "ci-linux" },
    });
    const file = fs.readFileSync(
      path.join(dir, "gate", "runner-tokens.json"),
      "utf-8",
    );
    expect(file).not.toContain(made.token);
    expect(JSON.stringify(t.list())).not.toContain(made.token);
    expect(JSON.stringify(t.list())).not.toContain("hash");
    expect(() => t.create("ci-linux")).toThrow(/already/);
    expect(t.revoke(made.view.id)).toBeTruthy();
    expect(t.check(made.token)).toEqual({ ok: false, code: "token_revoked" });
    expect(t.check("den_gr_nope")).toEqual({ ok: false, code: "bad_token" });
  });
});

const PORT = 41299;
function guardCtx(tokens: RunnerTokens): GuardContext {
  return {
    port: PORT,
    loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
    edgeHosts: () => [],
    verifyBearer: () => null,
    verifyRunner: (tok) => {
      const c = tokens.check(tok);
      return c.ok ? c.runner : c.code === "token_revoked" ? "revoked" : null;
    },
  };
}

async function serve() {
  const s = setup();
  const ctx = guardCtx(s.tokens);
  const server = http.createServer((req, res) => {
    // The request arrives on this server's own name, as Den's would.
    req.headers.host = `localhost:${PORT}`;
    const g = checkRequest(req, ctx);
    if (!g.ok) {
      res.writeHead(g.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: g.code, error: g.error }));
      return;
    }
    setPrincipal(req, g.principal);
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    if (!p.startsWith("/api/gate-slots")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    void handleGateRoutes(req, res, p, {
      store: () => s.store,
      title: "Acme",
      runners: () => s.tokens,
      pollMs: 20,
      audit: (() => ({})) as never,
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    p: string,
    token: string | null,
    body?: unknown,
  ) => {
    const r = await fetch(base + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: r.status,
      json: (await r.json()) as Record<string, unknown>,
    };
  };
  return { ...s, call };
}

describe("the runner routes", () => {
  it("ask waits behind a local holder, answers queued; renew is the poll; release frees it for the next in line", async () => {
    const { store, tokens, call } = await serve();
    const { token } = tokens.create("ci-linux");
    const local = store.ask({
      kind: "browser",
      who: "me",
      label: "local",
      pid: 1,
      estimateMin: 5,
    });
    const asked = await call("POST", "/api/gate-slots/ask", token, {
      kind: "browser",
      estimate_minutes: 6,
      label: "e2e",
      wait_seconds: 0,
    });
    expect(asked.status).toBe(200);
    expect(asked.json).toMatchObject({
      ok: true,
      granted: false,
      place: 1,
      renew_seconds: 30,
      lapse_seconds: 120,
    });
    const id = String(asked.json.id);
    // gate status and GET /api/gate-slots show the runner's slot.
    expect(gateView(store).slots.find((x) => x.id === id)).toMatchObject({
      runner: "ci-linux",
      who: "Acme · runner ci-linux",
    });
    store.release(local.id);
    const renewed = await call("POST", "/api/gate-slots/renew", token, { id });
    expect(renewed.json).toMatchObject({ ok: true, granted: true, place: 0 });
    // The next in line: a local holder waits behind the runner, then starts.
    const next = store.ask({
      kind: "browser",
      who: "me",
      label: "next",
      pid: 1,
      estimateMin: 5,
    });
    expect(next.grantedAt).toBeUndefined();
    const rel = await call("POST", "/api/gate-slots/release", token, { id });
    expect(rel).toEqual({ status: 200, json: { ok: true, released: true } });
    expect(store.get(next.id)?.grantedAt).toBeDefined();
  });

  it("an ask that may start answers at once, granted", async () => {
    const { tokens, call } = await serve();
    const { token } = tokens.create("ci-linux");
    const r = await call("POST", "/api/gate-slots/ask", token, {
      kind: "cpu",
      estimate_minutes: 3,
      label: "unit",
    });
    expect(r.json).toMatchObject({ ok: true, granted: true, place: 0 });
  });

  it("an ask waits up to wait_seconds for a slot freed meanwhile", async () => {
    const { store, tokens, call } = await serve();
    const { token } = tokens.create("ci-linux");
    const local = store.ask({
      kind: "browser",
      who: "me",
      label: "local",
      pid: 1,
      estimateMin: 5,
    });
    setTimeout(() => store.release(local.id), 100);
    const r = await call("POST", "/api/gate-slots/ask", token, {
      kind: "browser",
      estimate_minutes: 6,
      label: "e2e",
      wait_seconds: 5,
    });
    expect(r.json).toMatchObject({ ok: true, granted: true });
  });

  it("the runner token is refused on every other route, the slot list and ending a slot included", async () => {
    const { tokens, call } = await serve();
    const { token } = tokens.create("ci-linux");
    for (const [m, p] of [
      ["GET", "/api/settings"],
      ["POST", "/api/settings"],
      ["GET", "/api/gate-slots"],
      ["POST", "/api/gate-slots/end"],
      ["POST", "/api/approvals"],
      ["GET", "/api/sessions"],
    ] as const) {
      const r = await call(m, p, token, m === "POST" ? {} : undefined);
      expect([p, r.status, r.json.code]).toEqual([p, 403, "runner_scope"]);
    }
  });

  it("a revoked token is refused; a made-up one too", async () => {
    const { tokens, call } = await serve();
    const made = tokens.create("ci-linux");
    tokens.revoke(made.view.id);
    const r = await call("POST", "/api/gate-slots/ask", made.token, {
      kind: "cpu",
      estimate_minutes: 3,
      label: "unit",
    });
    expect([r.status, r.json.code]).toEqual([401, "token_revoked"]);
    const bad = await call("POST", "/api/gate-slots/ask", "den_gr_0_x", {
      kind: "cpu",
      estimate_minutes: 3,
      label: "unit",
    });
    expect([bad.status, bad.json.code]).toEqual([401, "unauthorized"]);
  });

  it("the runner routes take a runner token only", async () => {
    const { call } = await serve();
    const r = await call("POST", "/api/gate-slots/ask", null, {
      kind: "cpu",
      estimate_minutes: 3,
      label: "unit",
    });
    expect(r.status).toBe(401);
  });

  it("another runner can't renew or release a slot it didn't ask for; bad asks are said", async () => {
    const { tokens, call } = await serve();
    const a = tokens.create("ci-a").token;
    const b = tokens.create("ci-b").token;
    const asked = await call("POST", "/api/gate-slots/ask", a, {
      kind: "cpu",
      estimate_minutes: 3,
      label: "unit",
    });
    const id = String(asked.json.id);
    expect(
      (await call("POST", "/api/gate-slots/renew", b, { id })).status,
    ).toBe(404);
    expect(
      (await call("POST", "/api/gate-slots/release", b, { id })).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/api/gate-slots/ask", a, {
          kind: "gpu",
          estimate_minutes: 3,
          label: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/gate-slots/ask", a, {
          kind: "cpu",
          estimate_minutes: -1,
          label: "x",
        })
      ).status,
    ).toBe(400);
  });
});
