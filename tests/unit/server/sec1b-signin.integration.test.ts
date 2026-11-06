/**
 * SEC-1b (SEC-1 spec §2, §4) on a real server: the login link, the cookie,
 * the signed-out page, the route classes, `web login`, `web sessions` and
 * `web logout`, and the start-time refusals.
 *
 * A throwaway distribution with an edge block (org acme, tls none, so
 * Den's route is den.acme.localhost; HTTPS through it is simulated with
 * X-Forwarded-Proto). No code, cookie, token or secret is printed: bodies
 * and the server's output are searched for them, and a failure shows only
 * booleans, statuses and hashes.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  cliAuthHeaders,
  readWebSecret,
} from "../../../src/shared/web-secret.js";
import { mintLoginCode } from "../../../src/shared/web-session.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const EDGE = "den.acme.localhost";
let tmp = "";
let root = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
/** Every login code and cookie this suite made: none may reach the log. */
const minted: string[] = [];

interface Reply {
  status: number;
  type: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}
function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string,
  to = port,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port: to,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        setHost: false,
        headers: {
          host: `localhost:${to}`,
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
            headers: res.headers,
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
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const code = () => {
  const c = mintLoginCode(readWebSecret(stateDir)!);
  minted.push(c);
  return c;
};
const nav = { "sec-fetch-site": "none", accept: "text/html" };
const cookieName = () => `den_session_${port}`;
/** The Set-Cookie line for the session cookie, or "". */
const setCookie = (r: Reply) =>
  ([] as string[])
    .concat(r.headers["set-cookie"] ?? [])
    .find((c) => c.startsWith(`${cookieName()}=`)) ?? "";
const flags = (line: string) =>
  line
    .split(";")
    .slice(1)
    .map((f) => f.trim().split("=")[0].toLowerCase())
    .sort();

/** Sign in on `host` (localhost by default): the `cookie:` header to send. */
async function signIn(
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const r = await call("GET", `/auth?c=${encodeURIComponent(code())}`, {
    ...nav,
    ...extra,
  });
  expect(r.status).toBe(303);
  const line = setCookie(r);
  const pair = line.split(";")[0];
  minted.push(pair.split("=")[1] ?? "");
  return { cookie: pair };
}
async function sessionCsrf(c: Record<string, string>, host?: string) {
  const r = await call("GET", "/api/session", {
    "sec-fetch-site": "same-origin",
    ...c,
    ...(host ? { host } : {}),
  });
  return json(r);
}
/** /api/session's answer with its token masked: a failure never prints it. */
const view = (o: Record<string, unknown>) => ({
  csrf: typeof o.csrf === "string" ? "<token>" : o.csrf,
  actor: o.actor,
  signedIn: o.signedIn,
});
const bearer = () => ({
  authorization: cliAuthHeaders(stateDir).Authorization ?? "",
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
function serverEnv(dist: string, home: string, p: number) {
  return {
    ...process.env,
    DEN_ROOT: dist,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_EDGE_DIR: path.join(tmp, "edge-state"),
    DEN_HOME: path.join(home, ".den"),
    HOME: home,
    DEN_NO_OPEN: "1",
    NO_COLOR: "1",
    PORT: String(p),
  };
}
function cli(args: string[]) {
  return spawnSync(
    TSX,
    [path.join(ENGINE, "src", "ui", "cli", "index.ts"), ...args],
    {
      cwd: root,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...serverEnv(root, path.join(tmp, "home"), port),
        CI: "1",
      },
    },
  );
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-sec1b-")));
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
  port = await freePort();
  server = spawn(TSX, [path.join(ENGINE, "src", "ui", "server", "index.ts")], {
    cwd: root,
    env: serverEnv(root, path.join(tmp, "home"), port),
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await call("GET", "/api/server-info")).status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}, 60_000);

afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((r) => setTimeout(r, 5_000).unref()),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the login link", () => {
  it("a valid code: a session cookie (HttpOnly, SameSite=Strict, Path=/, no Secure on http) and a 303 to next", async () => {
    const r = await call(
      "GET",
      `/auth?c=${encodeURIComponent(code())}&next=${encodeURIComponent("/settings?x=1")}`,
      nav,
    );
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe("/settings?x=1");
    const line = setCookie(r);
    expect(line.length).toBeGreaterThan(0);
    expect(flags(line)).toEqual(["httponly", "max-age", "path", "samesite"]);
    expect(line).toMatch(/; Path=\//);
    expect(line).toMatch(/; SameSite=Strict/);
    expect(line).toMatch(/; Max-Age=2592000/);
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("is one-time: the second use gets the signed-out page, which never echoes the code", async () => {
    const c = code();
    const first = await call("GET", `/auth?c=${encodeURIComponent(c)}`, nav);
    expect(first.status).toBe(303);
    const again = await call("GET", `/auth?c=${encodeURIComponent(c)}`, nav);
    expect(again.status).toBe(401);
    expect(setCookie(again)).toBe("");
    expect(again.type).toMatch(/text\/html/);
    expect(again.body).toContain('"code":"signin_required"');
    expect(again.body).toContain('"expired":true');
    expect(again.body).toContain(
      "That sign-in link expired or was used. Run `den web login` for a new one.",
    );
    expect(again.body.includes(c)).toBe(false);
    expect(again.body.includes(encodeURIComponent(c))).toBe(false);
  });

  it("a tampered or junk code is refused the same way", async () => {
    const c = code();
    const bad = c.slice(0, -2) + (c.endsWith("AA") ? "BB" : "AA");
    for (const q of [bad, "nope", ""]) {
      const r = await call("GET", `/auth?c=${encodeURIComponent(q)}`, nav);
      expect([r.status, setCookie(r)]).toEqual([401, ""]);
    }
  });

  it.each([
    "//evil.example",
    "http://evil.example",
    "/\\evil.example",
    "https:evil.example",
  ])("next=%p goes to /", async (n) => {
    const r = await call(
      "GET",
      `/auth?c=${encodeURIComponent(code())}&next=${encodeURIComponent(n)}`,
      nav,
    );
    expect([r.status, r.headers.location]).toEqual([303, "/"]);
  });

  it("another site can't sign a browser in (a cross-site /auth is a mutating GET)", async () => {
    const r = await call("GET", `/auth?c=${encodeURIComponent(code())}`, {
      "sec-fetch-site": "cross-site",
    });
    expect([r.status, setCookie(r)]).toEqual([403, ""]);
  });

  it("Secure only over HTTPS from the edge: X-Forwarded-Proto counts on the edge Host only", async () => {
    const edge = await call("GET", `/auth?c=${encodeURIComponent(code())}`, {
      ...nav,
      host: EDGE,
      "x-forwarded-proto": "https",
    });
    expect(edge.status).toBe(303);
    expect(flags(setCookie(edge))).toContain("secure");
    // A spoofed header from loopback with a localhost Host: no Secure.
    const spoof = await call("GET", `/auth?c=${encodeURIComponent(code())}`, {
      ...nav,
      "x-forwarded-proto": "https",
    });
    expect(spoof.status).toBe(303);
    expect(flags(setCookie(spoof))).not.toContain("secure");
  });
});

describe("/api/session", () => {
  it("signed in: the session's own CSRF token and actor person-browser; signed out on loopback: SEC-1a's", async () => {
    const anon = await sessionCsrf({});
    expect(view(anon)).toEqual({
      csrf: "<token>",
      actor: null,
      signedIn: false,
    });
    expect(typeof anon.csrf).toBe("string");
    const c = await signIn();
    const mine = await sessionCsrf(c);
    expect(view(mine)).toEqual({
      csrf: "<token>",
      actor: "person-browser",
      signedIn: true,
    });
    expect(hash(String(mine.csrf))).not.toBe(hash(String(anon.csrf)));
  });

  it("beyond loopback without a session: no CSRF token at all", async () => {
    const r = await sessionCsrf({}, EDGE);
    expect(view(r)).toEqual({ csrf: null, actor: null, signedIn: false });
  });
});

describe("the route classes", () => {
  const start = "/api/workspaces/north/agents";
  const startBody = JSON.stringify({ persona: "planner" });

  it("loopback read-only is open without a session", async () => {
    for (const p of ["/api/settings", "/api/health", "/api/session"])
      expect([p, (await call("GET", p)).status]).toEqual([p, 200]);
    expect(
      (await call("GET", "/settings", { accept: "text/html" })).status,
    ).toBe(200);
  });

  it("shell-grade without a session: 401 signin_required (R26 JSON); an agent start says so in its own words", async () => {
    const csrf = String((await sessionCsrf({})).csrf);
    const r = await call(
      "POST",
      start,
      { origin: `http://localhost:${port}`, "x-den-csrf": csrf },
      startBody,
    );
    expect(r.status).toBe(401);
    expect(json(r)).toMatchObject({
      ok: false,
      code: "signin_required",
      scope: "agents",
      error: "Sign in to start agents: run `den web login` and open the link.",
    });
    expect(json(r).requestId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("shell-grade with a session, Origin and its CSRF reaches the route", async () => {
    const c = await signIn();
    const csrf = String((await sessionCsrf(c)).csrf);
    const r = await call(
      "POST",
      start,
      { origin: `http://localhost:${port}`, "x-den-csrf": csrf, ...c },
      startBody,
    );
    // Past the checks: whatever the route says (no such workspace here).
    expect([401, 403].includes(r.status)).toBe(false);
    // The start's token isn't the session's: refused.
    const start0 = await call(
      "POST",
      start,
      {
        origin: `http://localhost:${port}`,
        "x-den-csrf": String((await sessionCsrf({})).csrf),
        ...c,
      },
      startBody,
    );
    expect(json(start0).code).toBe("csrf");
  });

  it("the person's bearer passes shell-grade", async () => {
    const r = await call("POST", start, bearer(), startBody);
    expect([401, 403].includes(r.status)).toBe(false);
  });

  it("an edge Host with no session gets 401 even on read-only; with a session issued there it passes", async () => {
    for (const p of ["/api/settings", "/api/health", "/api/server-info"]) {
      const r = await call("GET", p, { host: EDGE });
      expect([p, r.status, json(r).code]).toEqual([p, 401, "signin_required"]);
    }
    const page = await call("GET", "/", { host: EDGE, accept: "text/html" });
    expect(page.status).toBe(401);
    expect(page.body).toContain('"code":"signin_required"');
    expect(page.body).toContain('data-api-off="1"');
    // Its command names the edge's origin (where the cookie must be set).
    expect(page.body).toContain(`den web login --origin http://${EDGE}`);
    expect(page.body).not.toMatch(/<input[^>]*type="password"/);
    // The page's scripts still load.
    expect((await call("GET", "/shell.js", { host: EDGE })).status).toBe(200);
    const c = await signIn({ host: EDGE });
    expect(
      (await call("GET", "/api/settings", { host: EDGE, ...c })).status,
    ).toBe(200);
    expect(
      (await call("GET", "/", { host: EDGE, accept: "text/html", ...c }))
        .status,
    ).toBe(200);
  });

  it("/signin is read-only (§6b.3): signed out it renders the signed-out page itself, on loopback and through the edge; a cross-site Sec-Fetch-Site doesn't stop it", async () => {
    for (const headers of [
      { ...nav },
      { ...nav, "sec-fetch-site": "cross-site" },
      { ...nav, host: EDGE },
    ]) {
      const r = await call("GET", "/signin?next=%2Fsettings", headers);
      expect([headers.host ?? "loopback", r.status]).toEqual([
        headers.host ?? "loopback",
        401,
      ]);
      expect(r.body).toContain('"code":"signin_required"');
      expect(r.body).toContain('"scope":"terminal"');
      expect(r.body).toContain("web login");
      expect(r.body).not.toMatch(/<input[^>]*type="password"/);
      expect(r.body).not.toMatch(/<form/i);
    }
    // Signed in: a same-origin `next` only.
    const c = await signIn();
    const evil = await call("GET", "/signin?next=%2F%2Fevil.example", {
      ...nav,
      ...c,
    });
    expect([evil.status, evil.headers.location]).toEqual([303, "/"]);
  });

  it("a shell-grade page on 127.0.0.1 without a session: the signed-out page, linking to the same path on localhost", async () => {
    const r = await call("GET", "/signin?next=%2Fsettings", {
      ...nav,
      host: `127.0.0.1:${port}`,
    });
    expect(r.status).toBe(401);
    expect(r.body).toContain('"scope":"terminal"');
    expect(r.body).toContain(
      `"localhost":"http://localhost:${port}/signin?next=%2Fsettings"`,
    );
    // Signed in on localhost, /signin goes on to next.
    const c = await signIn();
    const ok = await call("GET", "/signin?next=%2Fsettings", { ...nav, ...c });
    expect([ok.status, ok.headers.location]).toEqual([303, "/settings"]);
  });

  it("signing out ends the session and clears the cookie", async () => {
    const c = await signIn();
    const csrf = String((await sessionCsrf(c)).csrf);
    const r = await call(
      "POST",
      "/api/session/logout",
      { origin: `http://localhost:${port}`, "x-den-csrf": csrf, ...c },
      "{}",
    );
    expect(r.status).toBe(200);
    expect(setCookie(r)).toMatch(/Max-Age=0/);
    expect(view(await sessionCsrf(c)).signedIn).toBe(false);
  });
});

describe("the CLI: web login, web sessions, web logout", () => {
  it("`web login` prints one link on stdout (localhost, /auth, a code) that signs a browser in once", async () => {
    const r = cli([
      "web",
      "login",
      "--port",
      String(port),
      "--next",
      "/settings",
    ]);
    expect(r.status).toBe(0);
    const link = r.stdout.trim();
    minted.push(link);
    expect(link.split("\n").length).toBe(1);
    const u = new URL(link);
    expect([u.origin, u.pathname, u.searchParams.get("next")]).toEqual([
      `http://localhost:${port}`,
      "/auth",
      "/settings",
    ]);
    expect(r.stderr).toMatch(/within 60 seconds/);
    expect(r.stderr.includes(u.searchParams.get("c") ?? "\0")).toBe(false);
    const a = await call("GET", `${u.pathname}${u.search}`, nav);
    expect([a.status, a.headers.location]).toEqual([303, "/settings"]);
    const b = await call("GET", `${u.pathname}${u.search}`, nav);
    expect(b.status).toBe(401);
  }, 90_000);

  it("`web sessions` lists browsers (id prefix, created, last seen, host, user agent); `web logout <id>` ends one", async () => {
    await signIn({ "user-agent": "DemoBrowser/1.0 (sec1b)" });
    const list = cli(["web", "sessions", "--port", String(port), "--json"]);
    expect(list.status).toBe(0);
    const rows = JSON.parse(list.stdout) as Array<Record<string, string>>;
    const mine = rows.find((x) => x.userAgent === "DemoBrowser/1.0 (sec1b)");
    expect(mine).toMatchObject({ host: `localhost:${port}` });
    expect(mine!.id).toMatch(/^[0-9a-f]{8}$/);
    expect(Date.parse(mine!.createdAt)).toBeGreaterThan(0);
    expect(Date.parse(mine!.lastSeenAt)).toBeGreaterThan(0);
    const table = cli(["web", "sessions", "--port", String(port)]);
    expect(table.stdout).toMatch(
      /^ID\s+CREATED\s+LAST SEEN\s+HOST\s+USER AGENT/,
    );
    const out = cli(["web", "logout", mine!.id, "--port", String(port)]);
    expect([out.status, out.stdout.trim()]).toEqual([
      0,
      "Signed out 1 browser.",
    ]);
    const after = JSON.parse(
      cli(["web", "sessions", "--port", String(port), "--json"]).stdout,
    ) as Array<Record<string, string>>;
    expect(after.some((x) => x.id === mine!.id)).toBe(false);
  }, 120_000);

  it("`web logout --all` rotates web.secret: old cookies and the old person token get 401; the CLI keeps working", async () => {
    const c = await signIn();
    const edgeCookie = await signIn({ host: EDGE });
    const oldToken = bearer();
    const oldSecret = hash(readWebSecret(stateDir)!.toString("hex"));
    expect(
      (await call("GET", "/api/settings", { host: EDGE, ...edgeCookie }))
        .status,
    ).toBe(200);

    const r = cli(["web", "logout", "--all", "--port", String(port)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/web\.secret rotated/);
    expect(hash(readWebSecret(stateDir)!.toString("hex"))).not.toBe(oldSecret);
    expect(fs.statSync(path.join(stateDir, "web.secret")).mode & 0o777).toBe(
      0o600,
    );

    // Old cookies: signed out (shell-grade on loopback, anything on the edge).
    const page = await call("GET", "/signin", { ...nav, ...c });
    expect(page.status).toBe(401);
    const edge = await call("GET", "/api/settings", {
      host: EDGE,
      ...edgeCookie,
    });
    expect([edge.status, json(edge).code]).toEqual([401, "signin_required"]);
    // The old person token: 401.
    const stale = await call("GET", "/api/web/sessions", oldToken);
    expect([stale.status, json(stale).code]).toEqual([401, "unauthorized"]);
    // The CLI reads the new secret: it still works.
    const list = cli(["web", "sessions", "--port", String(port), "--json"]);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual([]);
    expect((await call("GET", "/api/web/sessions", bearer())).status).toBe(200);
  }, 120_000);
});

describe("nothing leaks", () => {
  it("no login code or cookie value is in the server's output (its log)", () => {
    expect(minted.length).toBeGreaterThan(5);
    for (const m of minted.filter(Boolean)) {
      expect(serverOut.includes(m)).toBe(false);
      expect(serverOut.includes(encodeURIComponent(m))).toBe(false);
    }
  });
});

describe("refusing to start", () => {
  async function start(
    name: string,
    opts: { env?: Record<string, string>; userYml?: string },
  ): Promise<{ code: number | null; out: string }> {
    const dist = path.join(tmp, name);
    write(path.join(dist, "den.yml"), "product:\n  name: den\n");
    write(path.join(dist, "config", "den.yml"), "environments: [local]\n");
    if (opts.userYml)
      write(path.join(dist, "config", "local", "user.yml"), opts.userYml);
    const p = await freePort();
    const child = spawn(
      TSX,
      [path.join(ENGINE, "src", "ui", "server", "index.ts")],
      {
        cwd: dist,
        env: {
          ...serverEnv(dist, path.join(tmp, `${name}-home`), p),
          ...opts.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 45_000);
      child.once("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    return { code, out };
  }

  it("a non-loopback bind without HTTPS in front exits 1, saying why", async () => {
    const r = await start("bind", { env: { DEN_BIND_HOST: "0.0.0.0" } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Refusing to listen on 0\.0\.0\.0/);
    expect(r.out).toMatch(/clear text/);
    expect(r.out).toMatch(/web\.allow_plain_http_remote: true/);
  }, 60_000);

  it("a wrong web.session value exits 1, naming the key", async () => {
    const r = await start("cfg", {
      userYml: "web:\n  session:\n    idle: forever\n",
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/web\.session\.idle must be a duration/);
  }, 60_000);
});
