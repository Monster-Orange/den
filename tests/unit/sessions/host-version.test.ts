/**
 * Issue 500: the terminal host reports its version; after a verified
 * update an idle host on an older version is replaced on the new one, a
 * host with a live shell is never killed and the page and doctor say it
 * runs an older version; a host that doesn't answer gives doctor ✗ (the
 * reason and its version) and an error on Terminal, never a silent click.
 *
 * Real hosts (SessionHost over its unix socket, a scripted PTY) and one
 * stub that never answers, each in a temp state dir, all stopped in
 * afterEach: no host outlives this file (issue 501).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  connectHost,
  HostError,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { SessionHost } from "../../../src/shared/sessions/host.js";
import { checkHost } from "../../../src/shared/sessions/host-check.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { refreshHostAfterUpdate } from "../../../src/ui/server/host-refresh.js";
import { updateStateFile } from "../../../src/ui/server/den-update.js";
import { handleSessionList } from "../../../src/ui/server/session-routes.js";
import { hostLines } from "../../../src/ui/cli/doctor-command.js";
import { hostNote } from "../../../src/ui/server/public/host-note.js";
import { scriptedFactory } from "./helpers/fake-pty.js";

const tmps: string[] = [];
const hosts: SessionHost[] = [];
const clients: HostClient[] = [];
const stubs: net.Server[] = [];
const stubConns: net.Socket[] = [];

function stateDir(): string {
  // Short: a unix socket path has a ~104-byte limit.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-hv-"));
  tmps.push(d);
  return d;
}

async function host(dir: string, version: string): Promise<SessionHost> {
  const { factory } = scriptedFactory();
  const h = new SessionHost({
    stateDir: dir,
    pty: () => ({ available: true, factory }),
    launchdSession: null,
    flushMs: 0,
    log: () => undefined,
    version,
  });
  hosts.push(h);
  expect(await h.listen()).toBe("listening");
  return h;
}

async function client(dir: string): Promise<HostClient> {
  const c = await connectHost(sessionPaths(dir).socket);
  clients.push(c);
  return c;
}

/** A host that takes connections and never answers anything. */
async function stuckStub(dir: string, version: string): Promise<void> {
  const p = sessionPaths(dir);
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  const s = net.createServer((conn) => {
    stubConns.push(conn);
    conn.on("error", () => undefined);
  });
  stubs.push(s);
  await new Promise<void>((r) => s.listen(p.socket, r));
  // What a host of this version records when it starts listening.
  fs.writeFileSync(
    p.hostFile,
    JSON.stringify({ pid: 4242, version, startedAt: new Date().toISOString() }),
  );
}

const spec = (name: string) => ({
  name,
  cwd: os.tmpdir(),
  argv: ["sh", "-c", "sleep 30"],
  env: { PATH: "/usr/bin:/bin" },
  cols: 80,
  rows: 24,
});

function recordUpdate(dir: string, from: string, to: string): void {
  const f = updateStateFile(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(
    f,
    JSON.stringify({ state: "good", from, to, at: new Date().toISOString() }),
  );
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of hosts.splice(0)) await h.close();
  for (const c of stubConns.splice(0)) c.destroy();
  for (const s of stubs.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("the host reports its version (clause 1)", () => {
  it("hello says the package version it was started from", async () => {
    const dir = stateDir();
    await host(dir, "0.4.66");
    const c = await client(dir);
    expect(c.hostVersion).toBe("0.4.66");
    const r = await checkHost({ socket: sessionPaths(dir).socket, timeoutMs: 2000 });
    expect(r).toMatchObject({ state: "ok", version: "0.4.66", live: 0 });
  });
});

describe("after a verified update (clause 2)", () => {
  it("an idle host on an older version is replaced on the new version", async () => {
    const dir = stateDir();
    const old = await host(dir, "0.4.66");
    recordUpdate(dir, "0.4.66", "0.4.68");
    const socket = sessionPaths(dir).socket;
    const r = await refreshHostAfterUpdate({
      stateDir: dir,
      denVersion: "0.4.68",
      socket,
      timeoutMs: 2000,
      // What the server does: the old host goes, a host of this version
      // starts (the launchd job, or spawned).
      start: async () => {
        await host(dir, "0.4.68");
      },
      log: () => undefined,
    });
    expect(r).toBe("replaced");
    void old;
    const c = await client(dir);
    expect(c.hostVersion).toBe("0.4.68");
  });

  it("is not replaced without a verified update to this version", async () => {
    const dir = stateDir();
    await host(dir, "0.4.66");
    let started = 0;
    const r = await refreshHostAfterUpdate({
      stateDir: dir,
      denVersion: "0.4.68",
      socket: sessionPaths(dir).socket,
      timeoutMs: 2000,
      start: async () => {
        started++;
      },
      log: () => undefined,
    });
    expect(r).toBe("not-updated");
    expect(started).toBe(0);
    expect((await client(dir)).hostVersion).toBe("0.4.66");
  });

  it("a host with a live shell stays, and the page and doctor say it runs an older version", async () => {
    const dir = stateDir();
    await host(dir, "0.4.66");
    const c = await client(dir);
    await c.start(spec("acme-north:shell-1"));
    recordUpdate(dir, "0.4.66", "0.4.68");
    let started = 0;
    const socket = sessionPaths(dir).socket;
    const r = await refreshHostAfterUpdate({
      stateDir: dir,
      denVersion: "0.4.68",
      socket,
      timeoutMs: 2000,
      start: async () => {
        started++;
      },
      log: () => undefined,
    });
    expect(r).toBe("busy");
    expect(started).toBe(0);
    // Still the same host, its shell still running.
    const listed = await c.list();
    expect(listed.filter((s) => !s.exited)).toHaveLength(1);

    const check = await checkHost({ socket, timeoutMs: 2000 });
    const doc = hostLines(check, "0.4.68", "Acme", "acme");
    expect(doc.problem).toBe(false);
    expect(doc.check.status).toBe("warn");
    expect(doc.lines.join("\n")).toContain(
      "The terminal host runs an older version (v0.4.66, Den is v0.4.68). Restart it when you're done.",
    );

    const body = await getList(dir);
    expect(body.hostVersion).toEqual({ host: "0.4.66", den: "0.4.68", older: true });
    expect(hostNote(body)).toEqual({
      kind: "older",
      vars: { host: "v0.4.66", den: "v0.4.68" },
    });
  });
});

describe("a host that doesn't answer (clause 3)", () => {
  it("connecting fails after the timeout instead of waiting for good", async () => {
    const dir = stateDir();
    await stuckStub(dir, "0.4.66");
    const t0 = Date.now();
    const err = await connectHost(sessionPaths(dir).socket, {
      timeoutMs: 300,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).code).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("doctor gives ✗ with the reason and the host's version", async () => {
    const dir = stateDir();
    await stuckStub(dir, "0.4.66");
    const check = await checkHost({
      socket: sessionPaths(dir).socket,
      hostFile: sessionPaths(dir).hostFile,
      timeoutMs: 300,
    });
    expect(check).toMatchObject({ state: "stuck", version: "0.4.66" });
    const doc = hostLines(check, "0.4.68", "Acme", "acme");
    expect(doc.problem).toBe(true);
    expect(doc.check.status).toBe("fail");
    const text = doc.lines.join("\n");
    expect(text).toContain("✗");
    expect(text).toMatch(/did not answer within 0\.3 s/);
    expect(text).toContain("v0.4.66");
  });

  it("Terminal gets an error from the list in time, and the page shows it", async () => {
    const dir = stateDir();
    await stuckStub(dir, "0.4.66");
    const t0 = Date.now();
    const body = await getList(dir, 0.3);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(body.hostError).toMatch(/did not answer within 0\.3 s/);
    expect(body.hostStuck).toMatchObject({ version: "0.4.66" });
    expect(hostNote(body)).toMatchObject({
      kind: "stuck",
      vars: { host: "v0.4.66" },
    });
  });

  it("a host whose last start failed says so, and doctor gives ✗", async () => {
    const dir = stateDir();
    const h = new SessionHost({
      stateDir: dir,
      pty: () => ({ available: false, reason: "no PTY module here" }),
      launchdSession: null,
      flushMs: 0,
      log: () => undefined,
      version: "0.4.68",
    });
    hosts.push(h);
    await h.listen();
    const c = await client(dir);
    await expect(c.start(spec("acme-north:shell-1"))).rejects.toThrow();
    const check = await checkHost({
      socket: sessionPaths(dir).socket,
      timeoutMs: 2000,
    });
    expect(check.state).toBe("failing");
    const doc = hostLines(check, "0.4.68", "Acme", "acme");
    expect(doc.problem).toBe(true);
    expect(doc.lines.join("\n")).toMatch(/✗.*no PTY module here/);
  });
});

/** GET /api/sessions on the default wiring (no connect given). */
async function getList(
  dir: string,
  hostWaitS = 2,
): Promise<Record<string, unknown>> {
  const server = http.createServer((req, res) => {
    void handleSessionList(req, res, "/api/sessions", true, {
      stateDir: () => dir,
      dist: () => "acme",
      activeWorkspaces: () => [],
      workspaceExists: () => false,
      hubNow: async () => null,
      repoNames: () => null,
      denVersion: () => "0.4.68",
      pty: () => ({ available: false, reason: "test" }),
      listWaits: () => ({
        host_timeout_seconds: hostWaitS,
        refresh_timeout_seconds: 15,
      }),
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    return await new Promise<Record<string, unknown>>((ok, bad) => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/api/sessions", timeout: 5000 },
        (res) => {
          let s = "";
          res.on("data", (d) => (s += d));
          res.on("end", () => ok(JSON.parse(s) as Record<string, unknown>));
        },
      );
      req.on("timeout", () => {
        req.destroy();
        bad(new Error("GET /api/sessions waited for the host"));
      });
      req.on("error", bad);
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
