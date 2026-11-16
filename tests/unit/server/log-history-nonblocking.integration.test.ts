/**
 * Issue 131: opening a service's log history must not hold up the rest of
 * the server. The first open finds the container (`docker ps --filter …`)
 * and dumps its whole log (`docker logs --timestamps`) to a snapshot file;
 * both were synchronous, so every other page waited for them.
 *
 * Here `docker` on the server's PATH is a shim: the filtered `docker ps`
 * takes PS_DELAY_S and `docker logs` takes LOGS_DELAY_S. /api/server-info
 * must answer in milliseconds during each. Real server, throwaway
 * distribution; no real docker.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const PS_DELAY_S = 0.8;
const LOGS_DELAY_S = 1.5;
let tmp = "";
let port = 0;
let server: ChildProcess;
let dockerLog = "";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-history-"));
  const root = path.join(tmp, "dist");
  const repo = path.join(tmp, "repos", "shop");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${repo}`,
      "",
    ].join("\n"),
  );
  write(
    path.join(repo, ".den.yml"),
    [
      "name: shop",
      "services:",
      "  db:",
      "    commands:",
      "      local:",
      '        up: "true"',
      "    logs:",
      "      local:",
      "        type: shell",
      '        cmd: "docker logs -f $(docker ps --filter name=shop-db -q)"',
      "",
    ].join("\n"),
  );

  // A fake docker: slow for the filtered ps and for logs, empty otherwise.
  const shimDir = path.join(tmp, "shim");
  dockerLog = path.join(tmp, "docker-calls.log");
  write(
    path.join(shimDir, "docker"),
    [
      "#!/bin/sh",
      `echo "$*" >> ${dockerLog}`,
      'case "$*" in',
      `  "ps --filter name=shop-db"*) sleep ${PS_DELAY_S}; echo shop-db; exit 0 ;;`,
      `  "logs --timestamps shop-db") sleep ${LOGS_DELAY_S};`,
      '    echo "2026-11-16T10:00:00.000000000Z first line"',
      '    echo "2026-11-16T10:00:01.000000000Z second line"; exit 0 ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    0o755,
  );

  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        DEN_ROOT: root,
        DEN_HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
      },
    },
  );
  server = started.server;
  port = started.port;
}, 30_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("log history does not block the server (issue 131)", () => {
  it("server-info answers quickly while the container lookup and the log dump run", async () => {
    const history = timed("/api/service/history?repo=shop&service=db");
    // During the slow `docker ps --filter`.
    await sleep(250);
    const duringPs = await timed("/api/server-info");
    // During the slow `docker logs` (the ps has finished by now).
    await sleep(PS_DELAY_S * 1000);
    const duringLogs = await timed("/api/server-info");
    const done = await history;

    expect(done.status).toBe(200);
    const page = JSON.parse(done.body) as { lines?: string[] };
    expect(page.lines).toEqual([
      "2026-11-16T10:00:00.000000000Z first line",
      "2026-11-16T10:00:01.000000000Z second line",
    ]);
    // History is slow: both docker calls ran ...
    expect(done.ms).toBeGreaterThanOrEqual((PS_DELAY_S + LOGS_DELAY_S) * 1000);
    // ... yet the rest of the server answered during each of them.
    expect(duringPs.status).toBe(200);
    expect(duringPs.ms).toBeLessThan(300);
    expect(duringLogs.status).toBe(200);
    expect(duringLogs.ms).toBeLessThan(300);
  }, 20_000);

  it("two opens of the same container share one log dump", async () => {
    // A container with no snapshot yet: rename the first one away.
    const snaps = path.join(tmp, "home");
    const found = fs
      .readdirSync(snaps, { recursive: true })
      .map(String)
      .find((f) => f.endsWith(`history${path.sep}shop-db.log`));
    expect(found).toBeTruthy();
    fs.rmSync(path.join(snaps, found!));
    const before = fs
      .readFileSync(dockerLog, "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("logs ")).length;
    const both = await Promise.all([
      timed("/api/service/history?repo=shop&service=db"),
      timed("/api/service/history?repo=shop&service=db"),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(new Set(both.map((r) => r.body)).size).toBe(1);
    const after = fs
      .readFileSync(dockerLog, "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("logs ")).length;
    expect(after - before).toBe(1);
  }, 20_000);
});
