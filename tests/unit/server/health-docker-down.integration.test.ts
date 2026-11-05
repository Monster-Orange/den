/**
 * Docker state unknown is not "not running" (0.2.5), for container checks
 * as for Den's compose checks: when `docker ps` fails, both are `ok: null`
 * with the reason in `error`, and stay so cycle after cycle (never "twice in
 * a row" down). `<cli> status` does not call them down either.
 *
 * Real web server, throwaway distribution: one compose repo and one repo of
 * container checks, and a `docker` that always fails as a stopped daemon
 * does.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import {
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";

const ENGINE = path.resolve(__dirname, "../../..");
const DAEMON_DOWN =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

let tmp = "";
let srv: SlowGitServer;

interface Result {
  repo: string;
  service: string;
  ok: boolean | null;
  pending?: boolean;
  error?: string;
}

function cycle(port: number): Promise<Result[]> {
  return new Promise((resolve, reject) => {
    const results: Result[] = [];
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health/stream?refresh=1",
        agent: false,
        timeout: 60_000,
      },
      (res) => {
        let buf = "";
        res.on("data", (d: Buffer) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const msg = JSON.parse(buf.slice(0, i).replace(/^data: /, "")) as {
              type: string;
              result?: Result;
            };
            buf = buf.slice(i + 2);
            if (msg.type === "result" && msg.result) results.push(msg.result);
          }
        });
        res.on("end", () => resolve(results));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("stream timeout")));
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-docker-down-"));
  const root = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nedge:\n  org: acme\n  domain: acme.localhost\n",
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "alpha:\n  gh: acme/alpha\ndelta:\n  gh: acme/delta\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [default]",
      "focus: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...["alpha", "delta"].flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "alpha", ".den.yml"),
    "name: alpha\nentrypoint: app\ncompose:\n  name: alpha\nservices:\n  app: {}\n",
  );
  write(path.join(repos, "alpha", "docker-compose.yml"), "services: {}\n");
  write(
    path.join(repos, "delta", ".den.yml"),
    [
      "name: delta",
      "services:",
      "  db:",
      "    health: { local: { type: container, project: alpha-main, service: db } }",
      "  cache:",
      "    health: { local: { type: container, container_name: acme-cache } }",
      "",
    ].join("\n"),
  );
  // A docker whose daemon is down: every call fails at once.
  write(
    path.join(tmp, "shim", "docker"),
    `#!/bin/sh\necho ${JSON.stringify(DAEMON_DOWN)} >&2\nexit 1\n`,
    0o755,
  );
  srv = await startSlowGitServer({ tmp, root, slow: [], delayS: 0 });
}, 180_000);

afterAll(async () => {
  await srv?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("docker not answering at all", () => {
  it("two cycles in a row: container checks stay unknown (ok null), as compose checks do", async () => {
    const cycles = [await cycle(srv.port), await cycle(srv.port)];
    // Both cycles first: a repeat must not turn unknown into down.
    expect(
      cycles.map((rs) =>
        Object.fromEntries(rs.map((r) => [`${r.repo}/${r.service}`, r.ok])),
      ),
    ).toEqual([
      { "alpha/app": null, "delta/db": null, "delta/cache": null },
      { "alpha/app": null, "delta/db": null, "delta/cache": null },
    ]);
    for (const r of cycles.flat()) {
      expect(r.pending).toBeUndefined();
      expect(r.error).toContain("container state unknown");
      expect(r.error).toContain("Cannot connect to the Docker daemon");
    }
  }, 180_000);

  it("<cli> status: not down", () => {
    const r = spawnSync(
      path.join(ENGINE, "bin", "den"),
      ["status", "--verbose"],
      {
        cwd: path.join(tmp, "den"),
        encoding: "utf-8",
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `${path.join(tmp, "shim")}:${process.env.PATH ?? ""}`,
          DEN_ROOT: path.join(tmp, "den"),
          DEN_HOME: path.join(tmp, "home"),
          DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
          NO_COLOR: "1",
          FORCE_COLOR: "0",
        },
      },
    );
    expect(r.status).toBe(0);
    for (const svc of ["delta/db ", "delta/cache "]) {
      const line = r.stdout.split("\n").find((l) => l.includes(svc));
      expect(line).toBeDefined();
      expect(line).toContain("● pending");
      expect(line).not.toContain("down");
    }
  }, 180_000);
});
