/**
 * The session host outlives its clients (AG-3a; the §5c gate "restart the
 * web service and the agent is still listed and attachable"). A host runs
 * in its own detached process; a client process starts a session and
 * attaches, and is then killed with SIGKILL, as a web server restart would
 * end it. A new client reconnects: the session is still listed, running,
 * and attachable, with its history and live output.
 *
 * No native module: the host runs commands over pipes (pipePtyFactory).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";

const ENGINE = path.resolve(__dirname, "../../..");
const LOADER = path.join(ENGINE, "node_modules/tsx/dist/loader.mjs");
const helper = (f: string) => path.join(__dirname, "helpers", f);

let dir = "";
let hostPid = 0;
let client: HostClient | null = null;
const children: ChildProcess[] = [];

function run(script: string, ...args: string[]): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", `file://${LOADER}`, helper(script), ...args],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  children.push(child);
  return child;
}

function line(child: ChildProcess, re: RegExp, ms = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(
      () => reject(new Error(`timed out waiting for ${re}`)),
      ms,
    );
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      const m = out.match(re);
      if (m) {
        clearTimeout(t);
        resolve(m[0]);
      }
    });
  });
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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-survive-"));
  const host = run("pipe-host.ts", dir);
  host.unref();
  const c = await connectWithin(20_000);
  hostPid = c.hostPid;
  c.close();
}, 30_000);

afterAll(async () => {
  try {
    const c = client ?? (await connectHost(sessionPaths(dir).socket));
    await c.shutdown();
    c.close();
  } catch {
    /* already down */
  }
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  if (hostPid) {
    try {
      process.kill(hostPid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}, 20_000);

describe("host survival", () => {
  it("a session outlives the client that started it", async () => {
    const starter = run("start-client.ts", dir, "acme-smb:planner");
    const ready = await line(starter, /ready \S+/);
    const id = ready.split(" ")[1];

    // The client dies without a goodbye, as in a web server restart.
    process.kill(starter.pid!, "SIGKILL");
    await new Promise((r) => starter.once("exit", r));
    await new Promise((r) => setTimeout(r, 300));

    client = await connectWithin(5_000);
    expect(client.hostPid).toBe(hostPid);
    const listed = await client.list();
    expect(listed).toEqual([
      expect.objectContaining({ ref: { backend: "den-pty", id } }),
    ]);
    expect(listed[0].exited).toBeFalsy();

    let seen = "";
    const att = client.attach(id, { onData: (d) => (seen += d.toString()) });
    await att.ready;
    // History from before the restart, then live output after it.
    expect(seen.startsWith("first\n")).toBe(true);
    const before = seen.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(seen.length).toBeGreaterThan(before);
    expect(seen.slice(before)).toMatch(/tick/);

    client.signal(id, "KILL");
    const end = Date.now() + 5_000;
    while (!(await client.list())[0].exited && Date.now() < end)
      await new Promise((r) => setTimeout(r, 50));
    expect((await client.list())[0].exited).toBe(true);
  }, 40_000);
});
