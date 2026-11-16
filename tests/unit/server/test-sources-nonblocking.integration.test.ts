/**
 * Issue 132: the Tests page must not hold up the rest of the server. Its
 * /api/test-sources request reads each repo's branch and short SHA with git;
 * those reads ran synchronously, one repo after another, so every other
 * page waited for them.
 *
 * Here `git` on the server's PATH is a shim whose `rev-parse` takes
 * GIT_DELAY_S. With four repos and two reads each, a synchronous build
 * blocks the event loop for ~3.2s. /api/server-info must answer in
 * milliseconds meanwhile. Real server, throwaway distribution.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const REPOS = ["shop", "billing", "search", "ledger"];
const GIT_DELAY_S = 0.4;
let tmp = "";
let port = 0;
let server: ChildProcess;

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

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-test-sources-"));
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
      [
        `name: ${n}`,
        "services:",
        "  api:",
        "    commands:",
        "      local:",
        '        up: "true"',
        "smoke:",
        "  api:",
        "    testDir: tests/smoke",
        '    testMatch: "**/*.spec.ts"',
        "    baseUrlKey: api",
        "    auth: []",
        "",
      ].join("\n"),
    );

  // Every `git rev-parse` is slow; the branch is main, the SHA abc1234.
  const realGit = fs.existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
  const shimDir = path.join(tmp, "shim");
  write(
    path.join(shimDir, "git"),
    [
      "#!/bin/sh",
      'case "$*" in',
      `  *"rev-parse --abbrev-ref HEAD"*) sleep ${GIT_DELAY_S}; echo main; exit 0 ;;`,
      `  *"rev-parse --short HEAD"*) sleep ${GIT_DELAY_S}; echo abc1234; exit 0 ;;`,
      "esac",
      `exec ${realGit} "$@"`,
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

describe("/api/test-sources does not block the server (issue 132)", () => {
  it("server-info answers quickly while the git reads are in flight", async () => {
    const sources = timed("/api/test-sources?pillar=smoke");
    // Let the request reach the server and start its git reads.
    await new Promise((r) => setTimeout(r, 150));
    const info = await timed("/api/server-info");
    const done = await sources;

    expect(done.status).toBe(200);
    const list = JSON.parse(done.body) as {
      repoName: string;
      branch: string | null;
      shortSha: string | null;
    }[];
    expect(list.map((s) => s.repoName).sort()).toEqual([...REPOS].sort());
    expect(list.every((s) => s.branch === "main")).toBe(true);
    expect(list.every((s) => s.shortSha === "abc1234")).toBe(true);
    // The git reads are slow ...
    expect(done.ms).toBeGreaterThanOrEqual(GIT_DELAY_S * 1000);
    // ... yet server-info is not stuck behind them.
    expect(info.status).toBe(200);
    expect(info.ms).toBeLessThan(300);
  }, 20_000);
});
