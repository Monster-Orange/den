/**
 * The session host (AG-3a), in process, over its real unix socket, with a
 * scripted PTY behind the factory seam: start, list, attach fan-out,
 * scrollback replay, write/resize/signal, the concurrency cap, the stale
 * socket, idempotent start, history across a host restart, and the
 * protocol version check.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  connectHost,
  HostError,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import {
  hasFullDiskAccess,
  SessionHost,
} from "../../../src/shared/sessions/host.js";
import { PROTOCOL_VERSION } from "../../../src/shared/sessions/protocol.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { PtyLoad } from "../../../src/shared/sessions/pty.js";
import { scriptedFactory, type ScriptedPty } from "./helpers/fake-pty.js";

const tmps: string[] = [];
const hosts: SessionHost[] = [];
const clients: HostClient[] = [];

function stateDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-host-"));
  tmps.push(d);
  return d;
}

async function host(
  dir: string,
  pty?: () => PtyLoad,
  launchd?: string | null,
): Promise<{ host: SessionHost; made: ScriptedPty[] }> {
  const { factory, made } = scriptedFactory();
  const h = new SessionHost({
    stateDir: dir,
    pty: pty ?? (() => ({ available: true, factory })),
    ...(launchd !== undefined ? { launchdSession: launchd } : {}),
    flushMs: 0,
    log: () => undefined,
  });
  hosts.push(h);
  expect(await h.listen()).toBe("listening");
  return { host: h, made };
}

async function client(dir: string): Promise<HostClient> {
  const c = await connectHost(sessionPaths(dir).socket);
  clients.push(c);
  return c;
}

const spec = (name: string) => ({
  name,
  cwd: os.tmpdir(),
  argv: ["sh", "-c", "true"],
  env: { PATH: "/usr/bin:/bin" },
  cols: 80,
  rows: 24,
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await tick(10);
  }
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of hosts.splice(0)) await h.close();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("session host", () => {
  it("starts a session and lists it with ref, name, pid and startedAt", async () => {
    const dir = stateDir();
    const { made } = await host(dir);
    const c = await client(dir);
    const info = await c.start(spec("acme-north:planner"));
    expect(info).toMatchObject({
      ref: { backend: "den-pty" },
      name: "acme-north:planner",
      pid: made[0].pid,
    });
    expect(Date.parse(info.startedAt)).not.toBeNaN();
    expect(made[0].file).toBe("sh");
    expect(made[0].args).toEqual(["-c", "true"]);
    expect(await c.list()).toEqual([info]);
  });

  it("D20: stamps the launchd session it runs in on hello and on every session, kept across a restart", async () => {
    const dir = stateDir();
    const first = await host(dir, undefined, "Aqua");
    const c = await client(dir);
    expect(c.hostLaunchd).toBe("Aqua");
    const info = await c.start(spec("acme-north:planner"));
    expect(info.launchd).toBe("Aqua");
    expect(await c.list()).toEqual([info]);
    c.close();
    await first.host.close();
    // The record keeps where it ran, after its host is gone.
    await host(dir, undefined, "Background");
    const c2 = await client(dir);
    expect(c2.hostLaunchd).toBe("Background");
    const [old] = await c2.list();
    expect(old).toMatchObject({ exited: true, launchd: "Aqua" });
  });

  it("D20: off macOS, no launchd stamp at all", async () => {
    const dir = stateDir();
    await host(dir, undefined, null);
    const c = await client(dir);
    expect(c.hostLaunchd).toBeNull();
    const info = await c.start(spec("acme-north:planner"));
    expect(info).not.toHaveProperty("launchd");
  });

  it("fans output out to every attachment, across clients", async () => {
    const dir = stateDir();
    const { made } = await host(dir);
    const a = await client(dir);
    const b = await client(dir);
    const { ref } = await a.start(spec("acme-north:planner"));
    const got = { a1: "", a2: "", b: "" };
    const a1 = a.attach(ref.id, { onData: (d) => (got.a1 += d.toString()) });
    const a2 = a.attach(ref.id, { onData: (d) => (got.a2 += d.toString()) });
    const b1 = b.attach(ref.id, { onData: (d) => (got.b += d.toString()) });
    await Promise.all([a1.ready, a2.ready, b1.ready]);
    made[0].emit("hello");
    await until(() => (got.a1 && got.a2 && got.b ? true : false));
    expect(got).toEqual({ a1: "hello", a2: "hello", b: "hello" });
    a2.detach();
    await tick();
    made[0].emit(" again");
    await until(() => got.b === "hello again");
    expect(got.a1).toBe("hello again");
    expect(got.a2).toBe("hello");
  });

  it("replays scrollback on attach, then streams live output", async () => {
    const dir = stateDir();
    const { made } = await host(dir);
    const c = await client(dir);
    const { ref } = await c.start(spec("acme-north:planner"));
    made[0].emit("before\n");
    await tick();
    let seen = "";
    const att = c.attach(ref.id, { onData: (d) => (seen += d.toString()) });
    await att.ready;
    made[0].emit("after\n");
    await until(() => seen === "before\nafter\n");
    expect((await c.scrollback(ref.id, 7)).toString()).toBe("\nafter\n");
  });

  it("NT-1: a bell in the output stamps bellAt on the session; plain output doesn't", async () => {
    const dir = stateDir();
    const { made } = await host(dir);
    const c = await client(dir);
    await c.start(spec("acme-north:planner"));
    made[0].emit("working\n\u001b]0;title\u0007");
    await tick();
    expect((await c.list())[0].bellAt).toBeUndefined();
    made[0].emit("your turn\u0007");
    await tick();
    expect(Date.parse((await c.list())[0].bellAt ?? "")).not.toBeNaN();
  });

  it("passes write, resize and signal to the PTY, and reports the exit", async () => {
    const dir = stateDir();
    const { made } = await host(dir);
    const c = await client(dir);
    const { ref } = await c.start(spec("acme-north:planner"));
    let exit: number | undefined;
    const att = c.attach(ref.id, {
      onData: () => undefined,
      onExit: (code) => (exit = code),
    });
    await att.ready;
    c.write(ref.id, Buffer.from("ls\r"));
    c.resize(ref.id, 120, 40);
    c.signal(ref.id, "INT");
    await until(() => made[0].signals.length > 0);
    expect(Buffer.concat(made[0].writes).toString()).toBe("ls\r");
    expect(made[0].resizes).toEqual([[120, 40]]);
    expect(made[0].signals).toEqual(["SIGINT"]);
    made[0].exit(3);
    await until(() => exit !== undefined);
    expect(exit).toBe(3);
    expect(await c.list()).toEqual([
      expect.objectContaining({ exited: true, exitCode: 3 }),
    ]);
  });

  it("tells an attachment that asks the PTY's size on attach and each change; one that doesn't ask gets no size event", async () => {
    const dir = stateDir();
    await host(dir);
    const a = await client(dir);
    const b = await client(dir);
    const { ref } = await a.start(spec("acme-north:planner"));
    const sizesA: Array<[number, number]> = [];
    const sizesB: Array<[number, number]> = [];
    await a.attach(ref.id, {
      onData: () => undefined,
      onSize: (c, r) => sizesA.push([c, r]),
    }).ready;
    // The start's size, on attach.
    expect(sizesA).toEqual([[80, 24]]);
    await b.attach(ref.id, {
      onData: () => undefined,
      onSize: (c, r) => sizesB.push([c, r]),
    }).ready;
    // An older client (no `sizes`): an unknown event would read as the
    // session's exit, so it never gets one.
    const raw = net.connect(sessionPaths(dir).socket);
    const lines: string[] = [];
    raw.on("data", (d) => lines.push(...d.toString().split("\n")));
    await new Promise((r) => raw.once("connect", r));
    raw.write(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        id: 1,
        op: "attach",
        ref: ref.id,
        aid: "old.1",
      }) + "\n",
    );
    await until(() => lines.some((l) => l.includes('"id":1')));
    // b resizes: both hear it; the same size again says nothing.
    b.resize(ref.id, 132, 41);
    await until(() => sizesA.length === 2 && sizesB.length === 2);
    expect(sizesA.at(-1)).toEqual([132, 41]);
    expect(sizesB.at(-1)).toEqual([132, 41]);
    a.resize(ref.id, 132, 41);
    a.resize(ref.id, 90, 30);
    await until(() => sizesB.length === 3);
    expect(sizesB).toEqual([
      [80, 24],
      [132, 41],
      [90, 30],
    ]);
    expect(lines.filter((l) => l.includes('"size"'))).toEqual([]);
    raw.destroy();
  });

  it("refuses a second running session of the same name", async () => {
    const dir = stateDir();
    await host(dir);
    const c = await client(dir);
    await c.start(spec("acme-north:planner"));
    await expect(c.start(spec("acme-north:planner"))).rejects.toMatchObject({
      code: "exists",
    });
  });

  it("enforces the concurrency cap on running sessions", async () => {
    const dir = stateDir();
    const { made } = await host(dir);
    const c = await client(dir);
    await c.start(spec("acme-north:a"), { limit: 2 });
    await c.start(spec("acme-north:b"), { limit: 2 });
    const refused = c.start(spec("acme-north:c"), { limit: 2 });
    await expect(refused).rejects.toBeInstanceOf(HostError);
    await expect(refused).rejects.toMatchObject({ code: "cap" });
    await expect(refused).rejects.toThrow(/agents\.max_concurrent.*2/);
    made[0].exit(0);
    await tick(150);
    await expect(
      c.start(spec("acme-north:c"), { limit: 2 }),
    ).resolves.toMatchObject({
      name: "acme-north:c",
    });
  });

  it("counts each pool's own running sessions: agents and plain sessions never block each other", async () => {
    const dir = stateDir();
    await host(dir);
    const c = await client(dir);
    const agents = { limit: 1, pool: "agents" as const };
    const plain = { limit: 1, pool: "sessions" as const };
    await c.start(spec("acme-north:scout"), agents);
    await expect(c.start(spec("acme-north:sh"), plain)).resolves.toMatchObject({
      name: "acme-north:sh",
    });
    await expect(c.start(spec("acme-north:b"), agents)).rejects.toThrow(
      /^1 agent is running and agents\.max_concurrent is 1$/,
    );
    await expect(c.start(spec("acme-north:c"), plain)).rejects.toThrow(
      /^1 session is running and sessions\.max_concurrent is 1$/,
    );
    // A limit with no pool (an older client) still counts every session.
    await expect(
      c.start(spec("acme-north:d"), { limit: 2 }),
    ).rejects.toMatchObject({ code: "cap" });
  });

  it("says why when the PTY module is unavailable", async () => {
    const dir = stateDir();
    await host(dir, () => ({
      available: false,
      reason: "@lydell/node-pty is not installed",
    }));
    const c = await client(dir);
    await expect(c.start(spec("acme-north:a"))).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/not installed/),
    });
  });
});

describe("the socket", () => {
  it("is owner-only (0600)", async () => {
    const dir = stateDir();
    await host(dir);
    expect(fs.statSync(sessionPaths(dir).socket).mode & 0o777).toBe(0o600);
  });

  it("replaces a stale socket left by a host that died", async () => {
    const dir = stateDir();
    const sock = sessionPaths(dir).socket;
    // A listener killed with SIGKILL leaves its socket file behind.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("net").createServer().listen(${JSON.stringify(sock)}, () => console.log("up"))`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((r) => child.stdout.once("data", () => r()));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(fs.existsSync(sock)).toBe(true);
    await expect(
      new Promise((resolve, reject) =>
        net.connect(sock).once("connect", resolve).once("error", reject),
      ),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });

    await host(dir);
    const c = await client(dir);
    expect(c.hostPid).toBe(process.pid);
  });

  it("a second host on the same state dir finds the first and stands down", async () => {
    const dir = stateDir();
    await host(dir);
    const second = new SessionHost({
      stateDir: dir,
      pty: () => ({ available: false, reason: "unused" }),
      log: () => undefined,
    });
    hosts.push(second);
    expect(await second.listen()).toBe("already-running");
    expect((await client(dir)).hostPid).toBe(process.pid);
  });

  it("refuses a client that speaks another protocol version", async () => {
    const dir = stateDir();
    await host(dir);
    const reply = await new Promise<string>((resolve, reject) => {
      const s = net.connect(sessionPaths(dir).socket);
      s.once("error", reject);
      s.on("data", (d) => {
        resolve(d.toString());
        s.destroy();
      });
      s.write(
        JSON.stringify({ v: PROTOCOL_VERSION + 98, id: 1, op: "hello" }) + "\n",
      );
    });
    expect(JSON.parse(reply)).toMatchObject({
      id: 1,
      ok: false,
      code: "protocol",
    });
  });
});

describe("a host restart", () => {
  it("keeps the session's history: listed as exited, scrollback replays", async () => {
    const dir = stateDir();
    const first = await host(dir);
    let c = await client(dir);
    const { ref } = await c.start(spec("acme-north:planner"));
    first.made[0].emit("history line\n");
    await tick();
    c.close();
    await first.host.close();

    await host(dir);
    c = await client(dir);
    const [listed] = await c.list();
    expect(listed).toMatchObject({
      ref,
      name: "acme-north:planner",
      exited: true,
    });
    let seen = "";
    let exited = false;
    const att = c.attach(ref.id, {
      onData: (d) => (seen += d.toString()),
      onExit: () => (exited = true),
    });
    await att.ready;
    await until(() => exited);
    expect(seen).toBe("history line\n");
  });

  it("forget removes an exited session and its files", async () => {
    const dir = stateDir();
    const { made } = await host(dir);
    const c = await client(dir);
    const { ref } = await c.start(spec("acme-north:planner"));
    made[0].emit("x");
    made[0].exit(0);
    await tick(150);
    await c.forget(ref.id);
    expect(await c.list()).toEqual([]);
    expect(fs.readdirSync(sessionPaths(dir).dir)).toEqual([]);
  });
});

describe("D18: Full Disk Access, as the host has it", () => {
  it("the access op names the host's executable and whether it has it", async () => {
    const dir = stateDir();
    const { factory } = scriptedFactory();
    const h = new SessionHost({
      stateDir: dir,
      pty: () => ({ available: true, factory }),
      flushMs: 0,
      log: () => undefined,
      fullDiskAccess: () => false,
    });
    hosts.push(h);
    await h.listen();
    const c = await client(dir);
    expect(await c.access()).toEqual({
      exe: process.execPath,
      fullDiskAccess: false,
    });
  });

  it("hasFullDiskAccess: listing the TCC folder is the grant", () => {
    const home = stateDir();
    const tcc = path.join(
      home,
      "Library",
      "Application Support",
      "com.apple.TCC",
    );
    // No folder: cannot tell.
    expect(hasFullDiskAccess(home, "darwin")).toBeNull();
    fs.mkdirSync(tcc, { recursive: true });
    expect(hasFullDiskAccess(home, "darwin")).toBe(true);
    fs.chmodSync(tcc, 0o000);
    try {
      expect(hasFullDiskAccess(home, "darwin")).toBe(false);
    } finally {
      fs.chmodSync(tcc, 0o700);
    }
    expect(hasFullDiskAccess(home, "linux")).toBeNull();
  });
});

describe("D18: the launchd job's host stands by", () => {
  it("while another host answers it waits, then serves once that one ends", async () => {
    const dir = stateDir();
    const first = await host(dir);
    const { factory } = scriptedFactory();
    const second = new SessionHost({
      stateDir: dir,
      pty: () => ({ available: true, factory }),
      flushMs: 0,
      log: () => undefined,
    });
    hosts.push(second);
    let served = false;
    const waiting = second.listenWhenFree(20).then((v) => {
      served = true;
      return v;
    });
    await tick(120);
    expect(served).toBe(false);
    await first.host.close();
    expect(await waiting).toBe("listening");
    const c = await client(dir);
    expect(await c.list()).toEqual([]);
  });
});

describe("a host whose state dir is gone", () => {
  it("is told, so it ends (a test's temp dir no longer leaves one running)", async () => {
    const dir = stateDir();
    const { host: h } = await host(dir);
    let gone = 0;
    h.watchStateDir(20, () => gone++);
    await tick(80);
    expect(gone).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
    await until(() => gone === 1);
    await tick(80);
    expect(gone).toBe(1);
  });
});
