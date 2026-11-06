/**
 * The real web server in a throwaway distribution, with a `git` shim first
 * on its PATH that makes chosen git commands slow. A route that runs those
 * commands synchronously holds the event loop for as long as they take, so
 * /api/server-info, probed meanwhile, answers late.
 */
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as path from "path";
import { pathToFileURL } from "url";
import { denAuth } from "./den-auth.js";
import { spawnServer, stopServer } from "../../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../../..");

export function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

/** A git checkout at `dir` whose origin is `origin` (real git, no shim). */
export function gitRepo(dir: string, origin: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", origin],
  ]) {
    const r = spawnSync("git", args, { cwd: dir, stdio: "ignore" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  }
}

export interface SlowGitServer {
  port: number;
  /** SEC-1a: the CLI's credential for this server (its person token). */
  auth(): Record<string, string>;
  /** GET `p`; how long the full response took. */
  timed(
    p: string,
    headers?: Record<string, string>,
  ): Promise<{ ms: number; status: number; body: string }>;
  /** Lines the shim logged: one per slow command it served. */
  slowCalls(): number;
  stop(): Promise<void>;
}

/**
 * Start the server for distribution `root`. `slow` are substrings of git's
 * argument list (e.g. "config --get remote.origin.url") that sleep
 * `delayS` before running the real git.
 */
export async function startSlowGitServer(opts: {
  tmp: string;
  root: string;
  slow: string[];
  delayS: number;
  /** Modules to --import before the server (e.g. ./sync-spy.mjs). */
  preload?: string[];
}): Promise<SlowGitServer> {
  const realGit = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
  const shimDir = path.join(opts.tmp, "shim");
  const log = path.join(opts.tmp, "slow-git.log");
  write(
    path.join(shimDir, "git"),
    [
      "#!/bin/sh",
      'case "$*" in',
      ...opts.slow.map(
        (s) => `  *"${s}"*) echo "$*" >> ${log}; sleep ${opts.delayS} ;;`,
      ),
      "esac",
      `exec ${realGit} "$@"`,
      "",
    ].join("\n"),
    0o755,
  );

  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));

  let out = "";
  const entry = path.join(ENGINE, "src", "ui", "server", "index.ts");
  const tsxLoader = path.join(
    ENGINE,
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );
  const [cmd, args] = opts.preload?.length
    ? [
        process.execPath,
        [
          ...opts.preload.flatMap((m) => ["--import", pathToFileURL(m).href]),
          "--import",
          pathToFileURL(tsxLoader).href,
          entry,
        ],
      ]
    : [path.join(ENGINE, "node_modules", ".bin", "tsx"), [entry]];
  const server: ChildProcess = spawnServer(cmd, args, {
    cwd: opts.root,
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
      DEN_ROOT: opts.root,
      DEN_HOME: path.join(opts.tmp, "home"),
      DEN_DAEMONS_FILE: path.join(opts.tmp, "daemons.json"),
      PORT: String(port),
      DEN_NO_OPEN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (out += d.toString()));

  const timed: SlowGitServer["timed"] = (p, headers = {}) => {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: "127.0.0.1",
          port,
          path: p,
          headers,
          timeout: 30_000,
          agent: false,
        },
        (res) => {
          let body = "";
          res.on("data", (d: Buffer) => (body += d.toString()));
          res.on("end", () =>
            resolve({
              ms: Date.now() - started,
              status: res.statusCode ?? 0,
              body,
            }),
          );
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    });
  };

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await timed("/api/server-info")).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    port,
    auth: () => denAuth(path.join(opts.tmp, "home")),
    timed,
    slowCalls: () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, "utf-8").split("\n").filter(Boolean).length
        : 0,
    async stop() {
      await stopServer(server);
    },
  };
}

/**
 * Run `work` while probing /api/server-info every `everyMs`; the slowest
 * probe's time, and how many probes ran.
 */
export async function slowestProbeDuring(
  srv: SlowGitServer,
  work: Promise<unknown>,
  everyMs = 50,
): Promise<{ worst: number; probes: number }> {
  let done = false;
  void work.finally(() => (done = true));
  let worst = 0;
  let probes = 0;
  while (!done) {
    const { ms } = await srv.timed("/api/server-info");
    worst = Math.max(worst, ms);
    probes++;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  await work;
  return { worst, probes };
}
