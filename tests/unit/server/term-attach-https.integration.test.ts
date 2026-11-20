/**
 * Terminal attach on Den's named https address, on a real server.
 *
 * The pane opens `wss://<address>/api/sessions/<id>/io` with the
 * subprotocols ["den.io", "den.csrf.<token>"]. Through the edge, a
 * WebSocket upgrade over TLS arrives with X-Forwarded-Proto `wss` (the
 * edge's forwarded headers say ws/wss for an upgrade, never http/https).
 * The upgrade is still over https: the session the page signed in with
 * there must count for it, as it does for the page's own requests. The
 * guard passing is what this checks; with no session host running, the
 * io route itself then answers that there is no such session.
 *
 * An upgrade refused for want of a sign-in leaves a trace: an audit row
 * (the route's template, the status and the code, never the cookie) and a
 * WS line on stderr, which is web.log even when the server runs --silent.
 *
 * The edge is modelled with its headers (helpers/edge-proof.ts). No code,
 * cookie or token is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { startDenServer, stopServer } from "../../child-servers.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";
import { signedIn, type SignedIn } from "./helpers/signed-in.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const NAMED = "den.acme.test";
/** What the edge adds for a browser on this machine, over https. */
const EDGE = {
  ...EDGE_PROOF,
  "x-forwarded-for": "127.0.0.1",
  "x-forwarded-proto": "https",
};
let tmp = "";
let stateDir = "";
let port = 0;
let out: () => string = () => "";
let server: ChildProcess;
let s: SignedIn;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

interface UpgradeReply {
  status: number;
  code: string | null;
}

/** The pane's upgrade, through the edge's headers, on the named Host. */
function attach(headers: Record<string, string>): Promise<UpgradeReply> {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: "localhost",
      port,
      path: "/api/sessions/no-such-session/io",
      method: "GET",
      agent: false,
      timeout: 20_000,
      setHost: false,
      headers: {
        host: NAMED,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        origin: `https://${NAMED}`,
        ...headers,
      },
    });
    r.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, code: null });
    });
    r.on("response", (res) => {
      let out = "";
      res.on("data", (d: Buffer) => (out += d.toString()));
      res.on("end", () => {
        let code: string | null = null;
        try {
          code = (JSON.parse(out) as { code?: string }).code ?? null;
        } catch {
          /* no JSON */
        }
        resolve({ status: res.statusCode ?? 0, code });
      });
    });
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error("timeout: upgrade")));
    r.end();
  });
}

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-term-attach-")),
  );
  const root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  stateDir = path.join(home, ".den");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.test",
      "  tls: none",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "user.yml"),
    [
      "web:",
      `  url: https://${NAMED}`,
      "  address_check_cache_seconds: 3600",
      "  address_check_timeout_seconds: 1",
      "  address_check_retries: 0",
      "",
    ].join("\n"),
  );
  writeTestEdgeProof(path.join(tmp, "edge-state"));
  const started = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts"), "--silent"],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: stateDir,
        HOME: home,
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: "0",
      },
    },
    { timeoutMs: 40_000 },
  );
  server = started.server;
  port = started.port;
  out = started.out;
  // Signed in on the named address: the address is proven, the session
  // lives there, under the __Host- cookie.
  s = await signedIn(stateDir, `http://localhost:${port}`, {
    host: NAMED,
    edge: EDGE,
  });
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const io = () => ({
  cookie: s.cookie,
  "sec-websocket-protocol": `den.io, den.csrf.${s.csrf}`,
});

describe("terminal attach on the named https address", () => {
  it("the session is under the __Host- cookie there", () => {
    expect(s.name).toBe(`__Host-den_session_${port}`);
    expect(s.csrf.length).toBeGreaterThan(0);
  });

  it("an upgrade through the edge as wss: the session counts (past sign-in)", async () => {
    const r = await attach({
      ...EDGE,
      "x-forwarded-proto": "wss",
      ...io(),
    });
    expect(r.code).not.toBe("signin_required");
    expect(r.code).not.toBe("csrf");
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  it("the same as https: the session counts (past sign-in)", async () => {
    const r = await attach({ ...EDGE, ...io() });
    expect(r.code).not.toBe("signin_required");
    expect(r.status).not.toBe(401);
  });

  it("wss without the edge's proof is not https: the session doesn't count", async () => {
    const { "x-den-edge-proof": _p, ...noProof } = EDGE;
    void _p;
    const r = await attach({
      ...noProof,
      "x-forwarded-proto": "wss",
      ...io(),
    });
    expect(r.status).toBe(401);
  });

  it("with no cookie, an upgrade is 401 (the guard is still there)", async () => {
    const r = await attach({
      ...EDGE,
      "x-forwarded-proto": "wss",
      "sec-websocket-protocol": `den.io, den.csrf.${s.csrf}`,
    });
    expect(r.status).toBe(401);
    expect(r.code).toBe("signin_required");
  });
});

describe("an upgrade refused for want of a sign-in leaves a trace", () => {
  const rows = (): Record<string, unknown>[] => {
    let text = "";
    try {
      text = fs.readFileSync(path.join(stateDir, "audit.jsonl"), "utf8");
    } catch {
      return [];
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  const traced = (r: Record<string, unknown>) =>
    r.reason === "signin_required" &&
    r.outcome === "refused" &&
    String(r.detail).includes("/api/sessions/:id/io");

  it("an audit row: the route's template, the status and the code; never the cookie", async () => {
    const before = rows().filter(traced).length;
    const r = await attach({
      ...EDGE,
      cookie: `den_session_${port}=not-a-session`,
      "sec-websocket-protocol": `den.io, den.csrf.${s.csrf}`,
    });
    expect(r.status).toBe(401);
    const after = rows().filter(traced);
    expect(after.length).toBe(before + 1);
    const row = after[after.length - 1];
    expect(String(row.detail)).toContain("401");
    expect(String(row.detail)).not.toContain("no-such-session");
    const all = JSON.stringify(rows());
    expect(all).not.toContain("not-a-session");
    expect(all).not.toContain(s.value);
  });

  it("a WS line on stderr, even with --silent", async () => {
    await attach({ ...EDGE, "sec-websocket-protocol": "den.io" });
    const lines = out()
      .split("\n")
      .filter((l) =>
        /WS .*\/api\/sessions\/:id\/io.*401.*signin_required/.test(l),
      );
    expect(lines.length).toBeGreaterThan(0);
    expect(out()).not.toContain(s.value);
  });
});
