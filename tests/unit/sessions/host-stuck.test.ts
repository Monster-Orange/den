/**
 * Issue 500: a terminal host that doesn't answer says so, and a person can
 * restart it.
 *
 * - A hello waits at most sessions.host_answer_timeout_seconds, then fails
 *   "timeout" (before: it waited as long as the connection lasted, so
 *   Terminal's click and doctor waited for good, or said nothing).
 * - doctor's Host row is ✗ with the reason and the version the host wrote
 *   to sessions.host.json as it began to serve.
 * - Restart ends a stuck host by signal, only the process its
 *   sessions.host.json names, and a new host starts.
 *
 * The stuck host is a stand-in process of this test's own
 * (helpers/stuck-sessions-host.mjs) on a socket in a temp dir; the new
 * host is a real one (helpers/module-host.ts). Nothing else is signalled.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  connectHost,
  ensureHost,
  HostError,
  noHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { SessionHost } from "../../../src/shared/sessions/host.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  readHostInfo,
  restartHost,
  stopAnyHost,
} from "../../../src/shared/sessions/host-stuck.js";
import {
  defaultHostModuleDeps,
  hostModuleLines,
} from "../../../src/ui/cli/doctor-ptys.js";
import { pipePtyFactory } from "./helpers/fake-pty.js";

const ENGINE = path.resolve(__dirname, "../../..");
const LOADER = path.join(ENGINE, "node_modules/tsx/dist/loader.mjs");
const REAL = path.join(__dirname, "helpers", "module-host.ts");
const STUCK = path.join(__dirname, "helpers", "stuck-sessions-host.mjs");

let tmp = "";
const children: ChildProcess[] = [];
const servers: net.Server[] = [];
const hosts: SessionHost[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  if (tmp)
    try {
      const c = await connectHost(sessionPaths(path.join(tmp, "state")).socket, {
        timeoutMs: 500,
      });
      await c.shutdown();
      c.close();
    } catch {
      /* none, or the stuck one */
    }
  for (const s of servers.splice(0)) s.close();
  for (const ch of children.splice(0))
    try {
      // Only this test's own children (each in its own group).
      if (ch.pid && ch.exitCode === null) process.kill(-ch.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function setup(): { state: string; socket: string; info: string } {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-hs-")));
  const state = path.join(tmp, "state");
  fs.mkdirSync(state, { recursive: true });
  const p = sessionPaths(state);
  return { state, socket: p.socket, info: p.info };
}

/** The stuck stand-in, listening; resolves with its pid. */
async function startStuck(
  socket: string,
  info: string,
  den = "0.4.70",
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [STUCK, socket, info, den], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  children.push(child);
  await new Promise<void>((res, rej) => {
    child.stdout!.once("data", () => res());
    child.once("exit", (c) => rej(new Error(`stand-in exited ${c}`)));
  });
  return child;
}

function startReal(state: string): void {
  const child = spawn(
    process.execPath,
    ["--import", `file://${LOADER}`, REAL, state],
    { cwd: tmp, stdio: "ignore", detached: true, env: { ...process.env } },
  );
  child.unref();
  children.push(child);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** connectExisting as the server's: null when none runs, else it throws. */
const existing =
  (socket: string, timeoutMs = 400) =>
  async (): Promise<HostClient | null> => {
    try {
      return await connectHost(socket, { timeoutMs });
    } catch (e) {
      if (noHost(e)) return null;
      throw e;
    }
  };

describe("issue 500: a hello waits at most the host-answer timeout", () => {
  it("a host that holds its socket and answers nothing fails 'timeout' in time", async () => {
    const { socket } = setup();
    const server = net.createServer(() => undefined); // answers nothing
    servers.push(server);
    await new Promise<void>((r) => server.listen(socket, r));
    const t0 = Date.now();
    const err = await connectHost(socket, { timeoutMs: 300 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HostError);
    expect((err as HostError).code).toBe("timeout");
    expect((err as HostError).message).toMatch(/did not answer within 0.3 s/);
    expect(Date.now() - t0).toBeLessThan(3000);
  }, 10_000);
});

describe("issue 500: the host writes sessions.host.json as it serves", () => {
  it("its pid, start and version; gone when it closes", async () => {
    const { state, info } = setup();
    const h = new SessionHost({
      stateDir: state,
      pty: () => ({ available: true, factory: pipePtyFactory }),
      denVersion: "9.9.9",
      codeId: "sha256:abc",
      log: () => undefined,
    });
    hosts.push(h);
    expect(await h.listen()).toBe("listening");
    expect(readHostInfo(info)).toMatchObject({
      pid: process.pid,
      den: "9.9.9",
      code: "sha256:abc",
    });
    expect(Date.parse(readHostInfo(info)!.startedAt)).toBeGreaterThan(0);
    await h.close();
    expect(fs.existsSync(info)).toBe(false);
  });
});

describe("issue 500: doctor says when the host doesn't answer", () => {
  it("✗ with the reason and the host's version (a stub that never answers)", async () => {
    const { state, socket, info } = setup();
    await startStuck(socket, info, "0.4.70");
    const hm = await hostModuleLines("den", defaultHostModuleDeps(state, 300));
    expect(hm.problem).toBe(true);
    expect(hm.check.status).toBe("fail");
    expect(hm.lines[0]).toMatch(/Host {2}✗/);
    expect(hm.check.detail).toMatch(/doesn't answer/);
    expect(hm.check.detail).toMatch(/did not answer within 0.3 s/);
    expect(hm.check.detail).toMatch(/version 0\.4\.70/);
    expect(hm.check).toMatchObject({
      stuck: true,
      host: { den: "0.4.70" },
    });
    expect(hm.check.fix).toMatch(/sessions host --stop/);
  }, 15_000);

  it("no host running is still fine (✓)", async () => {
    const { state } = setup();
    const hm = await hostModuleLines("den", defaultHostModuleDeps(state, 300));
    expect(hm.problem).toBe(false);
    expect(hm.check.stuck).toBeUndefined();
  });
});

describe("issue 500: Restart ends a stuck host and starts a new one", () => {
  it("by signal, only the process sessions.host.json names; the new host answers", async () => {
    const { state, socket, info } = setup();
    const stuck = await startStuck(socket, info);
    const r = await restartHost({
      socket,
      infoFile: info,
      connectExisting: existing(socket),
      connect: () =>
        ensureHost({ socket, spawnHost: () => startReal(state) }),
      termWaitMs: 2000,
    });
    expect(r.forced).toBe(true);
    expect(r.from).toBe(stuck.pid);
    expect(r.fromVersion).toBe("0.4.70");
    expect(r.ended).toBeNull();
    expect(alive(stuck.pid!)).toBe(false);
    expect(r.to).toBeGreaterThan(0);
    expect(r.to).not.toBe(stuck.pid);
    const c = await connectHost(socket, { timeoutMs: 5000 });
    expect(c.hostPid).toBe(r.to);
    c.close();
  }, 40_000);

  it("refuses when sessions.host.json names a process that isn't a terminal host; it stays running", async () => {
    const { socket, info } = setup();
    const server = net.createServer(() => undefined); // answers nothing
    servers.push(server);
    await new Promise<void>((res) => server.listen(socket, res));
    const other = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      detached: true,
    });
    children.push(other);
    await new Promise((res) => setTimeout(res, 200));
    fs.writeFileSync(
      info,
      JSON.stringify({
        pid: other.pid,
        startedAt: new Date().toISOString(),
        den: "0.4.70",
        code: null,
      }),
    );
    await expect(
      stopAnyHost({ socket, infoFile: info, connectExisting: existing(socket) }),
    ).rejects.toThrow(/is not that host any more/);
    expect(alive(other.pid!)).toBe(true);
  }, 15_000);

  it("never signals this process", async () => {
    const { socket, info } = setup();
    const server = net.createServer(() => undefined);
    servers.push(server);
    await new Promise<void>((res) => server.listen(socket, res));
    fs.writeFileSync(
      info,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(0).toISOString(),
        den: null,
        code: null,
      }),
    );
    await expect(
      stopAnyHost({ socket, infoFile: info, connectExisting: existing(socket) }),
    ).rejects.toThrow(/is not that host any more/);
  }, 10_000);

  it("a host that answers is stopped the supported way (no signal)", async () => {
    const { state, socket, info } = setup();
    startReal(state);
    const first = await ensureHost({ socket, spawnHost: () => undefined });
    const pid = first.hostPid;
    first.close();
    const sent: string[] = [];
    const r = await restartHost({
      socket,
      infoFile: info,
      connectExisting: existing(socket, 5000),
      connect: () =>
        ensureHost({ socket, spawnHost: () => startReal(state) }),
      kill: (_p, sig) => void sent.push(sig),
    });
    expect(r).toMatchObject({ forced: false, from: pid, ended: 0 });
    expect(sent).toEqual([]);
    expect(r.to).not.toBe(pid);
  }, 40_000);
});
