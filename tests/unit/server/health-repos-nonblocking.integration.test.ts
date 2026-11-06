/**
 * /api/health/stream and /api/workspaces/available-repos must not hold up
 * the server: /api/server-info stays under ~100ms while each runs.
 *
 * Both used to run git synchronously per repo: health (through manifest
 * resolution) asked `git config --get remote.origin.url` of every repo
 * without its own manifest, and available-repos asked `git remote get-url
 * origin` of every local checkout the catalog has no slug for. Here `git` is
 * a shim that makes those 400ms, so a synchronous pass over four repos
 * blocks the event loop for ~1.6s.
 *
 * The bound is 250ms (0.3.0-dev.39): one synchronous 400ms call cannot hide
 * under it, and a busy machine running the browser suites alongside took
 * 107ms against the old 100ms with nothing blocking.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  gitRepo,
  slowestProbeDuring,
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";

const BOUND_MS = 250;
const HELD = ["alpha", "beta", "gamma", "delta"];
const LOCAL = ["north", "south", "east", "west"];
let tmp = "";
let srv: SlowGitServer;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-health-repos-"));
  const root = path.join(tmp, "dist");
  const held = path.join(tmp, "held");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    `environments: [local]\nrepos_root: ${repos}\n`,
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    HELD.map((n) => `${n}:\n  gh: acme/acme-${n}\n`).join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...HELD.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(held, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  // Held repos: no manifest of their own. Den's copy is keyed by the origin
  // repo name (acme-<n>), not the folder name, so the origin lookup matters.
  for (const n of HELD) {
    gitRepo(path.join(held, n), `git@github.com:acme/acme-${n}.git`);
    write(
      path.join(root, "manifests", `acme-${n}.den.yml`),
      `name: ${n}\nservices:\n  ${n}:\n    commands:\n      local:\n        up: "true"\n`,
    );
  }
  // Local checkouts under repos_root, with manifests, unknown to the catalog.
  for (const n of LOCAL) {
    gitRepo(path.join(repos, n), `https://github.com/acme/${n}.git`);
    write(path.join(repos, n, ".den.yml"), `name: ${n}\nservices: {}\n`);
  }

  srv = await startSlowGitServer({
    tmp,
    root,
    slow: ["config --get remote.origin.url", "remote get-url origin"],
    delayS: 0.4,
  });
}, 40_000);

afterAll(async () => {
  await srv?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("server-info stays responsive", () => {
  it("while /api/health/stream runs its first cycle", async () => {
    const stream = srv.timed("/api/health/stream?env=local");
    const { worst, probes } = await slowestProbeDuring(srv, stream);
    const { status, body } = await stream;

    expect(status).toBe(200);
    // Every held repo resolved its manifest through its origin name.
    for (const n of HELD) expect(body).toContain(`"repo":"${n}"`);
    expect(body).toMatch(/"type":"done"/);
    expect(probes).toBeGreaterThan(0);
    expect(worst).toBeLessThan(BOUND_MS);
  }, 30_000);

  it("while /api/workspaces/available-repos runs", async () => {
    const before = srv.slowCalls();
    const repos = srv.timed("/api/workspaces/available-repos?refresh=1");
    const { worst } = await slowestProbeDuring(srv, repos, 20);
    const { status, body } = await repos;

    expect(status).toBe(200);
    const list = JSON.parse(body) as { name: string; gh: string | null }[];
    for (const n of LOCAL)
      expect(list.find((r) => r.name === n)?.gh).toBe(`acme/${n}`);
    // The slow lookups did run (the route is slow) ...
    expect(srv.slowCalls() - before).toBeGreaterThanOrEqual(LOCAL.length);
    // ... and server-info did not wait on them.
    expect(worst).toBeLessThan(BOUND_MS);
  }, 30_000);
});
