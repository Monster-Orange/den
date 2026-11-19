/**
 * PR 573's live check, run as the bed runs it (runLikeBed), against a real
 * server over a throwaway distribution with one repo: every clause passes.
 * ctx.fetch and ctx.api send the person's token, as the bed's do.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { denAuth } from "../server/helpers/den-auth.js";
import { startDenServer, stopServer } from "../../child-servers.js";

const ROOT = path.resolve(__dirname, "../../..");
let tmp = "";
let port = 0;
let server: ChildProcess;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-g573-")));
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
      "active: [north]",
      "focus: north",
      "workspaces:",
      "  north:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${repo}`,
      "",
    ].join("\n"),
  );
  write(
    path.join(repo, ".den.yml"),
    'name: shop\nservices:\n  shop:\n    commands:\n      local:\n        up: "true"\n',
  );
  const started = await startDenServer(
    path.join(ROOT, "node_modules", ".bin", "tsx"),
    [path.join(ROOT, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ROOT,
        DEN_HOME: path.join(tmp, "home"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 30_000 },
  );
  server = started.server;
  port = started.port;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runGate() {
  const js = `
    const g = await import("./gate/573.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const base = "http://localhost:" + process.env.G573_PORT;
    const auth = { authorization: process.env.G573_AUTH };
    const ctx = {
      notes: [], log(...a) { this.notes.push(a.join(" ")); },
      async sleep() {}, async until(fn) { return (await fn()) ? 0 : null; },
      async fetch(p, init = {}) {
        // A stream that never ends: what came in 3 s is the answer.
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 3000);
        const r = await fetch(base + p, { ...init, signal: ac.signal, headers: { ...auth, ...(init.headers || {}) } });
        const body = await r.text().catch(() => "");
        clearTimeout(t);
        return { status: r.status, headers: r.headers, body };
      },
      async api(p, init = {}) {
        const r = await this.fetch(p, init);
        return JSON.parse(r.body);
      },
    };
    const out = await runLikeBed("573.mjs", g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 90_000,
    env: {
      ...process.env,
      G573_PORT: String(port),
      G573_AUTH: denAuth(path.join(tmp, "home")).Authorization,
    },
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    rows?: {
      clause: string;
      ok: boolean | null;
      skip?: string;
      note?: string;
    }[];
    error?: string;
  };
}

describe("gate/573.mjs as the bed runs it, on a real server", () => {
  it("passes every clause", () => {
    const r = runGate();
    expect(r.error).toBeUndefined();
    expect(
      (r.rows ?? []).map((x) => [x.clause, x.ok, x.note ?? x.skip ?? ""]),
    ).toEqual(r.clauses.map((c) => [c, true, ""]));
  }, 120_000);
});
