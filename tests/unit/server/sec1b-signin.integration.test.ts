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
import { spawnSync, type ChildProcess } from "child_process";
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
import { mintClaimCode } from "../../../src/shared/claim-code.js";
import {
  spawnServer,
  startDenServer,
  stopServer,
} from "../../child-servers.js";

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
/** The edge's X-Forwarded-For for a client on another machine (0.4.3). */
const AWAY = { "x-forwarded-for": "203.0.113.7" };
/** The edge's X-Forwarded-For for a browser on this machine (it attests loopback). */
const HERE = { "x-forwarded-for": "127.0.0.1" };
const cookieName = () => `den_session_${port}`;
/** The Set-Cookie line for the session cookie, or "". */
const setCookie = (r: Reply) =>
  ([] as string[])
    .concat(r.headers["set-cookie"] ?? [])
    .find((c) => c.startsWith(`${cookieName()}=`)) ?? "";
/** A 303's Location without its fragment (a sign-in's carries the approval key). */
const where = (r: Reply) => String(r.headers.location ?? "").split("#")[0];
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
  const started = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: serverEnv(root, path.join(tmp, "home"), 0),
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

describe("the login link", () => {
  it("a valid code: a session cookie (HttpOnly, SameSite=Strict, Path=/, no Secure on http) and a 303 to next", async () => {
    const r = await call(
      "GET",
      `/auth?c=${encodeURIComponent(code())}&next=${encodeURIComponent("/settings?x=1")}`,
      nav,
    );
    expect(r.status).toBe(303);
    expect(where(r)).toBe("/settings?x=1");
    expect(String(r.headers.location)).toMatch(/#ak=[A-Za-z0-9_-]{43}$/);
    const line = setCookie(r);
    expect(line.length).toBeGreaterThan(0);
    expect(flags(line)).toEqual(["httponly", "max-age", "path", "samesite"]);
    expect(line).toMatch(/; Path=\//);
    expect(line).toMatch(/; SameSite=Strict/);
    // A session never expires: the cookie lasts as long as a browser keeps
    // one (400 days), not the old 30-day absolute lifetime.
    expect(line).toMatch(/; Max-Age=34560000/);
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
    expect([r.status, where(r)]).toEqual([303, "/"]);
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

describe("the setup link (0.4.12: /auth?claim=)", () => {
  const claim = () => {
    const c = mintClaimCode(readWebSecret(stateDir)!);
    minted.push(c);
    return c;
  };
  /** The approval key in a sign-in 303's fragment, or "". */
  const keyOf = (r: Reply) =>
    /#ak=([A-Za-z0-9_-]{43})$/.exec(String(r.headers.location ?? ""))?.[1] ??
    "";

  it("opened once: a session cookie, a 303 to / with the approval key in the fragment and no claim, no referrer", async () => {
    const r = await call(
      "GET",
      `/auth?claim=${encodeURIComponent(claim())}`,
      nav,
    );
    expect(r.status).toBe(303);
    const loc = String(r.headers.location ?? "");
    expect(loc.startsWith("/#ak=")).toBe(true);
    expect(loc.includes("claim")).toBe(false);
    expect(keyOf(r).length).toBe(43);
    minted.push(keyOf(r));
    const line = setCookie(r);
    expect(flags(line)).toEqual(["httponly", "max-age", "path", "samesite"]);
    minted.push(line.split(";")[0].split("=")[1] ?? "");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["cache-control"]).toBe("no-store");
    // It is listed as claimed with a setup link.
    const list = json(await call("GET", "/api/web/sessions", bearer()));
    expect(
      (list.sessions as { via: string }[]).some((x) => x.via === "claim"),
    ).toBe(true);
  });

  it("opened again: no cookie, and a page that says it was used and offers the sign-in, never echoing the code", async () => {
    const c = claim();
    expect(
      (await call("GET", `/auth?claim=${encodeURIComponent(c)}`, nav)).status,
    ).toBe(303);
    const again = await call(
      "GET",
      `/auth?claim=${encodeURIComponent(c)}`,
      nav,
    );
    expect(again.status).toBe(401);
    expect(setCookie(again)).toBe("");
    expect(again.body).toContain("This setup link was used or has expired.");
    expect(again.body).toContain("someone else may have");
    expect(again.body.includes(c)).toBe(false);
    expect(again.body.includes(encodeURIComponent(c))).toBe(false);
  });

  it("a changed code, a login code, or junk: no cookie", async () => {
    const c = claim();
    const bad = c.slice(0, -2) + (c.endsWith("AA") ? "BB" : "AA");
    for (const q of [bad, code(), "nope", ""]) {
      const r = await call("GET", `/auth?claim=${encodeURIComponent(q)}`, nav);
      expect([r.status, setCookie(r)]).toEqual([401, ""]);
    }
  });

  it("an agent's token can't use one, and another site can't open one", async () => {
    const r = await call("GET", `/auth?claim=${encodeURIComponent(claim())}`, {
      ...nav,
      authorization: "Bearer den_at_not_a_real_token",
    });
    expect(setCookie(r)).toBe("");
    const x = await call("GET", `/auth?claim=${encodeURIComponent(claim())}`, {
      "sec-fetch-site": "cross-site",
    });
    expect([x.status, setCookie(x)]).toEqual([403, ""]);
  });

  it("end to end: the cookie and the CSRF token /api/session hands out are not enough to let a browser in; the approval key is", async () => {
    const r = await call(
      "GET",
      `/auth?claim=${encodeURIComponent(claim())}`,
      nav,
    );
    const key = keyOf(r);
    minted.push(key);
    const pair = setCookie(r).split(";")[0];
    minted.push(pair.split("=")[1] ?? "");
    const cookie = { cookie: pair };
    const sess = await sessionCsrf(cookie);
    // /api/session never returns the key.
    expect(JSON.stringify(sess).includes(key)).toBe(false);
    const page = {
      ...cookie,
      origin: `http://localhost:${port}`,
      "x-den-csrf": String(sess.csrf),
    };
    const body = JSON.stringify({ host: "nope.example" });
    // What a dev server on another localhost port could replay: refused.
    const without = await call("POST", "/api/web/pair", page, body);
    expect([without.status, json(without).code]).toEqual([
      403,
      "signin_to_approve",
    ]);
    // Anonymous loopback with the page's CSRF token (any agent's curl): refused.
    const anon = json(await call("GET", "/api/session"));
    const a = await call(
      "POST",
      "/api/web/pair",
      { origin: `http://localhost:${port}`, "x-den-csrf": String(anon.csrf) },
      body,
    );
    expect([a.status, json(a).code]).toEqual([403, "signin_to_approve"]);
    // With the key the page holds: past the gate (to the route's own answer).
    const withKey = await call(
      "POST",
      "/api/web/pair",
      { ...page, "x-den-approve-key": key },
      body,
    );
    expect(withKey.status).toBe(400);
    expect(json(withKey).code).toBe("unknown_host");
    // The person's own CLI (its bearer): past the gate too.
    const cli = await call("POST", "/api/web/pair", bearer(), body);
    expect(json(cli).code).toBe("unknown_host");
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
    const r = await sessionCsrf(AWAY, EDGE);
    expect(view(r)).toEqual({ csrf: null, actor: null, signedIn: false });
  });

  it("the edge from this machine (X-Forwarded-For loopback's): the start's token, as on loopback", async () => {
    expect(view(await sessionCsrf(HERE, EDGE))).toEqual({
      csrf: "<token>",
      actor: null,
      signedIn: false,
    });
  });

  it("SEC-2a: a client the edge can't place (no X-Forwarded-For) has no CSRF token until it signs in", async () => {
    expect(view(await sessionCsrf({}, EDGE))).toEqual({
      csrf: null,
      actor: null,
      signedIn: false,
    });
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

  it("shell-grade on loopback needs no sign-in (Ward, 2026-11-06): with Origin and the page's CSRF an agent start reaches the route", async () => {
    const csrf = String((await sessionCsrf({})).csrf);
    const r = await call(
      "POST",
      start,
      { origin: `http://localhost:${port}`, "x-den-csrf": csrf },
      startBody,
    );
    // Past the checks: whatever the route says (no such workspace here).
    expect([r.status, json(r).code === "signin_required"]).not.toEqual([
      401,
      true,
    ]);
    expect([401, 403].includes(r.status)).toBe(false);
    // The browser-session admin route too, from this server's own page.
    const list = await call("GET", "/api/web/sessions", {
      "sec-fetch-site": "same-origin",
    });
    expect(list.status).toBe(200);
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

  it("an edge Host for another machine with no session gets 401 even on read-only; with a session issued there it passes", async () => {
    for (const p of ["/api/settings", "/api/health", "/api/server-info"]) {
      const r = await call("GET", p, { host: EDGE, ...AWAY });
      expect([p, r.status, json(r).code]).toEqual([p, 401, "signin_required"]);
    }
    const page = await call("GET", "/", {
      host: EDGE,
      ...AWAY,
      accept: "text/html",
    });
    expect(page.status).toBe(401);
    expect(page.body).toContain('"code":"signin_required"');
    expect(page.body).toContain('data-api-off="1"');
    // Its command names the edge's origin (where the cookie must be set).
    expect(page.body).toContain(`den web login --origin http://${EDGE}`);
    expect(page.body).not.toMatch(/<input[^>]*type="password"/);
    // The page's scripts still load.
    expect(
      (await call("GET", "/shell.js", { host: EDGE, ...AWAY })).status,
    ).toBe(200);
    const c = await signIn({ host: EDGE, ...AWAY });
    expect(
      (await call("GET", "/api/settings", { host: EDGE, ...AWAY, ...c }))
        .status,
    ).toBe(200);
    expect(
      (
        await call("GET", "/", {
          host: EDGE,
          ...AWAY,
          accept: "text/html",
          ...c,
        })
      ).status,
    ).toBe(200);
  });

  it("the edge from this machine (0.4.3; the edge attests it): no sign-in on any route, shell-grade included; Origin and CSRF still apply", async () => {
    for (const p of ["/api/settings", "/api/server-info"]) {
      const r = await call("GET", p, { host: EDGE, ...HERE });
      expect([p, r.status]).toEqual([p, 200]);
    }
    const page = await call("GET", "/", {
      host: EDGE,
      accept: "text/html",
      ...HERE,
    });
    expect(page.status).toBe(200);
    const tok = String((await sessionCsrf(HERE, EDGE)).csrf);
    const ok = await call(
      "POST",
      start,
      { host: EDGE, origin: `http://${EDGE}`, "x-den-csrf": tok, ...HERE },
      startBody,
    );
    expect([401, 403].includes(ok.status)).toBe(false);
    const noCsrf = await call(
      "POST",
      start,
      { host: EDGE, origin: `http://${EDGE}`, ...HERE },
      startBody,
    );
    expect([noCsrf.status, json(noCsrf).code]).toEqual([403, "csrf"]);
  });

  it("/signin is read-only (§6b.3): on loopback it goes straight on to next, signed in or not; signed out through the edge it renders the signed-out page itself", async () => {
    for (const headers of [
      { ...nav },
      { ...nav, "sec-fetch-site": "cross-site" },
      { ...nav, host: `127.0.0.1:${port}` },
    ]) {
      const r = await call("GET", "/signin?next=%2Fsettings", headers);
      expect([
        headers.host ?? "localhost",
        r.status,
        r.headers.location,
      ]).toEqual([headers.host ?? "localhost", 303, "/settings"]);
    }
    const edge = await call("GET", "/signin?next=%2Fsettings", {
      ...nav,
      host: EDGE,
      ...AWAY,
    });
    expect(edge.status).toBe(401);
    expect(edge.body).toContain('"code":"signin_required"');
    expect(edge.body).toContain('"scope":"den"');
    expect(edge.body).toContain("web login");
    // SEC-2a: the Monster Orange Den app is the default client id, so Sign
    // in with GitHub is offered; with no owner linked yet, it says so.
    expect(edge.body).toContain('"github":{"state":"no_owner"');
    expect(edge.body).not.toMatch(/<input[^>]*type="password"/);
    expect(edge.body).not.toMatch(/<form/i);
    // Signed in: a same-origin `next` only.
    const c = await signIn();
    const evil = await call("GET", "/signin?next=%2F%2Fevil.example", {
      ...nav,
      ...c,
    });
    expect([evil.status, where(evil)]).toEqual([303, "/"]);
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
  it("`web login --no-wait` prints one link on stdout (localhost, /auth, a code) that signs a browser in once", async () => {
    const r = cli([
      "web",
      "login",
      "--no-wait",
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
    expect(r.stderr).toMatch(/within 5 minutes/);
    expect(r.stderr.includes(u.searchParams.get("c") ?? "\0")).toBe(false);
    const a = await call("GET", `${u.pathname}${u.search}`, nav);
    expect([a.status, where(a)]).toEqual([303, "/settings"]);
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
    // And (§6c.2) every agent token: none run here.
    expect(r.stdout).toMatch(
      /Revoked 0 agent tokens: a running agent must be restarted or resumed/,
    );
    expect(hash(readWebSecret(stateDir)!.toString("hex"))).not.toBe(oldSecret);
    expect(fs.statSync(path.join(stateDir, "web.secret")).mode & 0o777).toBe(
      0o600,
    );

    // Old cookies: signed out (no session on loopback, 401 on the edge).
    expect(view(await sessionCsrf(c)).signedIn).toBe(false);
    const edge = await call("GET", "/api/settings", {
      host: EDGE,
      ...AWAY,
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

describe("a plain-http LAN bind (DEN_BIND_HOST=0.0.0.0, web.allow_plain_http_remote)", () => {
  // Chromium sends a plain-http origin that isn't localhost no Sec-Fetch-*
  // headers, and a top-level navigation has no Origin: the link must still
  // sign in. The server is reached on localhost, with this machine's own
  // name as the Host (a LAN name, so beyond loopback).
  const name = os.hostname().toLowerCase();
  let lanDist = "";
  let lanHome = "";
  let lanPort = 0;
  let lan: ChildProcess | null = null;

  beforeAll(async () => {
    if (!name) return;
    lanDist = path.join(tmp, "lan");
    lanHome = path.join(tmp, "lan-home");
    write(path.join(lanDist, "den.yml"), "product:\n  name: den\n");
    write(path.join(lanDist, "config", "den.yml"), "environments: [local]\n");
    write(
      path.join(lanDist, "config", "local", "user.yml"),
      "web:\n  allow_plain_http_remote: true\n",
    );
    lanPort = await freePort();
    lan = spawnServer(
      TSX,
      [path.join(ENGINE, "src", "ui", "server", "index.ts")],
      {
        cwd: lanDist,
        env: {
          ...serverEnv(lanDist, lanHome, lanPort),
          DEN_BIND_HOST: "0.0.0.0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    lan.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
    lan.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
    const deadline = Date.now() + 40_000;
    for (;;) {
      try {
        const r = await call("GET", "/api/server-info", {}, undefined, lanPort);
        if (r.status === 200) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("LAN server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 60_000);
  afterAll(async () => {
    if (lan) await stopServer(lan);
  });

  it("a `web login --no-wait --origin http://<this machine>:<port>` link with no fetch-metadata headers: 303 and the cookie", async () => {
    if (!name) return;
    const r = spawnSync(
      TSX,
      [
        path.join(ENGINE, "src", "ui", "cli", "index.ts"),
        "web",
        "login",
        "--no-wait",
        "--port",
        String(lanPort),
        "--origin",
        `http://${name}:${lanPort}`,
      ],
      {
        cwd: lanDist,
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...serverEnv(lanDist, lanHome, lanPort), CI: "1" },
      },
    );
    expect(r.status).toBe(0);
    const link = r.stdout.trim();
    minted.push(link);
    const u = new URL(link);
    minted.push(u.searchParams.get("c") ?? "");
    expect([u.host, u.pathname]).toEqual([`${name}:${lanPort}`, "/auth"]);
    {
      const host = { host: u.host, accept: "text/html" };
      // A foreign page's request still can't use it.
      const cross = await call(
        "GET",
        `${u.pathname}${u.search}`,
        { ...host, "sec-fetch-site": "cross-site" },
        undefined,
        lanPort,
      );
      expect([cross.status, setCookie(cross)]).toEqual([403, ""]);
      const a = await call(
        "GET",
        `${u.pathname}${u.search}`,
        host,
        undefined,
        lanPort,
      );
      const line = ([] as string[])
        .concat(a.headers["set-cookie"] ?? [])
        .find((c) => c.startsWith(`den_session_${lanPort}=`));
      minted.push(line?.split(";")[0].split("=")[1] ?? "");
      expect([a.status, where(a), !!line]).toEqual([303, "/", true]);
    }
  }, 90_000);
});

describe("a plain-http bind to one LAN address (DEN_BIND_HOST=<LAN IPv4>)", () => {
  // `web up`'s readiness probe asks the bound address, which is beyond
  // loopback, so the server answers an unsigned probe 401 signin_required.
  // The probe carries the CLI's bearer, as `web sessions` does: `web up`
  // sees the running server as ready ("already running", exit 0) instead of
  // starting another and reporting "did not become ready".
  const lanV4 = Object.values(os.networkInterfaces())
    .flatMap((l) => l ?? [])
    .find((a) => a.family === "IPv4" && !a.internal)?.address;
  let v4Dist = "";
  let v4Home = "";
  let v4Port = 0;
  let v4: ChildProcess | null = null;

  /** Any answer from the server on the LAN address, or null. */
  function status(p: string): Promise<number | null> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          host: lanV4,
          port: v4Port,
          path: p,
          agent: false,
          timeout: 1_500,
          headers: { connection: "close" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? null));
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
    });
  }

  beforeAll(async () => {
    if (!lanV4) return;
    v4Dist = path.join(tmp, "lan-v4");
    v4Home = path.join(tmp, "lan-v4-home");
    write(path.join(v4Dist, "den.yml"), "product:\n  name: den\n");
    write(path.join(v4Dist, "config", "den.yml"), "environments: [local]\n");
    write(
      path.join(v4Dist, "config", "local", "user.yml"),
      "web:\n  allow_plain_http_remote: true\n",
    );
    v4Port = await freePort();
    v4 = spawnServer(
      TSX,
      [path.join(ENGINE, "src", "ui", "server", "index.ts")],
      {
        cwd: v4Dist,
        env: { ...serverEnv(v4Dist, v4Home, v4Port), DEN_BIND_HOST: lanV4 },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    v4.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
    v4.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
    const deadline = Date.now() + 40_000;
    while ((await status("/api/server-info")) === null) {
      if (Date.now() > deadline) throw new Error("LAN v4 server did not start");
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 60_000);
  afterAll(async () => {
    if (v4) await stopServer(v4);
  });

  it("an unsigned probe is refused there, and `web up` still calls the server running", async () => {
    if (!lanV4) return;
    expect(await status("/api/server-info")).toBe(401);
    const r = spawnSync(
      TSX,
      [
        path.join(ENGINE, "src", "ui", "cli", "index.ts"),
        "web",
        "up",
        "--port",
        String(v4Port),
      ],
      {
        cwd: v4Dist,
        encoding: "utf-8",
        timeout: 60_000,
        env: {
          ...serverEnv(v4Dist, v4Home, v4Port),
          DEN_BIND_HOST: lanV4,
          CI: "1",
        },
      },
    );
    expect(r.stdout).toContain(`already running at http://${lanV4}:${v4Port}`);
    expect(r.status).toBe(0);
  }, 90_000);
});

describe("refusing to start", () => {
  /**
   * Start a server on a fresh distribution: its exit code, or (with
   * `untilListening`) "listening" once it answers, then it is stopped.
   */
  async function start(
    name: string,
    opts: {
      env?: Record<string, string>;
      userYml?: string;
      untilListening?: boolean;
    },
  ): Promise<{ code: number | null | "listening"; out: string }> {
    const dist = path.join(tmp, name);
    write(path.join(dist, "den.yml"), "product:\n  name: den\n");
    write(path.join(dist, "config", "den.yml"), "environments: [local]\n");
    if (opts.userYml)
      write(path.join(dist, "config", "local", "user.yml"), opts.userYml);
    const p = await freePort();
    const child = spawnServer(
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
    const code = await new Promise<number | null | "listening">((resolve) => {
      const t = setTimeout(() => {
        void stopServer(child);
        resolve(null);
      }, 45_000);
      child.once("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
      if (opts.untilListening) {
        const poll = async (): Promise<void> => {
          if (child.exitCode !== null) return;
          try {
            if (
              (await call("GET", "/api/server-info", {}, undefined, p))
                .status === 200
            ) {
              clearTimeout(t);
              resolve("listening");
              return;
            }
          } catch {
            /* not up yet */
          }
          setTimeout(() => void poll(), 200);
        };
        void poll();
      }
    });
    await stopServer(child);
    return { code, out };
  }

  it("a non-loopback bind without HTTPS in front exits 1, saying why", async () => {
    const r = await start("bind", { env: { DEN_BIND_HOST: "0.0.0.0" } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Refusing to listen on 0\.0\.0\.0/);
    expect(r.out).toMatch(/clear text/);
    expect(r.out).toMatch(/web\.allow_plain_http_remote: true/);
  }, 60_000);

  it("an old web.session value (even a wrong one) never stops the start: it is ignored, with a warning", async () => {
    const r = await start("cfg", {
      userYml: "web:\n  session:\n    idle: forever\n",
      untilListening: true,
    });
    expect(r.code).toBe("listening");
    expect(r.out).toMatch(
      /web\.session\.idle \(config\/local\/user\.yml\): ignored\. A browser session never expires/,
    );
  }, 60_000);
});
