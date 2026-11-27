/**
 * SEC-1a (SEC-1 spec §3, §5, §7) on a real server: the Host allowlist, the
 * Origin and CSRF checks on every mutation, the person token, and
 * web.secret, which no HTTP response ever carries. A write needs a sign-in
 * on this machine too (0.4.71): a session or a bearer, then Origin and the
 * session's own CSRF token, so those checks are shown with a session.
 *
 * A throwaway distribution with an edge block (org acme, so Den's route is
 * den.acme.localhost); POST /api/settings is the harmless mutation (its
 * side effect is config/local/user.yml). No secret or token is printed:
 * bodies are searched for them, and a failure says only true or false.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import {
  cliAuthHeaders,
  readWebSecret,
} from "../../../src/shared/web/web-secret.js";
import { startDenServer, stopServer } from "../../child-servers.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";
import { signedIn, type SignedIn } from "./helpers/signed-in.js";
import { inTerminal } from "./helpers/in-terminal.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
let tmp = "";
let root = "";
let stateDir = "";
let userYml = "";
let port = 0;
let server: ChildProcess;
let serverLog: () => string = () => "";

interface Reply {
  status: number;
  type: string;
  body: string;
}
/** One request with exactly these headers (Host included). */
function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        path: p,
        method,
        agent: false,
        timeout: 15_000,
        setHost: false,
        headers: {
          host: `localhost:${port}`,
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
            type: String(res.headers["content-type"] ?? ""),
            body: out,
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(body);
  });
}
const json = (r: Reply) => JSON.parse(r.body) as Record<string, unknown>;
const bearer = (): Record<string, string> => {
  // The CLI's own helper, reading the server's state dir.
  const h = cliAuthHeaders(stateDir);
  return { authorization: h.Authorization ?? "" };
};
const settings = (headers: Record<string, string>, editor: string) =>
  call("POST", "/api/settings", headers, JSON.stringify({ editor }));
const editorNow = () =>
  fs.existsSync(userYml) ? fs.readFileSync(userYml, "utf-8") : "";
const origin = () => `http://localhost:${port}`;
let signed: SignedIn | null = null;
/** A signed-in browser of this server: its cookie and its session's CSRF token. */
async function session(): Promise<SignedIn> {
  signed ??= await signedIn(stateDir, origin());
  return signed;
}
const cookie = async () => ({ cookie: (await session()).cookie });

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-sec1a-")));
  root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
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
  userYml = path.join(root, "config", "local", "user.yml");
  // H1: the edge's proof, as the real edge sends it.
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
      },
    },
    { timeoutMs: 30_000 },
  );
  server = started.server;
  port = started.port;
  serverLog = started.out;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the Host allowlist (DNS rebinding)", () => {
  it.each([
    ["GET", "/", { accept: "text/html" }],
    ["GET", "/api/health", {}],
    ["POST", "/api/settings", {}],
  ] as const)("Host evil.example: %s %s is 421", async (m, p, h) => {
    const before = editorNow();
    const r = await call(
      m,
      p,
      { ...h, host: "evil.example", ...(m === "POST" ? bearer() : {}) },
      m === "POST" ? JSON.stringify({ editor: "rebound" }) : undefined,
    );
    expect(r.status).toBe(421);
    if (p.startsWith("/api/")) {
      expect(json(r)).toMatchObject({ ok: false, code: "misdirected" });
      expect(json(r).requestId).toMatch(/^[0-9a-f]{8}$/);
      expect(typeof json(r).error).toBe("string");
    } else {
      // The shell-frame error page, telling the page it is a 421.
      expect(r.type).toMatch(/text\/html/);
      expect(r.body).toContain('"status":421');
      expect(r.body).toContain("/shell.js");
    }
    expect(editorNow()).toBe(before);
  });

  it("the 421 page's own scripts still load (they hold no data)", async () => {
    const r = await call("GET", "/shell.js", { host: "evil.example" });
    expect(r.status).toBe(200);
    const api = await call("GET", "/api/server-info", { host: "evil.example" });
    expect(api.status).toBe(421);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "%s with the port is 200",
    async (name) => {
      for (const p of ["/api/health", "/api/server-info"]) {
        const r = await call("GET", p, { host: `${name}:${port}` });
        expect(r.status).toBe(200);
      }
      const page = await call("GET", "/verify", {
        host: `${name}:${port}`,
        accept: "text/html",
      });
      expect(page.status).toBe(200);
    },
  );

  it("the same name on another port is 421", async () => {
    const r = await call("GET", "/api/health", {
      host: `localhost:${port + 1}`,
    });
    expect(r.status).toBe(421);
  });

  it("the edge hostname that routes to Den passes the Host check (local when the edge attests this machine; for another, or one it can't place, it needs a sign-in)", async () => {
    const away = { "x-forwarded-for": "203.0.113.7", ...EDGE_PROOF };
    const here = { "x-forwarded-for": "127.0.0.1", ...EDGE_PROOF };
    for (const host of ["den.acme.localhost", "den.acme.localhost:443"]) {
      expect(
        (await call("GET", "/api/server-info", { host, ...here })).status,
      ).toBe(200);
      // H1: claiming this machine without the edge's proof (a container
      // on the edge's network), or with a wrong one: a sign-in.
      for (const proof of [{}, { "x-den-edge-proof": "00".repeat(32) }]) {
        const spoof = await call("GET", "/api/server-info", {
          host,
          "x-forwarded-for": "127.0.0.1",
          ...proof,
        });
        expect([spoof.status, json(spoof).code]).toEqual([
          401,
          "signin_required",
        ]);
      }
      // SEC-2a (0.4.5): one the edge can't place (no X-Forwarded-For).
      const unplaced = await call("GET", "/api/server-info", {
        host,
        ...EDGE_PROOF,
      });
      expect([unplaced.status, json(unplaced).code]).toEqual([
        401,
        "signin_required",
      ]);
      // Another machine: allowed, but signed in only (here the bearer).
      const anon = await call("GET", "/api/server-info", { host, ...away });
      expect([anon.status, json(anon).code]).toEqual([401, "signin_required"]);
      const r = await call("GET", "/api/server-info", {
        host,
        ...away,
        ...bearer(),
      });
      expect(r.status).toBe(200);
    }
    expect(
      (await call("GET", "/api/server-info", { host: "other.acme.localhost" }))
        .status,
    ).toBe(421);
  });
});

describe("UK-2: GET /requests/<id> is checked as /api is", () => {
  it("another machine signed out: 401 signin_required as JSON, never the sign-in page; signed in: its state", async () => {
    const host = "den.acme.localhost";
    const away = { "x-forwarded-for": "203.0.113.7", ...EDGE_PROOF };
    for (const p of ["/requests/req-0000001", "/api/requests/req-0000001"]) {
      const anon = await call("GET", p, { host, ...away });
      expect([p, anon.status, json(anon).code]).toEqual([
        p,
        401,
        "signin_required",
      ]);
      const r = await call("GET", p, { host, ...away, ...bearer() });
      expect([p, r.status, json(r)]).toEqual([
        p,
        200,
        { id: "req-0000001", state: "unknown" },
      ]);
    }
  });
});

describe("Origin, CSRF and the bearer on a mutation (POST /api/settings)", () => {
  it("signed in, another site's Origin: 403 origin_rejected, and nothing written", async () => {
    const before = editorNow();
    const r = await settings(
      { ...(await cookie()), origin: "http://evil.example" },
      "evil",
    );
    expect(r.status).toBe(403);
    expect(json(r)).toMatchObject({ ok: false, code: "origin_rejected" });
    expect(editorNow()).toBe(before);
  });

  it("signed in, an allowed Origin without X-Den-CSRF: 403 csrf, and nothing written", async () => {
    const before = editorNow();
    const r = await settings(
      { ...(await cookie()), origin: origin() },
      "nocsrf",
    );
    expect(r.status).toBe(403);
    expect(json(r)).toMatchObject({ ok: false, code: "csrf" });
    expect(editorNow()).toBe(before);
  });

  it("a write needs a sign-in on this machine too (0.4.71): with no session /api/session hands out no token, and the write is 401 signin_required", async () => {
    const before = editorNow();
    const me = await call("GET", "/api/session", {
      "sec-fetch-site": "same-origin",
    });
    expect(me.status).toBe(200);
    expect(json(me)).toMatchObject({ csrf: null, signedIn: false });
    expect(typeof json(me).reason).toBe("string");
    const r = await settings({ origin: origin(), "x-den-csrf": "" }, "anon");
    expect([r.status, json(r).code]).toEqual([401, "signin_required"]);
    expect(editorNow()).toBe(before);
  });

  it("signed in, an allowed Origin with that session's token reaches the route", async () => {
    const r = await settings((await session()).headers, "vim");
    expect(r.status).toBe(200);
    expect(editorNow()).toMatch(/editor: vim/);
  });

  it("another session's token is refused: 403 csrf", async () => {
    const before = editorNow();
    const other = await signedIn(stateDir, origin());
    const r = await settings(
      { ...(await session()).headers, "x-den-csrf": other.csrf },
      "swapped",
    );
    expect([r.status, json(r).code]).toEqual([403, "csrf"]);
    expect(editorNow()).toBe(before);
  });

  it("/api/session answers a same-origin caller only", async () => {
    const cross = await call("GET", "/api/session", {
      "sec-fetch-site": "cross-site",
    });
    expect(cross.status).toBe(403);
    expect(cross.body).not.toContain('csrf":');
    const other = await call("GET", "/api/session", {
      origin: "http://evil.example",
    });
    expect(other.status).toBe(403);
    expect(json(await call("GET", "/api/session"))).toMatchObject({
      actor: null,
    });
  });

  it("no Origin and no Authorization: 401 signin_required (a write needs a sign-in on this machine too, 0.4.71)", async () => {
    const before = editorNow();
    const r = await settings({}, "bare");
    expect(r.status).toBe(401);
    expect(json(r)).toMatchObject({ code: "signin_required" });
    expect(editorNow()).toBe(before);
  });

  it("signed in, no Origin and no Authorization: 403 origin_rejected", async () => {
    const before = editorNow();
    const r = await settings(await cookie(), "bare");
    expect(r.status).toBe(403);
    expect(json(r)).toMatchObject({ code: "origin_rejected" });
    expect(editorNow()).toBe(before);
  });

  it("no Origin with a valid bearer reaches the route", async () => {
    const r = await settings(bearer(), "nvim");
    expect(r.status).toBe(200);
    expect(editorNow()).toMatch(/editor: nvim/);
  });

  it("an invalid bearer: 401", async () => {
    const before = editorNow();
    const r = await settings(
      { authorization: "Bearer den_pt_not-the-token" },
      "x",
    );
    expect(r.status).toBe(401);
    expect(json(r)).toMatchObject({ ok: false, code: "unauthorized" });
    expect(editorNow()).toBe(before);
  });

  it("GETs and pages need nothing new on loopback", async () => {
    expect((await call("GET", "/api/settings")).status).toBe(200);
    expect(
      (await call("GET", "/api/settings", { origin: "http://evil.example" }))
        .status,
    ).toBe(200);
  });
});

describe("the audit actor comes from the credential", () => {
  const report = JSON.stringify({
    tool: "service_up",
    repo: "widget",
    reason: "test refusal",
  });
  const agent = { "x-den-actor": "agent", "x-den-mcp-client": "test" };
  const entries = async () =>
    json(await call("GET", "/api/activity?repo=widget")).entries as Record<
      string,
      unknown
    >[];

  it("a person token's call is person:<os user>; a header can't claim one, and its agent claim is kept unverified (SEC-1c)", async () => {
    const r = await call(
      "POST",
      "/api/activity",
      { ...agent, ...bearer() },
      report,
    );
    expect(r.status).toBe(200);
    const last = (await entries())[0];
    expect(last).toMatchObject({
      actor: "user",
      principal: `person:${os.userInfo().username}`,
      unverified: true,
      claimed: { client: "test" },
    });

    const b = await call(
      "POST",
      "/api/activity",
      {
        ...agent,
        ...(await session()).headers,
        "x-den-principal": "person:root",
      },
      report,
    );
    expect(b.status).toBe(200);
    // A signed-in page's call is the person's, from its session: never
    // the principal a header claims.
    expect((await entries())[0]).toMatchObject({
      principal: `person:${os.userInfo().username}`,
    });
  });
});

describe("a GET that runs something (shell-grade: /api/service/exec)", () => {
  const exec = (svc: string) =>
    `/api/service/exec?repo=gadget&service=${svc}&cmd=up&env=local`;
  const count = async (svc: string) =>
    (
      json(await call("GET", `/api/activity?address=gadget/${svc}`))
        .entries as unknown[]
    ).length;

  it("curl with no headers: 401 signin_required (a run needs a sign-in on this machine too, 0.4.71); signed in from another site: 403 cross_site; nothing runs", async () => {
    const bare = await call("GET", exec("curl"));
    expect(bare.status).toBe(401);
    expect(json(bare)).toMatchObject({ code: "signin_required" });
    const cross = await call("GET", exec("curl"), {
      ...(await cookie()),
      "sec-fetch-site": "cross-site",
    });
    expect(json(cross)).toMatchObject({ code: "cross_site" });
    expect(await count("curl")).toBe(0);
  });

  it("the CLI's bearer, or this server's own signed-in page, runs the route", async () => {
    expect((await call("GET", exec("cli"), bearer())).status).toBe(200);
    expect(await count("cli")).toBe(1);
    const page = await call("GET", exec("page"), {
      ...(await cookie()),
      "sec-fetch-site": "same-origin",
    });
    expect(page.status).toBe(200);
    expect(await count("page")).toBe(1);
  });
});

describe("web.secret", () => {
  it("is 0600 in the state dir, created at start", () => {
    const file = path.join(stateDir, "web.secret");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(file).size).toBe(32);
  });

  it("no HTTP response carries it or the person token", async () => {
    const secret = readWebSecret(stateDir)!;
    const token = cliAuthHeaders(stateDir).Authorization.replace(
      /^Bearer /,
      "",
    );
    const needles = [
      secret.toString("hex"),
      secret.toString("base64"),
      secret.toString("base64url"),
      token,
      token.slice("den_pt_".length),
    ];
    const pub = path.join(ENGINE, "src", "ui", "server", "public");
    const files = fs
      .readdirSync(pub, { recursive: true })
      .map(String)
      .filter((f) => fs.statSync(path.join(pub, f)).isFile());
    const paths = [
      "/",
      "/tests",
      "/verify",
      "/test-runs",
      "/services",
      "/environments",
      "/release",
      "/edge",
      "/logs",
      "/settings",
      "/graph",
      "/theme.css",
      "/api/server-info",
      "/api/settings",
      "/api/session",
      "/api/health",
      "/api/environments",
      "/api/themes",
      "/api/edge",
      "/api/changelog",
      "/no-such-page",
      // Traversal attempts at the state dir.
      "/report/../../home/.den/web.secret",
      "/report/%2e%2e/%2e%2e/home/.den/web.secret",
      "/reports/security/..%2f..%2f..%2fhome%2f.den%2fweb.secret",
      "/vendor/../../home/.den/web.secret",
      "/plugins/x/../../home/.den/web.secret",
      `/${path.relative("/", path.join(stateDir, "web.secret"))}`,
      ...files.map((f) => `/${f.split(path.sep).join("/")}`),
    ];
    let checked = 0;
    for (const p of paths) {
      for (const accept of ["text/html", "*/*"]) {
        const r = await call("GET", p, { accept, ...bearer() });
        for (const n of needles)
          expect([p, r.body.includes(n)]).toEqual([p, false]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    // Nor the server's own output (its log).
    for (const n of needles) expect(serverLog().includes(n)).toBe(false);
  }, 60_000);
});

describe("the CLI works with no setup", () => {
  const cliEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    DEN_ROOT: root,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_HOME: stateDir,
    HOME: path.join(tmp, "home"),
    DEN_NO_OPEN: "1",
    NO_COLOR: "1",
    CI: "1",
  });
  const cli = (args: string[]) =>
    spawnSync(
      TSX,
      [path.join(ENGINE, "src", "ui", "cli", "index.ts"), ...args],
      { cwd: root, encoding: "utf-8", timeout: 60_000, env: cliEnv() },
    );
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");

  it("`web token --print` prints the token the server accepts", async () => {
    // Sign-in: the token is printed only in a terminal.
    const r = await inTerminal(
      TSX,
      [
        path.join(ENGINE, "src", "ui", "cli", "index.ts"),
        "web",
        "token",
        "--print",
      ],
      { cwd: root, env: cliEnv() },
    ).done;
    expect(r.status).toBe(0);
    const printed = /den_pt_[A-Za-z0-9_-]{43}/.exec(r.text)?.[0] ?? "";
    expect(printed).toMatch(/^den_pt_[A-Za-z0-9_-]{43}$/);
    expect(r.text).toMatch(/grants your access/);
    // Not in a terminal: no token.
    const piped = cli(["web", "token", "--print"]);
    expect([piped.status, piped.stdout]).toEqual([1, ""]);
    expect(hash(`Bearer ${printed}`)).toBe(
      hash(cliAuthHeaders(stateDir).Authorization),
    );
    const ok = await settings({ authorization: `Bearer ${printed}` }, "emacs");
    expect(ok.status).toBe(200);
    expect(editorNow()).toMatch(/editor: emacs/);
  }, 90_000);

  it("an MCP tool that POSTs (manifest_validate with content) still works", () => {
    const r = cli([
      "mcp",
      "--port",
      String(port),
      "--call",
      "manifest_validate",
      JSON.stringify({ content: "services:\n  api: {}\n" }),
    ]);
    expect([
      r.status,
      /origin_rejected|csrf|unauthorized|\b40[13]\b/.test(
        `${r.stdout}${r.stderr}`,
      ),
    ]).toEqual([0, false]);
  }, 90_000);
});
