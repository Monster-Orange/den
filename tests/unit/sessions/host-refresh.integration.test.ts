/**
 * Issue 563: a terminal host that outlived an update restarts on the
 * installed version, through the stop `sessions host --stop` uses. Real
 * host processes (pipes behind the PTY seam), in a temp state dir; the
 * service manager that brings a stopped host back is a stand-in that
 * starts a new one (ensureHost's spawnHost seam). Never launchctl.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { type ChildProcess } from "child_process";
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
import {
  holdRestart,
  updateCheck,
  type UpdateWait,
} from "../../../src/ui/server/update-check.js";
import { updateDen } from "../../../src/ui/server/den-update.js";
import { startTestHost } from "../../test-hosts.js";

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
  // Issue 501: it ends with the test that started it.
  const { child } = startTestHost(HELPER, state, {
    cwd: tmp,
    env: {
      ...process.env,
      ...(env.pty ? { DEN_TEST_PTY: JSON.stringify(env.pty) } : {}),
      ...(env.den !== undefined ? { DEN_TEST_DEN: env.den } : {}),
      ...(env.code !== undefined ? { DEN_TEST_CODE: env.code } : {}),
    },
  });
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

/**
 * Issue 603: a security release installs while the Den agent is mid-turn.
 * Its turn lives in the terminal host, a process of its own. The whole
 * path runs here: the update check's pass, den_update (fake npm and
 * doctor, temp dirs), the restart's hold, then what the web server's
 * start does with the host (refreshSessionHost). The agent is a real
 * session in a real host; nothing signals, stops or restarts either.
 */
describe("issue 603: a security update while the Den agent works keeps its turn", () => {
  it("installs at once, holds the restart until the turn ends, and the web start keeps the host and the agent's session", async () => {
    const { state, socket } = setup();
    startHost(state, { den: "1.0.0", code: "c1" });
    const c0 = await connectWithin(socket);
    const hostPid = c0.hostPid;
    // The Den agent's session: it answers each line it is sent.
    const agent = await c0.start({
      name: "acme-den:server",
      cwd: tmp,
      argv: [
        process.execPath,
        "-e",
        'process.stdin.on("data",(b)=>process.stdout.write("ack:"+String(b)));setInterval(()=>{},1000);',
      ],
      env: { PATH: "/usr/bin:/bin" },
      cols: 80,
      rows: 24,
    });
    const exits: (number | undefined)[] = [];
    const watch = c0.attach(agent.ref.id, {
      onData: () => undefined,
      onExit: (code) => void exits.push(code),
    });
    await watch.ready;

    // Nothing may end, signal or stop the host or the agent's session.
    const killed: [number, unknown][] = [];
    const kill = jest
      .spyOn(process, "kill")
      .mockImplementation((pid: number, sig?: string | number) => {
        killed.push([pid, sig]);
        return true;
      });
    const proto = Object.getPrototypeOf(c0) as Record<string, unknown>;
    const stops = ["shutdown", "kill", "signal", "forget"].map((m) =>
      jest.spyOn(proto as never, m as never),
    );

    // The engine as npm lays it out in a distribution (den_update's input).
    const dist = path.join(tmp, "dist");
    const engine = path.join(dist, "node_modules", "@example", "den");
    fs.mkdirSync(path.join(engine, "src/ui/server"), { recursive: true });
    fs.writeFileSync(
      path.join(engine, "src/ui/server/update-watch.mjs"),
      "// the watch\n",
    );
    fs.writeFileSync(
      path.join(dist, "package.json"),
      JSON.stringify({ dependencies: { "@example/den": "1.0.0" } }),
    );

    let turn = true;
    const working = async (): Promise<UpdateWait | null> =>
      turn ? "busy" : null;
    const order: string[] = [];
    const logs: string[] = [];
    let plan = "";
    let webStart: ReturnType<typeof refreshSessionHost> | null = null;
    const check = updateCheck({
      running: () => "1.0.0",
      latest: async () => "1.0.1",
      pinned: () => "1.0.0",
      role: () => "lead",
      mode: () => "auto",
      cantUpdate: () => null,
      last: () => null,
      idle: async () => !turn,
      waitWhy: working,
      waitPast: working,
      security: async () => true,
      log: (l) => void logs.push(l),
      update: async (v, _reason, opts) => {
        const r = await updateDen(v, {
          root: dist,
          engine,
          stateDir: path.join(tmp, "update-state"),
          pkg: { name: "@example/den", version: "1.0.0" },
          npmView: async (spec) => spec.split("@").pop()!,
          npm: ["npm"],
          cli: ["den"],
          run: async (argv) => {
            order.push(argv[1] === "install" ? "install" : "doctor");
            return { code: 0, out: JSON.stringify({ checks: [] }) };
          },
          // The server's hold (index.ts): the security path reads past
          // the agent's question, never past a working turn.
          beforeRestart: async (keepAlive) => {
            order.push("hold");
            const h = await holdRestart({
              waitWhy: async () => {
                const w = await working();
                if (w) order.push(`held: ${w} (security ${!!opts?.security})`);
                return w;
              },
              maxMs: 60_000,
              everyMs: 50,
              keepAlive,
            });
            expect(h.timedOut).toBeNull();
          },
          watch: (_script, p) => {
            plan = p;
            order.push("watch");
            return 1;
          },
          note: (reason) => ({
            path: path.join(tmp, "restart-note.json"),
            marker: { reason },
          }),
          // The web server restarts; its start looks at the terminal
          // host (agent-routes refreshTerminalHost). The host's code is
          // the same in both versions.
          restart: () => {
            order.push("restart");
            webStart = refreshSessionHost(
              rig(
                state,
                socket,
                () => ({ den: "1.0.1", code: "c1", pty: null }),
                {
                  running: async () => ["server"],
                  busy: async () => (turn ? ["server"] : []),
                },
              ).deps,
            );
          },
          port: 7000,
          pid: 1,
          waitMs: 180_000,
        });
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
      ask: () => true,
      notice: () => undefined,
    });

    // The turn ends a while after the install starts.
    const ends = setTimeout(() => {
      order.push("turn ended");
      turn = false;
    }, 600);
    try {
      const t = await check.tick();
      // It installed at this pass, on the security path.
      expect(t).toMatchObject({
        did: "updating",
        version: "1.0.1",
        security: true,
      });
      expect(logs.some((l) => /waits:/.test(l))).toBe(false);
      expect(logs.join("\n")).toMatch(
        /security release: it updates while the Den agent is in the middle of a turn/,
      );
      // The restart waited, through the hold, for the turn's end.
      const held = order.filter((o) => o.startsWith("held:"));
      expect(held.length).toBeGreaterThan(0);
      expect(new Set(held)).toEqual(new Set(["held: busy (security true)"]));
      expect(order.filter((o) => !o.startsWith("held:"))).toEqual([
        "install",
        "doctor",
        "hold",
        "turn ended",
        "watch",
        "restart",
      ]);
      // The restart is the web server's alone, never the host's.
      const p = JSON.parse(fs.readFileSync(plan, "utf8")) as {
        restart: string[];
      };
      expect(p.restart.slice(0, 3)).toEqual(["den", "web", "restart"]);
      expect(p.restart).not.toContain("sessions");
      expect(p.restart).not.toContain("host");

      // The web start keeps the host: its code is unchanged.
      expect(webStart).not.toBeNull();
      expect(await webStart!).toEqual({
        did: "kept",
        from: "1.0.0",
        to: "1.0.1",
      });
      for (const s of stops) expect(s).not.toHaveBeenCalled();
      expect(
        killed.filter(([pid]) => pid === hostPid || pid === agent.pid),
      ).toEqual([]);
    } finally {
      clearTimeout(ends);
      kill.mockRestore();
      for (const s of stops) s.mockRestore();
    }

    // The same host, and the same session, still running and answering.
    const c1 = await connectHost(socket);
    try {
      expect(c1.hostPid).toBe(hostPid);
      const mine = (await c1.list()).find((s) => s.ref.id === agent.ref.id);
      expect(mine).toMatchObject({ pid: agent.pid });
      expect(mine?.exited).toBeFalsy();
      let out = "";
      const a = c1.attach(agent.ref.id, {
        onData: (b) => void (out += b.toString()),
      });
      await a.ready;
      c1.write(agent.ref.id, Buffer.from("still-here\n"));
      const end = Date.now() + 10_000;
      while (!out.includes("ack:still-here") && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50));
      expect(out).toContain("ack:still-here");
      a.detach();
    } finally {
      c1.close();
    }
    expect(exits).toEqual([]);
    watch.detach();
    c0.close();
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
