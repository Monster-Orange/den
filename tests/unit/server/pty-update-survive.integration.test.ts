/**
 * Do the person's open terminals survive a Den update?
 *
 * The update path (den-update.ts, SRV-1b): npm replaces the engine's files
 * in the distribution, then the old web server stops and a new one starts
 * on the same port (`<cli> web restart`). The terminal host (host.ts) is a
 * process of its own, so it outlives the web server; the new server's
 * start asks it what it runs (issue 563, 597's refreshSessionHost) and
 * keeps it when its code and PTY module are the installed ones, or
 * restarts it when they are not.
 *
 * Here it all runs for real, in a temp HOME and state dir: a copy of this
 * engine as the "installed" Den, a real web server from it, the real host
 * it spawns with the real native PTY module, and a real login shell opened
 * the way the Terminals page opens one (POST /api/workspaces/<ws>/sessions).
 * A marker and a running counter go into the shell. Then the update: the
 * web server stops, the engine's files change as npm would change them (a
 * newer version number; with or without a change to the host's own code),
 * and a new web server starts from them on the same port. After it, the
 * terminal must be the same session, still running, with the marker in its
 * scrollback, the counter still counting, and new input answered.
 *
 * Never this machine's Den, its ports or launchctl. Runs only when the PTY
 * module loads here (an optionalDependency); otherwise it is skipped.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import { cliAuthHeaders } from "../../../src/shared/web-secret.js";
import {
  startDenServer,
  stopServer,
  type StartedServer,
} from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const pty = loadPty();
const maybe = pty.available ? describe : describe.skip;

/** What an engine copy needs: never tests, docs, reports or node_modules. */
const ENGINE_PARTS = [
  "bin",
  "config",
  "examples",
  "gate",
  "make",
  "packages",
  "schemas",
  "service",
  "skills",
  "src",
  "themes",
  "den.yml",
  "package.json",
  "CHANGELOG.md",
  "tsconfig.json",
];

interface Rig {
  tmp: string;
  engine: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  root: string;
  server: StartedServer | null;
  port: number;
  hostPid: number;
}

let rig: Rig | null = null;

afterEach(async () => {
  if (!rig) return;
  const r = rig;
  rig = null;
  if (r.server) await stopServer(r.server.server);
  for (;;) {
    try {
      const c = await connectHost(sessionPaths(r.stateDir).socket);
      if (c.hostPid) r.hostPid = c.hostPid;
      await c.shutdown();
      c.close();
      await new Promise((res) => setTimeout(res, 300));
    } catch {
      break;
    }
  }
  if (r.hostPid)
    try {
      process.kill(r.hostPid, "SIGKILL");
    } catch {
      /* gone */
    }
  fs.rmSync(r.tmp, { recursive: true, force: true });
}, 60_000);

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function makeRig(): Rig {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-pus-")),
  );
  // The installed Den: a copy of this engine, its packages from this one.
  const engine = path.join(tmp, "engine");
  for (const part of ENGINE_PARTS) {
    const from = path.join(ENGINE, part);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(engine, part), {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("node_modules"),
    });
  }
  fs.symlinkSync(
    fs.realpathSync(path.join(ENGINE, "node_modules")),
    path.join(engine, "node_modules"),
  );
  const root = path.join(tmp, "dist");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  const ws = path.join(tmp, "workspaces", "north");
  fs.mkdirSync(ws, { recursive: true });
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north]",
      "focus: north",
      "workspaces:",
      "  north:",
      `    directory: ${ws}`,
      "    services: {}",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "user.yml"),
    "agents:\n  restore_on_boot: false\n",
  );
  const bin = path.join(tmp, "bin");
  write(path.join(bin, "docker"), "#!/bin/sh\nexit 1\n", 0o755);
  write(path.join(bin, "sudo"), "#!/bin/sh\nexit 1\n", 0o755);
  // D20 asks launchd which login it runs in: a stand-in, never launchctl.
  write(
    path.join(bin, "launchctl"),
    '#!/bin/sh\nif [ "$1" = managername ]; then echo Aqua; exit 0; fi\nexit 1\n',
    0o755,
  );
  const home = path.join(tmp, "home");
  const stateDir = path.join(home, ".acme");
  fs.mkdirSync(stateDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}${path.delimiter}/usr/bin:/bin`,
    SHELL: "/bin/sh",
    DEN_SYSTEM_SUDO: path.join(bin, "sudo"),
    DEN_LOGIN_SHELL: "off",
    DEN_RUNTIME_DIRS: "",
    TMPDIR: os.tmpdir(),
    LANG: "C",
    TSX_DISABLE_CACHE: "1",
    DEN_ROOT: root,
    DEN_ENGINE_ROOT: engine,
    DEN_EDGE_DIR: path.join(tmp, "edge-state"),
    ACME_HOME: stateDir,
    DEN_HOME: path.join(home, ".den"),
    DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
    DEN_NO_OPEN: "1",
    ACME_NO_OPEN: "1",
    NO_COLOR: "1",
  };
  return {
    tmp,
    engine,
    stateDir,
    env,
    root,
    server: null,
    port: 0,
    hostPid: 0,
  };
}

/** The web server from the rig's engine (the same port when `port`). */
async function webUp(r: Rig, port?: number): Promise<void> {
  r.server = await startDenServer(
    process.execPath,
    [
      path.join(r.engine, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(r.engine, "src", "ui", "server", "index.ts"),
    ],
    { cwd: r.root, env: r.env },
    {
      timeoutMs: 60_000,
      ...(port ? { pickPort: async () => port, tries: 1 } : {}),
    },
  );
  r.port = r.server.port;
}

async function until(ok: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await new Promise((res) => setTimeout(res, 200));
  }
  return ok();
}

/** Everything the session printed (its scrollback), as text. */
async function screen(c: HostClient, id: string): Promise<string> {
  return (await c.scrollback(id, 4 * 1024 * 1024)).toString("utf-8");
}

const lastTick = (s: string): number => {
  const all = [...s.matchAll(/TICK-(\d+)/g)].map((m) => Number(m[1]));
  return all.length ? Math.max(...all) : 0;
};

/**
 * The update's own steps, as den-update.ts and update-watch.mjs take them:
 * the files change in place (npm), the old server stops, a new one starts
 * from the new files on the same port.
 */
async function update(r: Rig, o: { hostCodeChanges: boolean }): Promise<void> {
  const pkgFile = path.join(r.engine, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf-8")) as {
    version: string;
  };
  pkg.version = `${pkg.version.replace(/-.*$/, "")}-upd.1`;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  if (o.hostCodeChanges)
    // A release that touches a file in the host's module graph
    // (host-code.ts): its code id changes.
    fs.appendFileSync(
      path.join(r.engine, "src", "shared", "sessions", "ring-buffer.ts"),
      "\n// a newer release's change\n",
    );
  const port = r.port;
  if (r.server) await stopServer(r.server.server);
  r.server = null;
  await webUp(r, port);
}

async function survives(o: { hostCodeChanges: boolean }): Promise<void> {
  const r = (rig = makeRig());
  await webUp(r);
  const auth = cliAuthHeaders(r.stateDir);
  // The Terminals page's New terminal.
  const opened = await fetch(
    `http://localhost:${r.port}/api/workspaces/north/sessions`,
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    },
  );
  if (opened.status !== 200)
    throw new Error(
      `opening the terminal: ${opened.status} ${await opened.text()}`,
    );
  const { session } = (await opened.json()) as {
    session: { id: string; pid: number };
  };
  const id = session.id;
  const socket = sessionPaths(r.stateDir).socket;
  const before = await connectHost(socket);
  r.hostPid = before.hostPid;
  const mark = `MARK-${Math.random().toString(36).slice(2, 10)}`;
  // `$((1+1))`: only the shell's own output has "2", never its echo.
  before.write(
    id,
    Buffer.from(
      `echo ${mark}-$((1+1)); i=0; while :; do i=$((i+1)); echo TICK-$i; sleep 1; done &\n`,
    ),
  );
  let ready = false;
  for (let end = Date.now() + 20_000; !ready && Date.now() < end; ) {
    const s = await screen(before, id);
    ready = s.includes(`${mark}-2`) && lastTick(s) >= 2;
    if (!ready) await new Promise((res) => setTimeout(res, 250));
  }
  expect(ready).toBe(true);
  const listedBefore = (await before.list()).find((s) => s.ref.id === id);
  before.close();

  await update(r, o);
  // The new server's start asks the host what it runs, and keeps or
  // restarts it.
  const logged = await until(
    () => /terminal host (kept|restarted)/.test(r.server?.out() ?? ""),
    120_000,
  );
  const line =
    (r.server?.out() ?? "")
      .split("\n")
      .find((l) => /terminal host (kept|restarted)/.test(l))
      ?.trim() ?? "(no terminal host line)";
  console.log(
    `pty-update-survive (host code ${o.hostCodeChanges ? "changed" : "unchanged"}): ${line}`,
  );
  expect(logged).toBe(true);

  // The server lists the same terminal.
  const listed = await fetch(`http://localhost:${r.port}/api/sessions`, {
    headers: auth,
  });
  expect(listed.status).toBe(200);
  const body = JSON.stringify(await listed.json());

  const after = await connectHost(socket);
  try {
    const info = (await after.list()).find((s) => s.ref.id === id);
    const text = info ? await screen(after, id).catch(() => "") : "";
    // The counter after the update, and again a moment later.
    const ticksBefore = lastTick(text);
    // New input reaches the same shell, and it answers.
    const reply = `NEW-${Math.random().toString(36).slice(2, 10)}`;
    let answered = false;
    if (info && !info.exited) {
      after.write(id, Buffer.from(`echo ${reply}-$((40+2))\n`));
      const end = Date.now() + 15_000;
      while (!answered && Date.now() < end) {
        answered = (await screen(after, id)).includes(`${reply}-42`);
        if (!answered) await new Promise((res) => setTimeout(res, 250));
      }
    }
    await new Promise((res) => setTimeout(res, 2_500));
    const ticksAfter = info
      ? lastTick(await screen(after, id).catch(() => ""))
      : 0;
    const got = {
      hostPid: after.hostPid === r.hostPid ? "same" : "replaced",
      listedByServer: body.includes(id),
      listedByHost: !!info,
      running: !!info && !info.exited,
      samePid: !!info && info.pid === listedBefore?.pid,
      markerInScrollback: text.includes(`${mark}-2`),
      counterKeptCounting: ticksAfter > ticksBefore,
      newInputAnswered: answered,
    };
    console.log(
      `pty-update-survive (host code ${o.hostCodeChanges ? "changed" : "unchanged"}): ${JSON.stringify(got)}`,
    );
    r.hostPid = after.hostPid || r.hostPid;
    expect(got).toEqual({
      hostPid: got.hostPid,
      listedByServer: true,
      listedByHost: true,
      running: true,
      samePid: true,
      markerInScrollback: true,
      counterKeptCounting: true,
      newInputAnswered: true,
    });
  } finally {
    after.close();
  }
}

maybe("an open terminal through a Den update", () => {
  it("an update that leaves the terminal host's code alone: the terminal survives", async () => {
    await survives({ hostCodeChanges: false });
  }, 300_000);

  it("an update that changes the terminal host's code: the terminal survives", async () => {
    await survives({ hostCodeChanges: true });
  }, 300_000);
});
