/**
 * A slow /api/services build must not hold up the rest of the server:
 * /api/server-info (what `<cli> mcp connect` and the MCP server probe, with a
 * 1.5s timeout) answers in milliseconds while services is in flight.
 *
 * The services build looks up each checkout's branch with git. Here `git` on
 * the server's PATH is a shim that takes 400ms for that lookup, so a build
 * that runs the lookups synchronously, one after another, blocks the event
 * loop for ~1.6s across four repos. Real server, throwaway distribution.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const REPOS = ["shop", "billing", "search", "ledger"];
const GIT_DELAY_S = 0.4;
let tmp = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
/** One line per branch lookup the shim served. */
let gitLog = "";
const lookups = (): number =>
  fs.existsSync(gitLog)
    ? fs.readFileSync(gitLog, "utf-8").split("\n").filter(Boolean).length
    : 0;

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

/** GET `p`; resolves with how long the full response took, in ms. */
function timed(
  p: string,
): Promise<{ ms: number; status: number; body: string }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: p, timeout: 15_000, agent: false },
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
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-services-"));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    REPOS.map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...REPOS.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  for (const n of REPOS)
    write(
      path.join(repos, n, ".den.yml"),
      `name: ${n}\nservices:\n  api:\n    commands:\n      local:\n        up: "true"\n`,
    );

  // `git rev-parse --abbrev-ref HEAD` is slow; everything else is real git.
  const realGit = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
  const shimDir = path.join(tmp, "shim");
  gitLog = path.join(tmp, "git-branch-lookups.log");
  write(
    path.join(shimDir, "git"),
    [
      "#!/bin/sh",
      'case "$*" in',
      `  *"rev-parse --abbrev-ref HEAD"*) echo "$PWD" >> ${gitLog}; sleep ${GIT_DELAY_S}; echo main; exit 0 ;;`,
      "esac",
      `exec ${realGit} "$@"`,
      "",
    ].join("\n"),
    0o755,
  );

  port = await freePort();
  server = spawnServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        DEN_ROOT: root,
        DEN_HOME: path.join(tmp, "home"),
        PORT: String(port),
        DEN_NO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await timed("/api/server-info")).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error(`server did not start:\n${serverOut}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}, 30_000);

afterAll(async () => {
  // The whole group: the tsx CLI and the server under it (a SIGKILL of the
  // CLI alone left the server running).
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("/api/services does not block the server", () => {
  it("server-info answers quickly while a slow services build is in flight", async () => {
    const services = timed("/api/services?refresh=1");
    // Let the services request reach the server and start building.
    await new Promise((r) => setTimeout(r, 100));
    const info = await timed("/api/server-info");
    const done = await services;

    expect(done.status).toBe(200);
    const list = JSON.parse(done.body) as { repo: string; branch: string }[];
    expect(list.map((s) => s.repo).sort()).toEqual([...REPOS].sort());
    expect(list.every((s) => s.branch === "main")).toBe(true);
    // The build is slow (each branch lookup takes 400ms) ...
    expect(done.ms).toBeGreaterThanOrEqual(GIT_DELAY_S * 1000);
    // ... yet server-info is not stuck behind it.
    expect(info.status).toBe(200);
    expect(info.ms).toBeLessThan(300);
  }, 20_000);

  it("concurrent services requests share one build", async () => {
    const before = lookups();
    // A key no earlier request built: three tabs polling at once.
    const all = await Promise.all(
      [1, 2, 3].map(() => timed("/api/services?workspace=default")),
    );
    expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(all.map((r) => r.body)).size).toBe(1);
    // One build: one branch lookup per repo, not one per request per repo.
    expect(lookups() - before).toBe(REPOS.length);
  }, 20_000);
});
