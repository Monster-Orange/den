/**
 * Where the session cookie lives, on a real server. Browsers share a
 * host's cookies across its ports, so a session cookie on localhost
 * reaches every other app the person opens on localhost. Once Den's own
 * named https address (web.url, through the edge) works, the session
 * lives only there:
 *
 *  - before it is known to work, the loopback sign-in works as before
 *    (an install with no working https address is never locked out);
 *  - on the named address: a `__Host-` cookie, host-only, Secure, Path=/;
 *  - then a loopback /auth or /signin sends the browser to the named
 *    address (a 303, no cookie, the one-time code unspent);
 *  - a loopback session cookie no longer counts: a write is 401
 *    signin_required, and GET /api/session hands it no CSRF token;
 *  - the CLI's bearer on loopback works; a plain read there stays open;
 *  - the shared test helper signs in on the named address.
 *
 * The edge is modelled with its headers (helpers/edge-proof.ts); the edge
 * config is tls none, so the server's own check of the address can't
 * reach it: what proves the address works is the edge's https request.
 * No code, cookie or token is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import {
  cliAuthHeaders,
  readWebSecret,
} from "../../../src/shared/web-secret.js";
import { mintLoginCode } from "../../../src/shared/web-session.js";
import { startDenServer, stopServer } from "../../child-servers.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";
import { signedIn } from "./helpers/signed-in.js";

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
let server: ChildProcess;

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}
function call(
  method: string,
  p: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "localhost",
        port,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        setHost: false,
        headers: {
          ...headers,
          ...(body !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              }
            : {}),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (d: Buffer) => (out += d.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: out,
            headers: res.headers,
          }),
        );
      },
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error(`timeout: ${p}`)));
    r.end(body);
  });
}
const local = () => ({ host: `localhost:${port}` });
const named = () => ({ host: NAMED, ...EDGE });
const nav = { "sec-fetch-site": "none", accept: "text/html" };
const code = () => mintLoginCode(readWebSecret(stateDir)!);
const cookies = (r: Reply) =>
  ([] as string[]).concat(r.headers["set-cookie"] ?? []);
const sessionLine = (r: Reply) =>
  cookies(r).find((c) => /^(__Host-)?den_session_\d+=[^;]+/.test(c)) ?? "";
const codeOf = (r: Reply) => {
  try {
    return (JSON.parse(r.body) as { code?: string }).code ?? null;
  } catch {
    return null;
  }
};
const flags = (line: string) =>
  line
    .split(";")
    .slice(1)
    .map((f) => f.trim().split("=")[0].toLowerCase())
    .sort();
/** A write a signed-in page makes (its Origin and CSRF), on `host`. */
const WRITE = {
  method: "POST",
  path: "/api/settings",
  body: '{"path":"web.login_link_ttl","value":"60s"}',
};

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** The loopback session made before the named address was known to work. */
let loopCookie = "";
let loopCsrf = "";

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-session-host-")),
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
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
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
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("before the named address is known to work (no lockout)", () => {
  it("the loopback sign-in gives a host-only cookie, and its session makes changes", async () => {
    const r = await call("GET", `/auth?c=${encodeURIComponent(code())}`, {
      ...local(),
      ...nav,
    });
    expect(r.status).toBe(303);
    const line = sessionLine(r);
    expect(line.startsWith(`den_session_${port}=`)).toBe(true);
    expect(line.toLowerCase()).not.toContain("domain=");
    loopCookie = line.split(";")[0];
    const me = await call("GET", "/api/session", {
      ...local(),
      "sec-fetch-site": "same-origin",
      cookie: loopCookie,
    });
    loopCsrf = (JSON.parse(me.body) as { csrf: string }).csrf;
    expect(typeof loopCsrf).toBe("string");
    const w = await call(
      WRITE.method,
      WRITE.path,
      {
        ...local(),
        origin: `http://localhost:${port}`,
        "sec-fetch-site": "same-origin",
        cookie: loopCookie,
        "x-den-csrf": loopCsrf,
      },
      WRITE.body,
    );
    expect(codeOf(w)).not.toBe("signin_required");
  });
});

describe("on the named https address", () => {
  it("the sign-in sets a __Host- cookie: host-only, Secure, Path=/", async () => {
    const r = await call("GET", `/auth?c=${encodeURIComponent(code())}`, {
      ...named(),
      ...nav,
    });
    expect(r.status).toBe(303);
    const line = sessionLine(r);
    expect(line.startsWith(`__Host-den_session_${port}=`)).toBe(true);
    expect(flags(line)).toEqual([
      "httponly",
      "max-age",
      "path",
      "samesite",
      "secure",
    ]);
    expect(line).toMatch(/; Path=\/;/);
  });

  it("the shared helper signs in there, and its session makes changes", async () => {
    const s = await signedIn(stateDir, `http://localhost:${port}`, {
      host: NAMED,
      edge: EDGE,
    });
    expect(s.name).toBe(`__Host-den_session_${port}`);
    expect(s.csrf.length).toBeGreaterThan(0);
    const w = await call(
      WRITE.method,
      WRITE.path,
      { ...s.headers, "sec-fetch-site": "same-origin" },
      WRITE.body,
    );
    expect(codeOf(w)).not.toBe("signin_required");
    expect(w.status).not.toBe(403);
  });
});

describe("once it works: no session on a loopback name", () => {
  it("a loopback /auth goes to the named address: a 303, no cookie, the code unspent", async () => {
    const c = code();
    const q = `/auth?c=${encodeURIComponent(c)}&next=${encodeURIComponent("/settings")}`;
    const r = await call("GET", q, { ...local(), ...nav });
    // Compared, never shown: the location carries the one-time code.
    expect([
      r.status,
      String(r.headers.location) === `https://${NAMED}${q}`,
      sessionLine(r),
    ]).toEqual([303, true, ""]);
    // The same link, on the named address: it signs in there.
    const there = await call("GET", q, { ...named(), ...nav });
    expect(there.status).toBe(303);
    expect(sessionLine(there).startsWith("__Host-")).toBe(true);
  });

  it("a loopback /signin goes to the named address", async () => {
    const r = await call("GET", "/signin?next=%2F", { ...local(), ...nav });
    expect(r.status).toBe(303);
    expect(String(r.headers.location)).toBe(`https://${NAMED}/signin?next=%2F`);
  });

  it("the loopback session no longer counts: a write is 401 signin_required", async () => {
    const w = await call(
      WRITE.method,
      WRITE.path,
      {
        ...local(),
        origin: `http://localhost:${port}`,
        "sec-fetch-site": "same-origin",
        cookie: loopCookie,
        "x-den-csrf": loopCsrf,
      },
      WRITE.body,
    );
    expect([w.status, codeOf(w)]).toEqual([401, "signin_required"]);
  });

  it("GET /api/session on loopback hands that cookie no CSRF token", async () => {
    const me = await call("GET", "/api/session", {
      ...local(),
      "sec-fetch-site": "same-origin",
      cookie: loopCookie,
    });
    expect(me.status).toBe(200);
    const b = JSON.parse(me.body) as { csrf: unknown; signedIn: unknown };
    expect([b.signedIn === true, typeof b.csrf === "string"]).toEqual([
      false,
      false,
    ]);
  });

  it("the CLI's bearer on loopback works as before", async () => {
    const w = await call(
      WRITE.method,
      WRITE.path,
      {
        ...local(),
        authorization: cliAuthHeaders(stateDir).Authorization ?? "",
      },
      WRITE.body,
    );
    expect(codeOf(w)).not.toBe("signin_required");
    expect(w.status).not.toBe(401);
  });

  it("a plain read on loopback stays open", async () => {
    const r = await call("GET", "/api/settings", local());
    expect(r.status).toBe(200);
  });
});
