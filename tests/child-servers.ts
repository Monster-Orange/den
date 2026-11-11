/**
 * Start and stop a test's child server so it never outlives the run.
 *
 * - `spawnServer` starts it as the leader of its own process group
 *   (`detached`), so a wrapper (the `tsx` CLI) and the server under it are
 *   stopped together, and records the group (tests/child-reaper.mjs).
 * - `stopServer` SIGTERMs the group, waits, then SIGKILLs whatever is left
 *   of it, and drops the record.
 * - A test process that ends without its afterAll (a timeout, a failure,
 *   --forceExit, a kill) leaves the record behind: the run's global teardown
 *   stops the group, or the next run's global setup does.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const REGISTRY_DIR = path.join(os.tmpdir(), "den-test-children");
const recordOf = (pgid: number): string =>
  path.join(REGISTRY_DIR, `${pgid}.json`);

function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* the group is gone */
  }
}

/**
 * `spawn(cmd, args, opts)` in a process group of its own, recorded. `marker`
 * (default: the last argument, the entry script) is what the reaper checks
 * the group still runs before it signals it.
 */
export function spawnServer(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
  marker: string = args[args.length - 1] ?? cmd,
): ChildProcess {
  const child = spawn(cmd, args, { ...opts, detached: true });
  if (child.pid) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    fs.writeFileSync(
      recordOf(child.pid),
      JSON.stringify({
        pgid: child.pid,
        run: process.env.DEN_TEST_RUN ?? "",
        owner: process.pid,
        marker,
      }),
    );
  }
  return child;
}

/** Whether the group led by `pgid` still has a process in it. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * SIGTERM `child`'s group; after `graceMs` without the group ending,
 * SIGKILL it. Resolves once the group is gone (or after the SIGKILL).
 */
export async function stopServer(
  child: ChildProcess | undefined,
  graceMs = 5_000,
): Promise<void> {
  const pgid = child?.pid;
  if (!pgid) return;
  killGroup(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (groupAlive(pgid) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  if (groupAlive(pgid)) killGroup(pgid, "SIGKILL");
  forgetServer(child);
}

/** Drop `child`'s record (its group was stopped some other way). */
export function forgetServer(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    fs.unlinkSync(recordOf(child.pid));
  } catch {
    /* not recorded */
  }
}

/** A port nothing listened on a moment ago (it may be taken again). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "localhost", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** GET /api/server-info on `port`: its status and JSON, or null. */
function serverInfo(
  port: number,
): Promise<{ code: number; body: Record<string, unknown> | null } | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "localhost", port, path: "/api/server-info", timeout: 2_000 },
      (res) => {
        let text = "";
        res.setEncoding("utf-8");
        res.on("data", (d: string) => (text += d));
        res.on("end", () => {
          let body: Record<string, unknown> | null = null;
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* not JSON */
          }
          resolve({ code: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export interface StartedServer {
  server: ChildProcess;
  port: number;
  /** Everything it printed so far. */
  out: () => string;
}

/**
 * Start a Den web server for a test on a free port and wait until it is up.
 *
 * A port found free can be taken by another test's server before this one
 * binds it, and then /api/server-info answers 200 from that other server:
 * the test talks to the wrong one (its web.secret is missing, its state is
 * someone else's). So "up" means /api/server-info names `root` (the test's
 * distribution root) as its own. A port someone else took, or a server
 * that exits before it is up, is tried again on another port.
 *
 * `opts.env` gets PORT; `root` defaults to opts.env.DEN_ROOT, then opts.cwd.
 */
export async function startDenServer(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
  o: {
    root?: string;
    timeoutMs?: number;
    tries?: number;
    /** How a port is picked (tests of this helper). */
    pickPort?: () => Promise<number>;
  } = {},
): Promise<StartedServer> {
  const root = o.root ?? opts.env?.DEN_ROOT ?? String(opts.cwd ?? "");
  if (!root) throw new Error("startDenServer: no root to know it by");
  const want = real(root);
  const tries = o.tries ?? 3;
  let log = "";
  for (let attempt = 1; attempt <= tries; attempt++) {
    const port = await (o.pickPort ?? freePort)();
    let out = "";
    let exited = false;
    const server = spawnServer(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
      env: { ...(opts.env ?? process.env), PORT: String(port) },
    });
    server.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    server.stderr?.on("data", (d: Buffer) => (out += d.toString()));
    server.once("exit", () => (exited = true));
    const deadline = Date.now() + (o.timeoutMs ?? 20_000);
    let foreign = false;
    while (!exited && Date.now() < deadline) {
      const info = await serverInfo(port);
      if (info?.code === 200) {
        const r = info.body?.root;
        if (typeof r === "string" && real(r) === want)
          return { server, port, out: () => out };
        foreign = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    await stopServer(server);
    log += `\n--- try ${attempt} on port ${port}: ${
      foreign ? "another server answered" : exited ? "it exited" : "timed out"
    }\n${out}`;
    // A server that exits for its own reasons, or never answers, fails now;
    // only a port someone else holds is worth another try.
    const portTaken = foreign || /EADDRINUSE/.test(out);
    if (!portTaken) break;
  }
  throw new Error(`the test's server did not start:${log}`);
}
