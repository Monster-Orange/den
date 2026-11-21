/**
 * Issue 868 (tests first) on a real server: a test install with no GitHub
 * sign-in client (`web.github_client_id: ""`), reached from another
 * computer (through the edge, its client 203.0.113.7), shows the sign-in
 * methods it has and the fix, not only the CLI hint. An API caller still
 * gets today's 401 body and code; a caller on this machine is never told
 * it is stuck.
 *
 * A throwaway distribution with an edge block (org acme, tls none). No
 * code, cookie or token is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";
import { signedIn } from "./helpers/signed-in.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const EDGE = "den.acme.localhost";
let tmp = "";
let root = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;

interface Reply {
  status: number;
  type: string;
  body: string;
}
function call(p: string, headers: Record<string, string>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        path: p,
        method: "GET",
        agent: false,
        timeout: 20_000,
        setHost: false,
        headers: { host: `localhost:${port}`, ...headers },
      },
      (res) => {
        let out = "";
        res.on("data", (d: Buffer) => (out += d.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"] ?? ""),
            body: out,
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end();
  });
}
const nav = { "sec-fetch-site": "none", accept: "text/html" };
/** Another computer, through the edge (with its proof). */
const AWAY = { host: EDGE, "x-forwarded-for": "203.0.113.7", ...EDGE_PROOF };

interface Methods {
  github: string;
  setting: string;
  browser: boolean;
  terminal: string;
  remote: boolean;
  firstRun: boolean;
  stuck: boolean;
}
/** The signed-out page's data: what it was told about the methods. */
function methodsOf(r: Reply): Methods | undefined {
  const m =
    /<script type="application\/json" id="den-error">\s*([\s\S]*?)\s*<\/script>/.exec(
      r.body,
    );
  return m
    ? (JSON.parse(m[1]) as { signin?: { methods?: Methods } }).signin?.methods
    : undefined;
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-868-")));
  root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  const write = (f: string, c: string) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c);
  };
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  tls: none",
      "",
    ].join("\n"),
  );
  // An explicit empty client id: no Sign in with GitHub on this install.
  write(
    path.join(root, "config", "local", "user.yml"),
    'web:\n  github_client_id: ""\n',
  );
  writeTestEdgeProof(path.join(tmp, "edge-state"));
  const started = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: "0",
      },
    },
    { timeoutMs: 40_000 },
  );
  server = started.server;
  port = started.port;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 868: the sign-in page names the methods this install has", () => {
  it("from another computer, no GitHub client, nobody signed in: the list, stuck, and the setting to fix", async () => {
    const r = await call("/settings", { ...nav, ...AWAY });
    expect([r.status, r.type]).toEqual([
      401,
      expect.stringMatching(/text\/html/),
    ]);
    expect(r.body).toContain('"code":"signin_required"');
    expect(methodsOf(r)).toEqual({
      github: "no_client_id",
      setting: "web.github_client_id",
      browser: false,
      terminal: expect.stringMatching(/web login/),
      remote: true,
      firstRun: true,
      stuck: true,
    });
  });

  it("an API caller from another computer keeps today's 401: same code, same words, no page", async () => {
    const r = await call("/api/services", {
      ...AWAY,
      accept: "application/json",
      "sec-fetch-site": "same-origin",
    });
    expect([r.status, r.type]).toEqual([
      401,
      expect.stringMatching(/application\/json/),
    ]);
    const b = JSON.parse(r.body) as Record<string, unknown>;
    expect(Object.keys(b).sort()).toEqual(
      ["code", "error", "ok", "requestId", "scope"].sort(),
    );
    expect([b.ok, b.code, b.scope, b.error]).toEqual([
      false,
      "signin_required",
      "den",
      "Sign in to use Den: run `den web login` and open the link.",
    ]);
  });

  it("a caller that doesn't ask for HTML keeps the plain-text 401", async () => {
    const r = await call("/settings", { ...AWAY, accept: "*/*" });
    expect([r.status, r.type]).toEqual([401, "text/plain"]);
    expect(r.body).toMatch(/^Sign in to use Den: run `den web login`/);
  });

  it("on this machine: the list, never stuck", async () => {
    const r = await call("/signin?next=%2F", nav);
    expect(r.status).toBe(401);
    expect(methodsOf(r)).toMatchObject({
      github: "no_client_id",
      remote: false,
      stuck: false,
    });
  });

  it("once a person's browser is signed in, another computer can ask it: not stuck", async () => {
    await signedIn(stateDir, `http://localhost:${port}`);
    const r = await call("/settings", { ...nav, ...AWAY });
    expect(r.status).toBe(401);
    expect(methodsOf(r)).toMatchObject({
      browser: true,
      remote: true,
      firstRun: false,
      stuck: false,
    });
  });
});
