/**
 * SEC-2a on a real server, with a fake GitHub on localhost
 * (DEN_TEST_GITHUB_URL; never github.com) and `web.github_client_id` in
 * user.yml:
 *  - through the edge, a client Den can't place gets the signed-out page,
 *    which offers Sign in with GitHub (or says to link an owner first);
 *  - the owner is linked on localhost (shell-grade, no sign-in there);
 *  - the owner's GitHub sign-in sets the never-expiring session cookie,
 *    once, and records the device; another account is refused by name;
 *  - Settings › Access's routes: the devices (with Revoke), the owner,
 *    Pair a device (a one-time link for an edge hostname);
 *  - at most 3 device flows pending at once.
 *
 * A throwaway distribution with an edge block (org acme, tls none:
 * den.acme.localhost). No code, token or cookie is printed: bodies and the
 * server's output are searched for them, and a failure shows booleans.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { cliAuthHeaders } from "../../../src/shared/web-secret.js";
import { spawnServer, stopServer } from "../../child-servers.js";
import { startFakeGithub, type FakeGithub } from "./helpers/fake-github.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const EDGE = "den.acme.localhost";
const OWNER = { id: 4242, login: "octo-owner" };
const OTHER = { id: 777, login: "someone-else" };
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
let gh: FakeGithub;
/** Every cookie and link this suite saw: none may reach the server's log. */
const secrets: string[] = [];

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}
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
        timeout: 20_000,
        setHost: false,
        headers: {
          host: `localhost:${port}`,
          connection: "close",
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
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(body);
  });
}
const json = (r: Reply) => JSON.parse(r.body) as Record<string, unknown>;
const cookieOf = (r: Reply) => {
  const line =
    ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith(`den_session_${port}=`)) ?? "";
  const pair = line.split(";")[0];
  if (pair) secrets.push(pair.split("=")[1] ?? "");
  return pair;
};
/** The edge, for a browser it can't place (no X-Forwarded-For). */
const edge = (extra: Record<string, string> = {}) => ({
  host: EDGE,
  origin: `http://${EDGE}`,
  "sec-fetch-site": "same-origin",
  ...extra,
});
const bearer = () => ({
  authorization: cliAuthHeaders(stateDir).Authorization ?? "",
});
async function localCsrf(): Promise<Record<string, string>> {
  const s = json(
    await call("GET", "/api/session", { "sec-fetch-site": "same-origin" }),
  );
  return {
    origin: `http://localhost:${port}`,
    "x-den-csrf": String(s.csrf),
    "sec-fetch-site": "same-origin",
  };
}
/** Poll `p` (the server's view of a flow) until it isn't pending. */
async function settle(
  p: string,
  headers: Record<string, string>,
): Promise<Reply> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const r = await call("GET", p, headers);
    if (r.status !== 200 || json(r).state !== "pending") return r;
    if (Date.now() > deadline) throw new Error(`still pending: ${p}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}
const lastCode = () => gh.codes[gh.codes.length - 1].userCode;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

beforeAll(async () => {
  gh = await startFakeGithub({ interval: 0 });
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-sec2a-")));
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
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
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    "web:\n  github_client_id: Iv23liAcmeTest\n",
  );
  port = await freePort();
  server = spawnServer(
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
        PORT: String(port),
        DEN_TEST_GITHUB_URL: gh.url,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  await stopServer(server);
  await gh.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("before an owner is linked", () => {
  it("the edge, for a client Den can't place, is the signed-out page; it says to link an owner on the machine", async () => {
    const r = await call("GET", "/settings", {
      host: EDGE,
      "sec-fetch-site": "none",
      accept: "text/html",
    });
    expect(r.status).toBe(401);
    expect(r.body).toContain('"code":"signin_required"');
    // The command that runs on this server: `den`, or its absolute path.
    expect(r.body).toMatch(
      /"github":\{"state":"no_owner","owner":"(den|\/[^"]*\/bin\/den) web owner link","learnMore":"https:\/\/github\.com\/Monster-Orange\/den\/blob\/main\/docs\/distributions\.md#signing-in-with-github"\}/,
    );
  });

  it("starting a GitHub sign-in says the same, and asks GitHub nothing", async () => {
    const before = gh.requests.length;
    const r = await call("POST", "/api/github/signin", edge(), "{}");
    expect([r.status, json(r).code]).toEqual([409, "no_owner"]);
    expect(json(r).error).toBe(
      "This Den has no owner yet. On the machine it runs on, run `den web owner link`.",
    );
    expect(gh.requests.length).toBe(before);
  });

  it("linking the owner is shell-grade: not from the edge without a session", async () => {
    const r = await call("POST", "/api/web/owner/link", edge(), "{}");
    expect([r.status, json(r).code]).toEqual([401, "signin_required"]);
  });

  it("0.4.12: on plain localhost an anonymous page (any agent's curl) can't link the owner", async () => {
    const r = await call(
      "POST",
      "/api/web/owner/link",
      await localCsrf(),
      "{}",
    );
    expect([r.status, json(r).code]).toEqual([403, "signin_to_approve"]);
  });

  it("on localhost the person (the CLI's bearer) links the owner through the server's device flow; the token is dropped", async () => {
    const h = bearer();
    const start = await call("POST", "/api/web/owner/link", h, "{}");
    expect(start.status).toBe(200);
    const s = json(start);
    expect([s.state, s.verificationUri, s.userCode === lastCode()]).toEqual([
      "pending",
      "https://github.com/login/device",
      true,
    ]);
    gh.approve(lastCode(), OWNER);
    const done = await settle(`/api/web/owner/link/${String(s.id)}`, h);
    expect(json(done)).toMatchObject({ state: "ok", login: "octo-owner" });
    const o = json(await call("GET", "/api/web/owner", h));
    expect(o).toMatchObject({
      owner: { id: "github:4242", login: "octo-owner" },
      clientId: true,
    });
    const file = path.join(stateDir, "web-owner.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const saved = fs.readFileSync(file, "utf-8");
    for (const t of gh.tokens) expect(saved.includes(t)).toBe(false);
    // Linking again is refused while one is linked.
    const again = await call("POST", "/api/web/owner/link", h, "{}");
    expect([again.status, json(again).code]).toEqual([409, "already_linked"]);
  });
});

describe("Sign in with GitHub through the edge", () => {
  it("the signed-out page offers it", async () => {
    const r = await call("GET", "/", {
      host: EDGE,
      "sec-fetch-site": "none",
      accept: "text/html",
    });
    expect(r.status).toBe(401);
    expect(r.body).toContain('"github":{"state":"ready"');
    // SEC-2a-UX: step 1 is done, and names the owner.
    expect(r.body).toContain('"ownerLogin":"octo-owner"');
  });

  it("the owner's approval sets the session cookie, once; the device is recorded", async () => {
    const start = await call(
      "POST",
      "/api/github/signin",
      edge({
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      }),
      "{}",
    );
    expect(start.status).toBe(200);
    const id = String(json(start).id);
    expect(json(start).userCode === lastCode()).toBe(true);
    gh.approve(lastCode(), OWNER);
    const ua = {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    };
    const done = await settle(`/api/github/signin/${id}`, edge(ua));
    expect([done.status, json(done).state, json(done).login]).toEqual([
      200,
      "ok",
      "octo-owner",
    ]);
    const cookie = cookieOf(done);
    expect(cookie.length).toBeGreaterThan(0);
    const line = ([] as string[])
      .concat(done.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith(`den_session_${port}=`))!;
    expect(line).toMatch(/; HttpOnly; SameSite=Strict; Max-Age=34560000/);
    // Signed in: the edge serves it.
    const page = await call("GET", "/api/settings", edge({ cookie }));
    expect(page.status).toBe(200);
    // Claimed once: the same id makes no second session.
    const twice = await call("GET", `/api/github/signin/${id}`, edge());
    expect([twice.status, cookieOf(twice)]).toEqual([404, ""]);
    // Listed as a linked device: its name, how it signed in.
    const list = json(await call("GET", "/api/web/sessions", bearer()))
      .sessions as Record<string, unknown>[];
    expect(list[0]).toMatchObject({
      name: "Chrome on macOS",
      via: "github",
      host: EDGE,
    });
    // The edge couldn't place it: no address recorded.
    expect(list[0].client).toBeUndefined();
  });

  it("a client the edge attests (another machine) is recorded with its address", async () => {
    const away = { "x-forwarded-for": "203.0.113.7" };
    const start = await call("POST", "/api/github/signin", edge(away), "{}");
    gh.approve(lastCode(), OWNER);
    const done = await settle(
      `/api/github/signin/${String(json(start).id)}`,
      edge(away),
    );
    expect(cookieOf(done).length).toBeGreaterThan(0);
    const list = json(await call("GET", "/api/web/sessions", bearer()))
      .sessions as Record<string, unknown>[];
    expect(list[0].client).toBe("203.0.113.7");
  });

  it("another account is refused by name: no cookie", async () => {
    const start = await call("POST", "/api/github/signin", edge(), "{}");
    gh.approve(lastCode(), OTHER);
    const done = await settle(
      `/api/github/signin/${String(json(start).id)}`,
      edge(),
    );
    expect(json(done)).toMatchObject({
      state: "refused",
      login: "someone-else",
      error:
        "@someone-else isn't the owner of this Den. Only the owner's account can use Sign in with GitHub. Use Approve this computer instead.",
    });
    expect(String(json(done).error)).not.toMatch(/add you/);
    expect(cookieOf(done)).toBe("");
  });

  it("cancelled on GitHub: says so, no cookie", async () => {
    const start = await call("POST", "/api/github/signin", edge(), "{}");
    gh.deny(lastCode());
    const done = await settle(
      `/api/github/signin/${String(json(start).id)}`,
      edge(),
    );
    expect(json(done).state).toBe("denied");
    expect(cookieOf(done)).toBe("");
  });

  it("another site can't start one (Origin), nor read its outcome (same-origin only)", async () => {
    const r = await call(
      "POST",
      "/api/github/signin",
      edge({ origin: "https://evil.example" }),
      "{}",
    );
    expect(r.status).toBe(403);
    const poll = await call(
      "GET",
      "/api/github/signin/abcdefghijklmnopqrstuvwx",
      edge({ "sec-fetch-site": "cross-site" }),
    );
    expect(poll.status).toBe(403);
  });

  it("at most 3 pending at once: the 4th is refused, busy", async () => {
    const flows: { id: string; code: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", "/api/github/signin", edge(), "{}");
      expect(r.status).toBe(200);
      flows.push({ id: String(json(r).id), code: lastCode() });
    }
    const busy = await call("POST", "/api/github/signin", edge(), "{}");
    expect([busy.status, json(busy).code]).toEqual([429, "busy"]);
    // Ending one frees a place.
    for (const f of flows) gh.deny(f.code);
    for (const f of flows)
      expect(
        json(await settle(`/api/github/signin/${f.id}`, edge())).state,
      ).toBe("denied");
    const next = await call("POST", "/api/github/signin", edge(), "{}");
    expect(next.status).toBe(200);
    gh.deny(lastCode());
    await settle(`/api/github/signin/${String(json(next).id)}`, edge());
  });
});

describe("the app's token expiry (a misconfiguration Den names)", () => {
  const WARNING =
    /switch off .Expire user authorization tokens. in the app's settings/;

  it("a token answer without expires_in or a refresh_token: no warning, and Access says token expiry is off", async () => {
    // The sign-ins above got plain tokens.
    expect(serverOut).not.toMatch(WARNING);
    const o = json(await call("GET", "/api/web/owner", await localCsrf()));
    expect(o.tokenExpiry).toBe(false);
  });

  it("with expires_in and a refresh_token: the sign-in completes, one warning naming the fix, and Access says so; neither token is kept or logged", async () => {
    gh.expiringTokens = true;
    try {
      for (let i = 0; i < 2; i++) {
        const start = await call("POST", "/api/github/signin", edge(), "{}");
        gh.approve(lastCode(), OWNER);
        const done = await settle(
          `/api/github/signin/${String(json(start).id)}`,
          edge(),
        );
        expect([json(done).state, cookieOf(done).length > 0]).toEqual([
          "ok",
          true,
        ]);
      }
    } finally {
      gh.expiringTokens = false;
    }
    expect(serverOut.match(new RegExp(WARNING.source, "g"))?.length).toBe(1);
    const o = json(await call("GET", "/api/web/owner", await localCsrf()));
    expect(o.tokenExpiry).toBe(true);
    const stored = fs
      .readdirSync(stateDir)
      .map((f) => {
        try {
          return fs.readFileSync(path.join(stateDir, f), "utf-8");
        } catch {
          return "";
        }
      })
      .join("\n");
    const kept = [...gh.tokens, ...gh.refreshTokens].filter(
      (t) => serverOut.includes(t) || stored.includes(t),
    );
    expect(kept.length).toBe(0);
  });
});

describe("Settings › Access", () => {
  it("Revoke ends that device's session at once", async () => {
    const start = await call("POST", "/api/github/signin", edge(), "{}");
    gh.approve(lastCode(), OWNER);
    const done = await settle(
      `/api/github/signin/${String(json(start).id)}`,
      edge(),
    );
    const cookie = cookieOf(done);
    expect((await call("GET", "/api/settings", edge({ cookie }))).status).toBe(
      200,
    );
    const mine = json(await call("GET", "/api/web/sessions", edge({ cookie })))
      .sessions as { id: string; current?: boolean }[];
    const me = mine.find((s) => s.current)!;
    const h = await localCsrf();
    const r = await call(
      "POST",
      "/api/web/logout",
      h,
      JSON.stringify({ id: me.id }),
    );
    expect(json(r)).toMatchObject({ ok: true, ended: [me.id] });
    const after = await call("GET", "/api/settings", edge({ cookie }));
    expect([after.status, json(after).code]).toEqual([401, "signin_required"]);
  });

  it("Pair a device: a one-time link for an edge hostname, which signs a browser in there once", async () => {
    // 0.4.12: an anonymous localhost page can't make one; the person can.
    const anon = await call(
      "POST",
      "/api/web/pair",
      await localCsrf(),
      JSON.stringify({ host: EDGE }),
    );
    expect([anon.status, json(anon).code]).toEqual([403, "signin_to_approve"]);
    const h = bearer();
    expect(json(await call("GET", "/api/web/pair", h))).toEqual({
      hosts: [EDGE],
    });
    const bad = await call(
      "POST",
      "/api/web/pair",
      h,
      JSON.stringify({ host: "evil.example" }),
    );
    expect([bad.status, json(bad).code]).toEqual([400, "unknown_host"]);
    const r = await call(
      "POST",
      "/api/web/pair",
      h,
      JSON.stringify({ host: EDGE }),
    );
    expect(r.status).toBe(200);
    const url = new URL(String(json(r).url));
    secrets.push(url.href);
    expect([url.origin, url.pathname]).toEqual([`http://${EDGE}`, "/auth"]);
    const nav = { host: EDGE, "sec-fetch-site": "none", accept: "text/html" };
    const first = await call("GET", url.pathname + url.search, nav);
    expect(first.status).toBe(303);
    expect(cookieOf(first).length).toBeGreaterThan(0);
    const again = await call("GET", url.pathname + url.search, nav);
    expect(again.status).toBe(401);
    const list = json(await call("GET", "/api/web/sessions", bearer()))
      .sessions as Record<string, unknown>[];
    expect(list[0]).toMatchObject({ via: "link", host: EDGE });
  });

  it("unlinking the owner is shell-grade too; then Sign in with GitHub says to link one", async () => {
    const r = await call("POST", "/api/web/owner/unlink", edge(), "{}");
    expect(r.status).toBe(401);
    const h = bearer();
    expect(json(await call("POST", "/api/web/owner/unlink", h, "{}"))).toEqual({
      ok: true,
      was: "octo-owner",
    });
    const again = await call("POST", "/api/github/signin", edge(), "{}");
    expect(json(again).code).toBe("no_owner");
  });
});

describe("secrets", () => {
  it("no user code, device code, token, cookie or link reaches the server's output", () => {
    const leaked = [
      ...gh.codes.flatMap((c) => [c.userCode, c.deviceCode]),
      ...gh.tokens,
      ...gh.refreshTokens,
      ...secrets.filter(Boolean),
    ].filter((s) => serverOut.includes(s));
    expect(leaked.length).toBe(0);
    // Only a client id ever went to GitHub: no secret, no scope, and
    // never offline_access (it would force an expiring token).
    expect(
      gh.requests.some((r) =>
        Object.keys(r.fields).some((k) => /secret|scope/i.test(k)),
      ),
    ).toBe(false);
    expect(
      gh.requests.some((r) =>
        JSON.stringify(r.fields).includes("offline_access"),
      ),
    ).toBe(false);
  });
});
