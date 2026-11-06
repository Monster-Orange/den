/**
 * The real web server in a throwaway distribution, for the error frame's
 * tests (R26, MD-2, 0.3.0-dev.38):
 *
 *   - its env is built from a minimal set (HOME, PATH, the DEN_* it needs):
 *     never this process's env, so no credential reaches it or a log;
 *   - PATH starts with shims for docker, op, doppler, mkcert, aws, opctl
 *     and gh that fail at once: a route that would ask them gets an error,
 *     nothing real runs;
 *   - the engine is a temp copy (every entry of Den's checkout symlinked,
 *     package.json copied), pointed at by DEN_ENGINE_ROOT, so a test can
 *     bump "the engine on disk" without touching the real package.json;
 *   - DEN_DEBUG_ROUTES=1 arms /_den/throw and /api/_den/throw.
 */
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";

export const ENGINE = path.resolve(__dirname, "../../../..");

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FrameServer {
  port: number;
  base: string;
  tmp: string;
  /** The temp engine (DEN_ENGINE_ROOT). */
  engine: string;
  /** Everything the server printed. */
  log(): string;
  req(
    method: string,
    p: string,
    opts?: { headers?: Record<string, string>; body?: string },
  ): Promise<Reply>;
  /** Write the temp engine's package.json version. */
  bumpEngine(version: string): void;
  stop(): Promise<void>;
  /** Start it again on the same port (after stop), as a restart does. */
  start(): Promise<void>;
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

export async function startFrameServer(
  opts: { prefix?: string } = {},
): Promise<FrameServer> {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), opts.prefix ?? "den-frame-")),
  );
  // The temp engine: Den's checkout by symlink, its package.json a copy.
  const engine = path.join(tmp, "engine");
  fs.mkdirSync(engine);
  for (const e of fs.readdirSync(ENGINE)) {
    if (e === "package.json" || e === ".git") continue;
    fs.symlinkSync(path.join(ENGINE, e), path.join(engine, e));
  }
  fs.copyFileSync(
    path.join(ENGINE, "package.json"),
    path.join(engine, "package.json"),
  );
  // The distribution.
  const root = path.join(tmp, "dist");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  // Shims: every external tool a route might ask fails at once.
  const shim = path.join(tmp, "shim");
  for (const tool of [
    "docker",
    "op",
    "doppler",
    "mkcert",
    "aws",
    "opctl",
    "gh",
  ])
    write(
      path.join(shim, tool),
      `#!/bin/sh\necho "${tool}: not here (test shim)" >&2\nexit 1\n`,
      0o755,
    );
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    DEN_ROOT: root,
    DEN_ENGINE_ROOT: engine,
    DEN_HOME: path.join(tmp, "den-home"),
    DEN_NO_OPEN: "1",
    DEN_DEBUG_ROUTES: "1",
    PORT: String(port),
    LANG: "C",
  };
  let out = "";
  let proc: ChildProcess | null = null;

  const req: FrameServer["req"] = (method, p, o = {}) =>
    new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: "localhost",
          port,
          path: p,
          method,
          headers: o.headers,
          agent: false,
          timeout: 15_000,
        },
        (res) => {
          // A stream (SSE) never ends by itself: its head is the answer.
          if (String(res.headers["content-type"]).includes("event-stream")) {
            res.destroy();
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: "",
            });
            return;
          }
          let body = "";
          res.on("data", (d: Buffer) => (body += d.toString()));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
            }),
          );
        },
      );
      r.on("error", reject);
      r.on("timeout", () => r.destroy(new Error(`timeout: ${method} ${p}`)));
      if (o.body !== undefined) r.write(o.body);
      r.end();
    });

  const start = async (): Promise<void> => {
    proc = spawn(
      path.join(ENGINE, "node_modules", ".bin", "tsx"),
      [path.join(ENGINE, "src", "ui", "server", "index.ts")],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    proc.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    const deadline = Date.now() + 25_000;
    for (;;) {
      try {
        if ((await req("GET", "/api/server-info")).status === 200) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const stop = async (): Promise<void> => {
    const p = proc;
    proc = null;
    if (!p || p.exitCode !== null) return;
    const exited = new Promise((r) => p.once("exit", r));
    p.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((r) => setTimeout(r, 5_000).unref()),
    ]);
    if (p.exitCode === null) p.kill("SIGKILL");
  };

  await start();
  return {
    port,
    base: `http://localhost:${port}`,
    tmp,
    engine,
    log: () => out,
    req,
    bumpEngine(version) {
      const file = path.join(engine, "package.json");
      const pkg = JSON.parse(fs.readFileSync(file, "utf-8")) as {
        version: string;
      };
      pkg.version = version;
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    },
    stop,
    start,
  };
}

/** Remove a FrameServer's temp dir (its own mkdtemp, nothing else). */
export function removeFrameTmp(s: FrameServer | null): void {
  if (s && s.tmp.startsWith(fs.realpathSync(os.tmpdir())))
    fs.rmSync(s.tmp, { recursive: true, force: true });
}
