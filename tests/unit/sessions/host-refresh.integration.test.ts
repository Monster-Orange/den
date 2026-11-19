/**
 * Issue 563: a terminal host that outlived an update restarts on the
 * installed version, through the stop `sessions host --stop` uses. Real
 * host processes (pipes behind the PTY seam), in a temp state dir; the
 * service manager that brings a stopped host back is a stand-in that
 * starts a new one (ensureHost's spawnHost seam). Never launchctl.
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
  noHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import {
  HOST_RESTART_NOTE,
  hostStale,
  refreshSessionHost,
  type RefreshDeps,
} from "../../../src/shared/sessions/host-refresh.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  fileIdentity,
  installedPtyModule,
  type PtyModuleInfo,
} from "../../../src/shared/sessions/pty.js";
import { frame, LineReader } from "../../../src/shared/sessions/protocol.js";
import { hostModuleLines } from "../../../src/ui/cli/doctor-ptys.js";

const ENGINE = path.resolve(__dirname, "../../..");
const LOADER = path.join(ENGINE, "node_modules/tsx/dist/loader.mjs");
const HELPER = path.join(__dirname, "helpers", "module-host.ts");

let tmp = "";
const children: ChildProcess[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  try {
    const c = await connectHost(sessionPaths(path.join(tmp, "state")).socket);
    await c.shutdown();
    c.close();
  } catch {
    /* none */
  }
  for (const s of servers.splice(0)) s.close();
  for (const ch of children.splice(0))
    try {
      if (ch.pid) process.kill(-ch.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function setup(): { state: string; socket: string } {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-hr-")));
  const state = path.join(tmp, "state");
  fs.mkdirSync(state, { recursive: true });
  return { state, socket: sessionPaths(state).socket };
}

/**
 * A native module as npm lays it out, shaped as the real 1.2.0 betas are:
 * <root>/node_modules/@lydell/node-pty and its platform package holding
 * prebuilds/<platform>-<arch>/pty.node, and neither exports package.json.
 */
function installModule(root: string, version: string): PtyModuleInfo {
  const base = path.join(root, "node_modules", "@lydell");
  const own = path.join(base, "node-pty");
  const plat = path.join(base, `node-pty-${process.platform}-${process.arch}`);
  fs.mkdirSync(own, { recursive: true });
  fs.writeFileSync(
    path.join(own, "package.json"),
    JSON.stringify({
      name: "@lydell/node-pty",
      version,
      exports: { ".": { default: "./index.js" } },
    }),
  );
  fs.writeFileSync(path.join(own, "index.js"), "module.exports = {};\n");
  // npm: the old folder moves aside, the new one comes, the old one goes.
  if (fs.existsSync(plat)) {
    const aside = path.join(
      base,
      `.node-pty-${process.platform}-${process.arch}-x1y2`,
    );
    fs.renameSync(plat, aside);
    fs.rmSync(aside, { recursive: true, force: true });
  }
  fs.mkdirSync(plat, { recursive: true });
  fs.writeFileSync(
    path.join(plat, "package.json"),
    JSON.stringify({
      name: `@lydell/node-pty-${process.platform}-${process.arch}`,
      version,
      exports: "./lib/index.js",
    }),
  );
  const pre = path.join(plat, "prebuilds", `${process.platform}-${process.arch}`);
  fs.mkdirSync(pre, { recursive: true });
  fs.writeFileSync(path.join(pre, "pty.node"), `native ${version}\n`);
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  const info = installedPtyModule(root);
  if (!info) throw new Error("the fake module did not resolve");
  return info;
}

function startHost(
  state: string,
  env: { pty?: PtyModuleInfo | null; den?: string; code?: string },
): void {
  const child = spawn(
    process.execPath,
    ["--import", `file://${LOADER}`, HELPER, state],
    {
      cwd: tmp,
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        ...(env.pty ? { DEN_TEST_PTY: JSON.stringify(env.pty) } : {}),
        ...(env.den !== undefined ? { DEN_TEST_DEN: env.den } : {}),
        ...(env.code !== undefined ? { DEN_TEST_CODE: env.code } : {}),
      },
    },
  );
  child.unref();
  children.push(child);
}

async function connectWithin(socket: string, ms = 20_000): Promise<HostClient> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await connectHost(socket);
    } catch (e) {
      if (!noHost(e) || Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/**
 * A host from before issue 563: its hello says nothing of what it runs.
 * `den`: one from 563 to 597, that says its version but not its code.
 */
function oldHost(socket: string, den?: string): Promise<void> {
  const server = net.createServer((s) => {
    const r = new LineReader((line) => {
      const q = JSON.parse(line) as { id: number; op: string };
      if (q.op === "hello")
        s.write(
          frame({
            id: q.id,
            ok: true,
            v: 1,
            pid: 4242,
            startedAt: "x",
            ...(den !== undefined ? { den, pty: null } : {}),
          }),
        );
      else if (q.op === "list")
        s.write(frame({ id: q.id, ok: true, sessions: [] }));
      else if (q.op === "shutdown") {
        s.write(frame({ id: q.id, ok: true }));
        setImmediate(() => {
          server.close();
          for (const c of conns) c.destroy();
        });
      }
    });
    conns.add(s);
    s.on("data", (c) => r.push(c));
    s.on("error", () => undefined);
  });
  const conns = new Set<net.Socket>();
  servers.push(server);
  return new Promise((res) => server.listen(socket, () => res()));
}

function rig(
  state: string,
  socket: string,
  installed: () => {
    den: string | null;
    code: string | null;
    pty: PtyModuleInfo | null;
  },
  over: Partial<RefreshDeps> = {},
) {
  const resumed: string[] = [];
  const notes: [string, string | null][] = [];
  const logs: string[] = [];
  const deps: RefreshDeps = {
    connectExisting: async () => {
      try {
        return await connectHost(socket);
      } catch (e) {
        if (noHost(e)) return null;
        throw e;
      }
    },
    // The service manager's stand-in: a stopped host comes back, on what
    // is installed now.
    connect: () =>
      ensureHost({
        socket,
        spawnHost: () =>
          startHost(state, {
            pty: installed().pty,
            code: installed().code ?? "",
            den: installed().den ?? "",
          }),
      }),
    socket,
    installed,
    running: async () => ["a1"],
    busy: async () => [],
    waitMs: 60_000,
    pollMs: 50,
    resume: async (id, note) => {
      resumed.push(id);
      notes.push([id, note]);
    },
    log: (l) => void logs.push(l),
    ...over,
  };
  return { deps, resumed, notes, logs };
}

describe("issue 563: the terminal host after an update", () => {
  it("a host holding a module that was deleted restarts on the installed one; its agents resume", async () => {
    const { state, socket } = setup();
    const dist = path.join(tmp, "dist");
    const before = installModule(dist, "1.1.0");
    startHost(state, { pty: before, code: "c1" });
    const c0 = await connectWithin(socket);
    const pid0 = c0.hostPid;
    c0.close();
    // The update: npm swaps the module; the old file is gone.
    const now = installModule(dist, "1.2.0-beta.18");
    expect(fileIdentity(before.path)).not.toBe(before.id);

    const r = rig(state, socket, () => ({ den: null, code: "c1", pty: now }));
    const res = await refreshSessionHost(r.deps);
    expect(res.did).toBe("restarted");
    const c1 = await connectHost(socket);
    expect(c1.hostPid).not.toBe(pid0);
    expect(c1.hostPty).toEqual(now);
    c1.close();
    expect(r.resumed).toEqual(["a1"]);
  }, 60_000);

  it("a host current with what is installed is left alone", async () => {
    const { state, socket } = setup();
    const now = installModule(path.join(tmp, "dist"), "1.1.0");
    startHost(state, { pty: now, den: "9.9.9", code: "c1" });
    const c0 = await connectWithin(socket);
    const pid0 = c0.hostPid;
    c0.close();
    const r = rig(state, socket, () => ({ den: "9.9.9", code: "c1", pty: now }));
    expect((await refreshSessionHost(r.deps)).did).toBe("current");
    const c1 = await connectHost(socket);
    expect(c1.hostPid).toBe(pid0);
    c1.close();
    expect(r.resumed).toEqual([]);
  }, 60_000);

  it("a host whose code changed restarts, after the agents mid-turn are idle", async () => {
    const { state, socket } = setup();
    startHost(state, { den: "1.0.0", code: "c1" });
    (await connectWithin(socket)).close();
    let asks = 0;
    const r = rig(state, socket, () => ({ den: "1.0.1", code: "c2", pty: null }), {
      busy: async () => (++asks < 3 ? ["a1"] : []),
    });
    const res = await refreshSessionHost(r.deps);
    expect(res).toMatchObject({ did: "restarted", busy: [] });
    expect(asks).toBe(3);
  }, 60_000);

  it("agents still mid-turn when sessions.host_restart_wait_seconds runs out: it restarts anyway", async () => {
    const { state, socket } = setup();
    startHost(state, { den: "1.0.0", code: "c1" });
    (await connectWithin(socket)).close();
    const r = rig(state, socket, () => ({ den: "1.0.1", code: "c2", pty: null }), {
      busy: async () => ["a1"],
      waitMs: 300,
    });
    const res = await refreshSessionHost(r.deps);
    expect(res).toMatchObject({ did: "restarted", busy: ["a1"] });
    expect(r.logs.join("\n")).toMatch(/restarting anyway/);
  }, 60_000);

  it("a host too old to say what it runs counts as different, and is restarted", async () => {
    const { state, socket } = setup();
    await oldHost(socket);
    const r = rig(state, socket, () => ({ den: "1.0.1", code: "c1", pty: null }), {
      running: async () => [],
    });
    const res = await refreshSessionHost(r.deps);
    expect(res).toMatchObject({ did: "restarted", from: 4242 });
  }, 60_000);

});

describe("issue 597: the host restarts only when its code or module changed", () => {
  it("two versions with the same host files: the host is kept, and runs the new version", async () => {
    const { state, socket } = setup();
    const now = installModule(path.join(tmp, "dist"), "1.1.0");
    startHost(state, { pty: now, den: "1.0.0", code: "c1" });
    const c0 = await connectWithin(socket);
    const pid0 = c0.hostPid;
    c0.close();
    const r = rig(state, socket, () => ({ den: "1.0.1", code: "c1", pty: now }), {
      busy: async () => ["a1"],
    });
    const res = await refreshSessionHost(r.deps);
    expect(res).toEqual({ did: "kept", from: "1.0.0", to: "1.0.1" });
    const c1 = await connectHost(socket);
    expect(c1.hostPid).toBe(pid0);
    // It records the new version: doctor and the next start see it current.
    expect(c1.hostDen).toBe("1.0.1");
    expect(c1.hostCode).toBe("c1");
    c1.close();
    expect(r.resumed).toEqual([]);
  }, 60_000);

  it("a changed host file restarts it", async () => {
    const { state, socket } = setup();
    startHost(state, { den: "1.0.0", code: "c1" });
    const c0 = await connectWithin(socket);
    const pid0 = c0.hostPid;
    c0.close();
    const r = rig(state, socket, () => ({ den: "1.0.1", code: "c2", pty: null }));
    const res = await refreshSessionHost(r.deps);
    expect(res).toMatchObject({ did: "restarted" });
    expect((res as { why: string }).why).toMatch(/code/);
    const c1 = await connectHost(socket);
    expect(c1.hostPid).not.toBe(pid0);
    expect(c1.hostCode).toBe("c2");
    c1.close();
  }, 60_000);

  it("a changed pty.node restarts it, the same code or not", async () => {
    const { state, socket } = setup();
    const dist = path.join(tmp, "dist");
    const before = installModule(dist, "1.1.0");
    startHost(state, { pty: before, den: "1.0.0", code: "c1" });
    (await connectWithin(socket)).close();
    const now = installModule(dist, "1.1.1");
    const r = rig(state, socket, () => ({ den: "1.0.1", code: "c1", pty: now }));
    const res = await refreshSessionHost(r.deps);
    expect(res).toMatchObject({ did: "restarted" });
  }, 60_000);

  it("a host that can't answer the code question restarts", async () => {
    const { state, socket } = setup();
    await oldHost(socket, "1.0.1");
    const r = rig(state, socket, () => ({ den: "1.0.1", code: "c1", pty: null }), {
      running: async () => [],
    });
    const res = await refreshSessionHost(r.deps);
    expect(res).toMatchObject({ did: "restarted", from: 4242 });
  }, 60_000);

  it("agents cut mid-turn get the carry-on line as their next input; idle ones get none", async () => {
    const { state, socket } = setup();
    startHost(state, { den: "1.0.0", code: "c1" });
    (await connectWithin(socket)).close();
    const r = rig(state, socket, () => ({ den: "1.0.1", code: "c2", pty: null }), {
      running: async () => ["a1", "a2", "a3"],
      busy: async () => ["a1", "a3"],
      waitMs: 100,
      cutNote: HOST_RESTART_NOTE,
    });
    const res = await refreshSessionHost(r.deps);
    expect(res).toMatchObject({ did: "restarted", busy: ["a1", "a3"] });
    expect(r.notes).toEqual([
      ["a1", "Den restarted while you were working; check your last step and carry on."],
      ["a2", null],
      ["a3", "Den restarted while you were working; check your last step and carry on."],
    ]);
  }, 60_000);

  it("the note off (sessions.host_restart_note: false): no agent gets it", async () => {
    const { state, socket } = setup();
    startHost(state, { den: "1.0.0", code: "c1" });
    (await connectWithin(socket)).close();
    const r = rig(state, socket, () => ({ den: "1.0.1", code: "c2", pty: null }), {
      busy: async () => ["a1"],
      waitMs: 100,
      cutNote: null,
    });
    await refreshSessionHost(r.deps);
    expect(r.notes).toEqual([["a1", null]]);
  }, 60_000);
});

describe("hostStale and doctor's terminal host row (issues 563, 597)", () => {
  const mod = (p: string): PtyModuleInfo => ({
    path: p,
    version: "1",
    id: fileIdentity(p),
  });

  it("names each way a host is not current; another version alone is not one", () => {
    const { state } = setup();
    const file = path.join(state, "pty.node");
    fs.writeFileSync(file, "x");
    const inst = { den: "2", code: "c", pty: mod(file) };
    expect(hostStale({ den: "2", code: "c", pty: mod(file) }, inst)).toBeNull();
    expect(hostStale({ den: "2", code: "c", pty: null }, inst)).toBeNull();
    expect(hostStale({ den: "1", code: "c", pty: null }, inst)).toBeNull();
    expect(hostStale({ den: undefined, pty: null }, inst)).toMatch(/older/);
    expect(hostStale({ den: "1", code: "b", pty: null }, inst)).toMatch(/code/);
    expect(
      hostStale({ den: "2", code: "c", pty: mod(path.join(state, "gone.node")) }, inst),
    ).toMatch(/no longer on disk/);
    const held = mod(file);
    fs.rmSync(file);
    fs.writeFileSync(file, "y");
    expect(
      hostStale({ den: "2", code: "c", pty: held }, { den: "2", code: "c", pty: mod(file) }),
    ).toMatch(/replaced/);
  });

  it("doctor: current, or restart needed naming the reason, with the restart command", async () => {
    const { state } = setup();
    const stale = await hostModuleLines("acme", {
      host: async () => ({ den: "1", code: "a", pty: null }),
      installed: () => ({ den: "2", code: "b", pty: null }),
    });
    expect(stale.check).toMatchObject({
      id: "terminal_host_module",
      status: "fail",
      fix: "acme sessions host --stop",
    });
    expect(stale.check.detail).toMatch(/^restart needed: host code changed/);
    expect(stale.check.detail).toMatch(
      /restart the terminal host: acme sessions host --stop/,
    );
    expect(stale.lines.join("\n")).not.toMatch(/\bshell\b/i);
    const file = path.join(state, "pty.node");
    fs.writeFileSync(file, "x");
    const held = mod(file);
    fs.rmSync(file);
    const module = await hostModuleLines("acme", {
      host: async () => ({ den: "2", code: "b", pty: held }),
      installed: () => ({ den: "2", code: "b", pty: null }),
    });
    expect(module.check.detail).toMatch(/^restart needed: terminal module changed/);
    const ok = await hostModuleLines("acme", {
      host: async () => ({ den: "1", code: "b", pty: null }),
      installed: () => ({ den: "2", code: "b", pty: null }),
    });
    expect(ok.check.status).toBe("ok");
    expect(ok.check.detail).toMatch(/^current/);
    const none = await hostModuleLines("acme", {
      host: async () => null,
      installed: () => ({ den: "2", code: "b", pty: null }),
    });
    expect(none.check.status).toBe("ok");
  });
});
