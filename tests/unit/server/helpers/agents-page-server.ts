/**
 * The real web server on the demo distribution (examples/distribution,
 * product acme), for the Workspaces page's Agents section (AG-4a):
 *
 *   - workspaces north (repo notes) and south (repo blog), each with a
 *     checkout dir of its own (`directory:`), where their agents run;
 *   - a session host in this process, on the distribution's state dir
 *     (ACME_HOME), with a scripted PTY: nothing an agent starts really
 *     runs, and the server finds this host instead of starting one;
 *   - PATH shims: `claude` records a run and fails (it must never run),
 *     `docker` fails, and `sudo` succeeds, so the lock (R8) reads unlocked
 *     (passwordless sudo) without a real password;
 *   - an env built from a minimal set, never this process's.
 *
 * Invented names only. The caller closes it (stop) and its temp dir goes.
 */
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { SessionHost } from "../../../../src/shared/sessions/host.js";
import type { PtyLoad } from "../../../../src/shared/sessions/pty.js";
import {
  writeRecord,
  type AgentRecord,
} from "../../../../src/shared/agents/records.js";
import {
  scriptedFactory,
  type ScriptedPty,
} from "../../sessions/helpers/fake-pty.js";
import { denAuth } from "./den-auth.js";
import { spawnServer, stopServer } from "../../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../../..");

export interface AgentsPageServer {
  port: number;
  base: string;
  tmp: string;
  stateDir: string;
  /** Every PTY the host was asked for (the agents' "processes"). */
  made: ScriptedPty[];
  /** Where workspace `ws`'s agents run. */
  wsDir(ws: string): string;
  /** The `claude` shim's record of a run (must never exist). */
  ran: string;
  /** Write an agent record as `agents start` would have. */
  seed(rec: Partial<AgentRecord> & { id: string; workspace: string }): void;
  /** POST /api/settings (language, appearance). */
  settings(body: Record<string, unknown>): Promise<number>;
  log(): string;
  stop(): Promise<void>;
}

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

function get(port: number, p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "localhost", port, path: p, timeout: 5_000, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

export async function startAgentsPageServer(
  opts: { root?: string } = {},
): Promise<AgentsPageServer> {
  const tmp = fs.realpathSync(
    opts.root
      ? (fs.mkdirSync(opts.root, { recursive: true }), opts.root)
      : fs.mkdtempSync(path.join(os.tmpdir(), "den-wag-")),
  );
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  const wsDir = (ws: string) => path.join(tmp, "workspaces", ws);
  const members: Record<string, string> = { north: "notes", south: "blog" };
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    Object.values(members)
      .map((n) => `${n}:\n  gh: acme/${n}\n`)
      .join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [north, south]",
      "focus: north",
      "workspaces:",
      ...Object.entries(members).flatMap(([ws, repo]) => [
        `  ${ws}:`,
        `    directory: ${wsDir(ws)}`,
        "    services:",
        `      ${repo}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, repo)}`,
      ]),
      "",
    ].join("\n"),
  );
  for (const [ws, repo] of Object.entries(members)) {
    fs.mkdirSync(wsDir(ws), { recursive: true });
    write(
      path.join(repos, repo, ".acme.yml"),
      [
        `name: ${repo}`,
        "services:",
        `  ${repo}:`,
        "    commands:",
        "      local:",
        '        up: "true"',
        '        down: "true"',
        "",
      ].join("\n"),
    );
  }
  const bin = path.join(tmp, "bin");
  const ran = path.join(tmp, "claude-ran");
  write(path.join(bin, "docker"), "#!/bin/sh\nexit 1\n", 0o755);
  write(path.join(bin, "sudo"), "#!/bin/sh\nexit 0\n", 0o755);
  write(
    path.join(bin, "claude"),
    `#!/bin/sh\necho "$@" >> "${ran}"\nexit 1\n`,
    0o755,
  );

  const home = path.join(tmp, "home");
  const stateDir = path.join(home, ".acme");
  fs.mkdirSync(stateDir, { recursive: true });
  const { factory, made } = scriptedFactory();
  const load: PtyLoad = { available: true, factory };
  const host = new SessionHost({
    stateDir,
    pty: () => load,
    flushMs: 0,
    log: () => undefined,
  });
  await host.listen();

  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    TMPDIR: os.tmpdir(),
    LANG: "C",
    DEN_ROOT: root,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_EDGE_DIR: path.join(tmp, "edge-state"),
    ACME_HOME: stateDir,
    DEN_HOME: path.join(home, ".den"),
    DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
    DEN_NO_OPEN: "1",
    ACME_NO_OPEN: "1",
    NO_COLOR: "1",
    PORT: String(port),
  };
  let out = "";
  const server: ChildProcess = spawnServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout!.on("data", (d: Buffer) => (out += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (out += d.toString()));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await get(port, "/api/server-info")) === 200) break;
    } catch {
      /* not up yet */
    }
    if (server.exitCode !== null || Date.now() > deadline) {
      await stopServer(server);
      await host.close();
      throw new Error("the web server did not start");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const base = `http://localhost:${port}`;
  return {
    port,
    base,
    tmp,
    stateDir,
    made,
    wsDir,
    ran,
    seed(rec) {
      writeRecord(stateDir, {
        persona: rec.id,
        runtime: "den-claude",
        cwd: wsDir(rec.workspace),
        session: { backend: "den-pty", id: `gone-${rec.id}` },
        sessionName: `acme-${rec.workspace}:${rec.id}`,
        startedAt: "2026-11-06T09:30:00.000Z",
        ...rec,
      });
    },
    async settings(body) {
      const r = await fetch(`${base}/api/settings`, {
        method: "POST",
        headers: { ...denAuth(stateDir), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return r.status;
    },
    log: () => out,
    async stop() {
      await stopServer(server);
      await host.close();
      if (!opts.root) fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}
