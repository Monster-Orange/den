/**
 * UK-2 (Settled in v2): the request ledger.
 *   1. GET /requests/<id> answers { id, state, result?, error?, finishedAt }:
 *      running, done (with the answer), failed ({ code, message }), unknown.
 *   3. One store per product, keyed by person and id, written to disk so it
 *      survives a restart; keep time requests.keep_minutes; its limits are
 *      settings.
 * And never a secret (Vision, 11-14): a sign-in, sign-out, link or token
 * route keeps only its state and code; any field named token, secret, code
 * or password is [redacted] before it is kept.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { EventEmitter } from "node:events";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createRequestLedger,
  ledgerGate,
  secretRoute,
} from "../../../src/ui/server/request-ledger.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-ledger-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fileFor = () => path.join(tmp, `requests-${n++}.json`);
const owner = "s:abc";
const json = (v: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(v)),
});

/** A write that `route` answers, sent through the gate with an id. */
async function through(
  l: ReturnType<typeof createRequestLedger>,
  url: string,
  id: string,
  route: (res: FakeRes) => void,
): Promise<FakeRes> {
  const req = Object.assign(new EventEmitter(), {
    method: "POST",
    url,
    headers: { "x-den-request-id": id },
    resume() {},
  });
  const res = new FakeRes();
  const handled = await ledgerGate(l, req as never, res as never, owner);
  if (!handled) route(res);
  return res;
}

class FakeRes {
  statusCode = 200;
  headersSent = false;
  out: Buffer[] = [];
  headers: Record<string, unknown> = {};
  writeHead(s: number, h?: Record<string, unknown>) {
    this.statusCode = s;
    Object.assign(this.headers, h ?? {});
    this.headersSent = true;
    return this;
  }
  getHeader(k: string) {
    return this.headers[k];
  }
  write(c: string | Buffer) {
    this.out.push(Buffer.from(c));
    return true;
  }
  end(c?: string | Buffer) {
    if (c) this.out.push(Buffer.from(c));
    return this;
  }
}

describe("the request ledger (UK-2)", () => {
  it("says done with the answer, or failed with { code, message }, and when", () => {
    let t = Date.parse("2026-11-14T23:00:00Z");
    const l = createRequestLedger({ ttlMs: () => 60_000, now: () => t });
    const a = l.begin(owner, "req-ok-001");
    if (a.kind !== "new") throw new Error("kind");
    a.finish(json({ ok: true, n: 1 }));
    expect(l.status(owner, "req-ok-001")).toEqual({
      state: "done",
      result: { ok: true, n: 1 },
      finishedAt: "2026-11-14T23:00:00.000Z",
    });
    t += 1000;
    const b = l.begin(owner, "req-bad-01");
    if (b.kind !== "new") throw new Error("kind");
    b.finish({
      status: 409,
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({ ok: false, error: "Someone changed it first." }),
      ),
    });
    expect(l.status(owner, "req-bad-01")).toEqual({
      state: "failed",
      error: { code: 409, message: "Someone changed it first." },
      finishedAt: "2026-11-14T23:00:01.000Z",
    });
  });

  it("keeps finished requests on disk (0600): a new ledger on the same file knows them", () => {
    const file = fileFor();
    const l = createRequestLedger({ ttlMs: () => 60_000, file });
    const a = l.begin(owner, "req-disk-1");
    if (a.kind !== "new") throw new Error("kind");
    a.finish(json({ ok: true, saved: "yes" }));
    l.begin(owner, "req-disk-2"); // still running: not kept on disk
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = createRequestLedger({ ttlMs: () => 60_000, file });
    expect(again.status(owner, "req-disk-1")).toMatchObject({
      state: "done",
      result: { ok: true, saved: "yes" },
    });
    expect(again.status(owner, "req-disk-2")).toEqual({ state: "unknown" });
    // A repeat after the restart replays, never runs again.
    expect(again.begin(owner, "req-disk-1").kind).toBe("wait");
  });

  it("drops what is older than the keep time when it loads", () => {
    const file = fileFor();
    let t = 1_000_000;
    const l = createRequestLedger({ ttlMs: () => 5_000, file, now: () => t });
    const a = l.begin(owner, "req-old-01");
    if (a.kind !== "new") throw new Error("kind");
    a.finish(json({ ok: true }));
    t += 6_000;
    const later = createRequestLedger({
      ttlMs: () => 5_000,
      file,
      now: () => t,
    });
    expect(later.status(owner, "req-old-01")).toEqual({ state: "unknown" });
  });

  it("its limits are settings: entries and answer size", () => {
    let max = 1;
    const l = createRequestLedger({
      ttlMs: () => 60_000,
      maxEntries: () => max,
      maxAnswerBytes: () => 64,
    });
    for (const id of ["req-lim-01", "req-lim-02"]) {
      const b = l.begin(owner, id);
      if (b.kind === "new") b.finish(json({ ok: true, pad: "x".repeat(100) }));
    }
    expect(l.status(owner, "req-lim-01").state).toBe("unknown");
    // Over the size: it ended well, with no answer kept.
    expect(l.status(owner, "req-lim-02")).toMatchObject({ state: "done" });
    expect(l.status(owner, "req-lim-02")).not.toHaveProperty("result");
    max = 5;
    const c = l.begin(owner, "req-lim-03");
    if (c.kind === "new") c.finish(json({ ok: true }));
    expect(l.status(owner, "req-lim-02").state).toBe("done");
  });

  it("replaces any field named token, secret, code or password before it keeps the answer", () => {
    const file = fileFor();
    const l = createRequestLedger({ ttlMs: () => 60_000, file });
    const a = l.begin(owner, "req-red-01");
    if (a.kind !== "new") throw new Error("kind");
    a.finish(
      json({
        ok: true,
        token: "tok-SEEKRIT-1",
        nested: { password: "pw-SEEKRIT-2", Code: "SEEKRIT-3" },
        list: [{ client_secret: "SEEKRIT-4", name: "kept" }],
      }),
    );
    const text = fs.readFileSync(file, "utf-8");
    expect(text).not.toMatch(/SEEKRIT/);
    expect(l.status(owner, "req-red-01")).toMatchObject({
      result: {
        ok: true,
        token: "[redacted]",
        nested: { password: "[redacted]", Code: "[redacted]" },
        list: [{ client_secret: "[redacted]", name: "kept" }],
      },
    });
  });

  it("names the sign-in, sign-out, link and token routes", () => {
    for (const p of [
      "/auth",
      "/signin",
      "/attest",
      "/api/session/logout",
      "/api/web/logout",
      "/api/signin/code",
      "/api/signin/code/abc",
      "/api/github/signin",
      "/api/web/owner/link",
      "/api/web/pair",
      "/api/hub/token",
      "/api/hub/link",
      "/api/sudo-password",
      "/api/web/sessions/revoke-all",
    ])
      expect([p, secretRoute(p)]).toEqual([p, true]);
    for (const p of ["/api/settings", "/api/workspaces/north/agents"])
      expect([p, secretRoute(p)]).toEqual([p, false]);
  });

  it("a sign-in answer never reaches the file: only its state and code", async () => {
    const file = fileFor();
    const l = createRequestLedger({ ttlMs: () => 60_000, file });
    await through(l, "/api/signin/code", "req-sign-01", (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          session: "SESS-SEEKRIT",
          pin: "SEEKRIT-PIN",
        }),
      );
    });
    await through(l, "/api/signin/code/xyz", "req-sign-02", (res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "SEEKRIT wrong pin" }));
    });
    const text = fs.readFileSync(file, "utf-8");
    expect(text).not.toMatch(/SEEKRIT/);
    expect(l.status(owner, "req-sign-01")).toEqual({
      state: "done",
      finishedAt: expect.any(String),
    });
    expect(l.status(owner, "req-sign-02")).toEqual({
      state: "failed",
      error: { code: 403, message: "" },
      finishedAt: expect.any(String),
    });
    // Try again on it still runs once, and says how it ended.
    const replay = await through(l, "/api/signin/code", "req-sign-01", () => {
      throw new Error("ran twice");
    });
    expect(replay.statusCode).toBe(200);
    expect(Buffer.concat(replay.out).toString()).not.toMatch(/SEEKRIT/);
  });

  it("logs req=<id>, the action and the outcome, never the body", async () => {
    const lines: string[] = [];
    const l = createRequestLedger({
      ttlMs: () => 60_000,
      log: (line) => lines.push(line),
    });
    await through(l, "/api/settings?x=1", "req-log-001", (res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, note: "BODY-TEXT" }));
    });
    expect(lines).toEqual(["req=req-log-001 POST /api/settings 200"]);
  });
});
