/**
 * `<cli> web restart|down` act on OUR server from an older Den.
 *
 * A server from before 0.2.6 reports no `root` in /api/server-info; it is
 * ours when it runs from our root (its working directory), and 0.2.6-dev.0
 * classified it so. But stopping it then looked for "our" pids by command
 * line: the entry point of THIS engine or one under the root. An older Den
 * (installed elsewhere) or a hand-started server has neither, so no pid was
 * found: `web restart` printed "already running" and restarted nothing, and
 * `web down` printed "not running" while the server stayed up and bound.
 *
 * Real bin/den in a throwaway distribution, against a stand-in "old" server:
 * run from our root, its command line naming an older engine's entry point
 * elsewhere, answering server-info without `root`, with or without a
 * web.json that records it.
 */
import { afterAll, afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "den-web-legacy-"));
/** Where an older Den lives: not this engine, not under the root. */
const OLD_ENGINE = path.join(tmpBase, "old-den");

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeRoot(name: string): string {
  const root = path.join(tmpBase, name);
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  return root;
}

const FAKE = path.join(OLD_ENGINE, "old-server.cjs");
write(
  FAKE,
  `const http = require("http");
const port = Number(process.env.FAKE_PORT);
const started = Date.now();
const s = http.createServer((req, res) => {
  if (req.url === "/api/server-info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    // 0.2.5's server-info: no root, no product.
    return res.end(JSON.stringify({ pid: process.pid, port, version: "0.2.5",
      startedAt: new Date(started).toISOString(), uptimeMs: Date.now() - started }));
  }
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end("[]");
  }
  if (req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end('<html><head><meta name="den-ui" content="1"></head></html>');
  }
  res.writeHead(404);
  res.end();
});
process.on("SIGTERM", () => s.close(() => process.exit(0)));
s.listen(port, "127.0.0.1", () => console.log("LISTENING"));
`,
);

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const pids: number[] = [];
const ports: { root: string; port: number }[] = [];

/**
 * The old server, run from `root` as that version's `web up` ran it:
 * detached, its launcher gone, so it is not this test's child (a child
 * would linger as a zombie, unreaped while the test waits on the CLI).
 */
async function startOld(root: string, port: number): Promise<number> {
  const launch = spawnSync(
    process.execPath,
    [
      "-e",
      `const c = require("child_process").spawn(process.execPath, ${JSON.stringify(
        // The older engine's server entry point, as its command line has it.
        [FAKE, path.join(OLD_ENGINE, "src/ui/server/index.ts")],
      )}, { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid);`,
    ],
    {
      cwd: root,
      encoding: "utf-8",
      env: { ...process.env, FAKE_PORT: String(port) },
    },
  );
  const pid = Number(launch.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error(`old server did not start: ${launch.stderr}`);
  pids.push(pid);
  const deadline = Date.now() + 10_000;
  while (!listening(port)) {
    if (Date.now() > deadline) throw new Error("old server did not listen");
    await new Promise((r) => setTimeout(r, 50));
  }
  return pid;
}

/** web.json as the old `web up` wrote it. */
function writeWebJson(root: string, port: number, pid: number): void {
  write(
    path.join(root, "home", "web.json"),
    JSON.stringify({
      pid,
      port,
      root,
      logPath: path.join(root, "home", "logs", "den", "web.log"),
      startedAt: new Date().toISOString(),
      command: `node ${path.join(OLD_ENGINE, "src/ui/server/index.ts")}`,
    }),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exited(pid: number, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

function den(
  root: string,
  args: string[],
): { out: string; status: number | null } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), ["web", ...args], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(root, "home"),
      DEN_DAEMONS_FILE: path.join(root, "home", "daemons.json"),
      DEN_NO_OPEN: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 120_000,
  });
  return { out: `${r.stdout}${r.stderr}`, status: r.status };
}

function serverInfo(port: number): Promise<{ pid?: number; root?: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path: "/api/server-info", agent: false },
        (res) => {
          let body = "";
          res.on("data", (d: Buffer) => (body += d.toString()));
          res.on("end", () => resolve(JSON.parse(body)));
        },
      )
      .on("error", reject);
  });
}

function listening(port: number): boolean {
  const r = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf-8",
  });
  return r.stdout.trim() !== "";
}

afterEach(() => {
  for (const pid of pids.splice(0))
    if (alive(pid)) process.kill(pid, "SIGKILL");
  // A real server a restart started: stop it through the CLI.
  for (const { root, port } of ports.splice(0))
    if (listening(port)) den(root, ["down", "--port", `${port}`]);
});

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("our server from an older Den (no root in server-info)", () => {
  it.each([
    ["recorded in web.json", true],
    ["hand-started (no web.json)", false],
  ])(
    "down stops it: %s",
    async (_what, withState) => {
      const root = makeRoot(`down-${withState ? "state" : "bare"}`);
      const port = await freePort();
      const old = await startOld(root, port);
      if (withState) writeWebJson(root, port, old);

      const { out, status } = den(root, ["down", "--port", `${port}`]);
      expect(out).not.toMatch(/is not running/);
      expect(out).toMatch(/OK Den web stopped/);
      expect(status).toBe(0);
      expect(await exited(old)).toBe(true);
      expect(listening(port)).toBe(false);
    },
    120_000,
  );

  it.each([
    ["recorded in web.json", true],
    ["hand-started (no web.json)", false],
  ])(
    "restart replaces it: %s",
    async (_what, withState) => {
      const root = makeRoot(`restart-${withState ? "state" : "bare"}`);
      const port = await freePort();
      ports.push({ root, port });
      const old = await startOld(root, port);
      if (withState) writeWebJson(root, port, old);

      const { out, status } = den(root, [
        "restart",
        "--no-open",
        "--port",
        `${port}`,
      ]);
      expect(out).not.toMatch(/already running/);
      expect(out).toMatch(/web stopped; starting again/);
      expect(status).toBe(0);
      expect(await exited(old)).toBe(true);
      const info = await serverInfo(port);
      expect(info.pid).not.toBe(old);
      expect(info.root).toBe(root);
    },
    180_000,
  );
});
