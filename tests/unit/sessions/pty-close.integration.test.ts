/**
 * Issue 503: an exited session closes its PTY master. A real host (its own
 * process, the real PTY module) starts 20 sessions of `/bin/sh -c`, which
 * exit at once; they stay listed as exited, their scrollback replays, and
 * the host's open PTY masters (counted from outside: lsof on macOS,
 * /proc on Linux) come back to where they were before.
 *
 * Runs only when the PTY module loads here (an optionalDependency).
 * The host is stopped in teardown every time (issue 501).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { loadPty } from "../../../src/shared/sessions/pty.js";

const ENGINE = path.resolve(__dirname, "../../..");
const LOADER = path.join(ENGINE, "node_modules/tsx/dist/loader.mjs");
const N = 20;

const maybe =
  loadPty().available &&
  (process.platform === "darwin" || process.platform === "linux")
    ? describe
    : describe.skip;

let dir = "";
let child: ChildProcess | null = null;
let hostPid = 0;
let c: HostClient | null = null;

/** The host's open PTY masters, counted from outside it. */
function openMasters(pid: number): number {
  if (process.platform === "linux") {
    let n = 0;
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      try {
        if (/(^|\/)ptmx$/.test(fs.readlinkSync(`/proc/${pid}/fd/${fd}`))) n++;
      } catch {
        /* closed meanwhile */
      }
    }
    return n;
  }
  const out = execFileSync("lsof", ["-n", "-P", "-a", "-p", String(pid)], {
    encoding: "utf8",
  });
  return out.split("\n").filter((l) => /\/dev\/ptmx\s*$/.test(l)).length;
}

async function connectWithin(ms: number): Promise<HostClient> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await connectHost(sessionPaths(dir).socket);
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function until(cond: () => Promise<boolean> | boolean, ms: number) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

beforeAll(async () => {
  if (!loadPty().available) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-503-"));
  child = spawn(
    process.execPath,
    [
      "--import",
      `file://${LOADER}`,
      path.join(__dirname, "helpers", "real-host.ts"),
      dir,
    ],
    { cwd: dir, stdio: "ignore", detached: true },
  );
  child.unref();
  c = await connectWithin(20_000);
  hostPid = c.hostPid;
}, 30_000);

afterAll(async () => {
  try {
    await c?.shutdown();
  } catch {
    /* already down */
  }
  c?.close();
  for (const pid of [hostPid, child?.pid ? -child.pid : 0])
    if (pid)
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}, 20_000);

maybe("issue 503: PTY masters of exited sessions", () => {
  it(`${N} exited sessions leave the host's PTY count at its baseline, and still replay`, async () => {
    const host = c!;
    const baseline = openMasters(hostPid);
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const info = await host.start({
        name: `pty-503-${i}`,
        cwd: dir,
        argv: ["/bin/sh", "-c", `echo marker-503-${i}; exit`],
        env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
        cols: 80,
        rows: 24,
      });
      ids.push(info.ref.id);
    }
    const allExited = await until(async () => {
      const l = await host.list();
      return ids.every((id) => l.find((s) => s.ref.id === id)?.exited);
    }, 20_000);
    expect(allExited).toBe(true);

    // The close delay is 0 s by default; give the module's own socket
    // teardown a moment, then the count must be back where it started.
    await until(() => openMasters(hostPid) <= baseline, 5_000);
    expect(openMasters(hostPid)).toBe(baseline);

    // Still listed, as exited, and the scrollback still replays.
    const listed = await host.list();
    expect(listed.filter((s) => ids.includes(s.ref.id))).toHaveLength(N);
    const out = Buffer.from(await host.scrollback(ids[7], 1 << 20)).toString();
    expect(out).toMatch(/marker-503-7/);
    let replay = "";
    const att = host.attach(ids[3], {
      onData: (d) => (replay += Buffer.from(d).toString()),
      onExit: () => undefined,
    });
    await att.ready;
    await until(() => /marker-503-3/.test(replay), 2_000);
    expect(replay).toMatch(/marker-503-3/);
    att.detach();
  }, 90_000);
});
