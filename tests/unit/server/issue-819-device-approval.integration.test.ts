/**
 * Issue 819 (tests first): a new device is approved from a signed-in
 * browser. Written before the build, on a real server reached beyond
 * loopback (a plain-http LAN bind, as sec2a-pair's suite does) and on
 * localhost:
 *
 *  1. A `web login` link opened in a fresh browser lands on the pairing
 *     screen, which shows a code; no session until it is approved.
 *  2. A signed-in browser (Settings › Access) sees the waiting device;
 *     approving signs the new browser in, denying ends it.
 *  3. First run (no owner linked, no browser session yet): the setup link
 *     still signs the person in on this computer, with no second browser.
 *     Once anyone is signed in, it is a link like any other.
 *  4. A link or a code alone, without that approval, never yields a
 *     session, whatever made it (here: minted straight from the install's
 *     secret, and the CLI's bearer read from it).
 *  5. An agent's token, or a fixture session, can't approve a device.
 *
 * The shapes asserted (the page's `signin.pair`, the poll's states) are the
 * existing pairing flow's (pair-routes.ts), reused for the link.
 *
 * No code, cookie or link is printed: a failure shows booleans and states.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { createHmac, randomBytes } from "crypto";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { mintClaimCode } from "../../../src/shared/claim-code.js";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { newConfirmCode } from "../../../src/shared/confirm-code.js";
import {
  approveKeyHash,
  checkLoginCode,
  mintLoginCode,
  WEB_SESSIONS_FILE,
} from "../../../src/shared/web-session.js";
import { WEB_OWNER_FILE } from "../../../src/shared/web-owner.js";
import {
  cliAuthHeaders,
  readWebSecret,
} from "../../../src/shared/web-secret.js";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const NAME = os.hostname().toLowerCase();
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
/** A pairing code, as the signed-out page shows it (pair-requests.ts). */
const PAIR_CODE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/;
let tmp = "";
let root = "";
let stateDir = "";
let port = 0;
let server: ChildProcess | null = null;

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
        host: "127.0.0.1",
        port,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        setHost: false,
        headers: {
          host: `${NAME}:${port}`,
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
const json = (r: Reply): Record<string, unknown> => {
  try {
    return JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    return {};
  }
};
const cookieOf = (r: Reply) =>
  (
    ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith(`den_session_${port}=`)) ?? ""
  ).split(";")[0];
/** The signed-out page's data (the JSON the server fills in), or {}. */
function signinOf(r: Reply): Record<string, unknown> {
  const m =
    /<script type="application\/json" id="den-error">\s*([\s\S]*?)\s*<\/script>/.exec(
      r.body,
    );
  if (!m) return {};
  return (
    (JSON.parse(m[1]) as { signin?: Record<string, unknown> }).signin ?? {}
  );
}
/** A fresh browser on another computer, on this machine's LAN name. */
const lan = (extra: Record<string, string> = {}) => ({
  origin: `http://${NAME}:${port}`,
  "user-agent": UA,
  ...extra,
});
/** A browser on this computer (localhost). */
const local = (extra: Record<string, string> = {}) => ({
  host: `localhost:${port}`,
  "user-agent": UA,
  ...extra,
});
const page = { accept: "text/html" };
/** The CLI's bearer, read from the install's own secret. */
const bearer = () => ({
  authorization: cliAuthHeaders(stateDir).Authorization ?? "",
});
const secret = () => {
  const s = readWebSecret(stateDir);
  if (!s) throw new Error("no web.secret");
  return s;
};

/**
 * First run again: no owner linked, no browser session. Used codes are
 * kept (a spent code stays spent).
 */
function freshInstall(): void {
  const f = path.join(stateDir, WEB_SESSIONS_FILE);
  let usedCodes = {};
  try {
    usedCodes =
      (JSON.parse(fs.readFileSync(f, "utf-8")) as { usedCodes?: object })
        .usedCodes ?? {};
  } catch {
    /* none yet */
  }
  fs.writeFileSync(f, JSON.stringify({ v: 1, sessions: {}, usedCodes }), {
    mode: 0o600,
  });
  fs.rmSync(path.join(stateDir, WEB_OWNER_FILE), { force: true });
}

/** A person's browser on this computer, signed in on first run. */
interface Person {
  cookie: string;
  csrf: string;
  approveKey: string;
}
async function firstRunPerson(): Promise<Person> {
  freshInstall();
  const r = await call(
    "GET",
    `/auth?claim=${encodeURIComponent(mintClaimCode(secret()))}`,
    local(page),
  );
  const cookie = cookieOf(r);
  const approveKey = /#ak=([A-Za-z0-9_-]{43})/.exec(
    String(r.headers.location ?? ""),
  )?.[1];
  if (r.status !== 303 || !cookie || !approveKey)
    throw new Error(`first-run sign-in failed (${r.status})`);
  const s = json(await call("GET", "/api/session", local({ cookie })));
  return { cookie, csrf: String(s.csrf ?? ""), approveKey };
}
/** The page's own headers for an approve or deny from that browser. */
const asPerson = (p: Person) =>
  local({
    cookie: p.cookie,
    origin: `http://localhost:${port}`,
    "x-den-csrf": p.csrf,
    "x-den-approve-key": p.approveKey,
  });

/** What `web login` does: a link, and its wait registered with the server. */
async function webLoginLink(): Promise<{ where: string; typed: string }> {
  const s = secret();
  const code = mintLoginCode(s);
  const c = checkLoginCode(code, s);
  if (!c.ok) throw new Error("could not mint a login code");
  const typed = newConfirmCode();
  const reg = await call(
    "POST",
    "/api/web/logins",
    bearer(),
    JSON.stringify({ nonce: c.nonce, code: typed, expiresAt: c.expiresAt }),
  );
  if (reg.status !== 200) throw new Error(`register failed (${reg.status})`);
  return { where: `/auth?c=${encodeURIComponent(code)}`, typed };
}
/** A link minted straight from the secret, nothing registered. */
const bareLink = () => `/auth?c=${encodeURIComponent(mintLoginCode(secret()))}`;

/** A link opened in a fresh browser: the page, and the pairing it shows. */
async function openOnNewDevice(where: string): Promise<{
  page: Reply;
  pair: { id?: unknown; code?: unknown };
}> {
  const r = await call("GET", where, lan(page));
  const pair = (signinOf(r).pair ?? {}) as { id?: unknown; code?: unknown };
  return { page: r, pair };
}
const poll = (id: unknown) =>
  call("GET", `/api/signin/code/${String(id)}`, lan());

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-819-")));
  root = path.join(tmp, "dist");
  const home = path.join(tmp, "home");
  stateDir = path.join(home, ".den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    "web:\n  allow_plain_http_remote: true\n",
  );
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
        DEN_BIND_HOST: "0.0.0.0",
        DEN_PAIR_UNSEEN_MS: "600000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
    { timeoutMs: 40_000 },
  );
  server = started.server;
  port = started.port;
}, 60_000);

afterAll(async () => {
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("3. first run signs the person in on this computer, with no second browser", () => {
  it("no owner and no session: the setup link opened here signs in", async () => {
    freshInstall();
    const r = await call(
      "GET",
      `/auth?claim=${encodeURIComponent(mintClaimCode(secret()))}`,
      local(page),
    );
    expect([r.status, cookieOf(r) !== ""]).toEqual([303, true]);
  });

  it("first run is on this computer only: the setup link opened on another computer shows the pairing screen, no session", async () => {
    freshInstall();
    const r = await call(
      "GET",
      `/auth?claim=${encodeURIComponent(mintClaimCode(secret()))}`,
      lan(page),
    );
    expect({
      signedIn: cookieOf(r) !== "",
      pairCode: PAIR_CODE.test(
        String((signinOf(r).pair as { code?: unknown })?.code),
      ),
    }).toEqual({ signedIn: false, pairCode: true });
  });

  it("once someone is signed in, the setup link is no longer first run: it shows the pairing screen, no session", async () => {
    await firstRunPerson();
    const r = await call(
      "GET",
      `/auth?claim=${encodeURIComponent(mintClaimCode(secret()))}`,
      local(page),
    );
    expect({
      signedIn: cookieOf(r) !== "",
      pairCode: PAIR_CODE.test(
        String((signinOf(r).pair as { code?: unknown })?.code),
      ),
    }).toEqual({ signedIn: false, pairCode: true });
  });
});

describe("1. a `web login` link doesn't sign in by itself", () => {
  it("opened in a fresh browser, it lands on the pairing screen with a code; no session", async () => {
    await firstRunPerson();
    const { where } = await webLoginLink();
    const { page: r, pair } = await openOnNewDevice(where);
    expect({
      status: r.status,
      signedIn: cookieOf(r) !== "",
      pairCode: PAIR_CODE.test(String(pair.code)),
      pairId: typeof pair.id === "string",
    }).toEqual({ status: 401, signedIn: false, pairCode: true, pairId: true });
    const w = await poll(pair.id);
    expect([json(w).state, cookieOf(w)]).toEqual(["pending", ""]);
  });

  it("the code `web login` printed, typed on that page, doesn't sign in without the approval", async () => {
    await firstRunPerson();
    const { where, typed } = await webLoginLink();
    await call("GET", where, lan(page));
    const r = await call("POST", where, lan(), JSON.stringify({ code: typed }));
    expect({ signedIn: cookieOf(r) !== "" }).toEqual({ signedIn: false });
  });
});

describe("2. a signed-in browser approves or denies the waiting device", () => {
  it("Settings › Access lists it; Approve signs the new browser in, once", async () => {
    const person = await firstRunPerson();
    const { where } = await webLoginLink();
    const { pair } = await openOnNewDevice(where);
    const waiting = await call(
      "GET",
      "/api/web/waiting",
      local({
        cookie: person.cookie,
        "x-den-csrf": person.csrf,
        "sec-fetch-site": "same-origin",
      }),
    );
    expect([waiting.status, json(waiting).code]).toEqual([200, undefined]);
    const rows = (json(waiting).waiting ?? []) as { code?: string }[];
    expect(rows.some((x) => x.code === pair.code)).toBe(true);
    const ok = await call(
      "POST",
      "/api/web/approve",
      asPerson(person),
      JSON.stringify({ code: pair.code }),
    );
    expect(ok.status).toBe(200);
    const done = await poll(pair.id);
    const cookie = cookieOf(done);
    expect([json(done).state, cookie !== ""]).toEqual(["ok", true]);
    expect((await call("GET", "/api/settings", { cookie })).status).toBe(200);
  });

  it("Deny ends it: the page is told, no session, and the link is spent", async () => {
    const person = await firstRunPerson();
    const { where } = await webLoginLink();
    const { pair } = await openOnNewDevice(where);
    const r = await call(
      "POST",
      "/api/web/deny",
      asPerson(person),
      JSON.stringify({ code: pair.code }),
    );
    expect(r.status).toBe(200);
    const p = await poll(pair.id);
    expect([json(p).state, cookieOf(p)]).toEqual(["denied", ""]);
    const again = await call("GET", where, lan(page));
    expect({ signedIn: cookieOf(again) !== "" }).toEqual({ signedIn: false });
    expect(signinOf(again).pair).toBeUndefined();
  });
});

describe("4. a link or a code alone never yields a session, whatever made it", () => {
  it("a link minted straight from the install's secret (nothing waits on it), opened on another computer: pairing screen, no session", async () => {
    await firstRunPerson();
    const { page: r, pair } = await openOnNewDevice(bareLink());
    expect({
      signedIn: cookieOf(r) !== "",
      pairCode: PAIR_CODE.test(String(pair.code)),
    }).toEqual({ signedIn: false, pairCode: true });
  });

  it("the same, opened on this computer once it is set up: no session", async () => {
    await firstRunPerson();
    const r = await call("GET", bareLink(), local(page));
    expect({ signedIn: cookieOf(r) !== "" }).toEqual({ signedIn: false });
  });

  it("a pairing code approved with the CLI's bearer (read from the install's secret) signs nothing in", async () => {
    await firstRunPerson();
    const { page: opened, pair } = await openOnNewDevice(bareLink());
    // The link page's code, else the signed-out page's own request.
    let code = pair.code;
    let id = pair.id;
    if (cookieOf(opened) !== "" || !PAIR_CODE.test(String(code))) {
      const a = json(await call("POST", "/api/signin/code", lan(), "{}"));
      code = a.code;
      id = a.id;
    }
    const r = await call(
      "POST",
      "/api/web/approve",
      bearer(),
      JSON.stringify({ code }),
    );
    const p = await poll(id);
    expect({
      approved: r.status === 200,
      state: json(p).state,
      signedIn: cookieOf(p) !== "",
    }).toEqual({ approved: false, state: "pending", signedIn: false });
  });
});

describe("5. only a person's browser approves a device", () => {
  it("an agent's token can't approve", async () => {
    await firstRunPerson();
    const a = json(await call("POST", "/api/signin/code", lan(), "{}"));
    const { token } = mintActorToken(stateDir, {
      agentId: "builder",
      workspace: "north",
      sessionName: "builder",
    });
    const r = await call(
      "POST",
      "/api/web/approve",
      { authorization: `Bearer ${token}` },
      JSON.stringify({ code: a.code }),
    );
    expect(r.status === 200).toBe(false);
    expect(json(await poll(a.id)).state).toBe("pending");
  });

  it("a fixture session (signed in for live checks, approval key and all) can't approve", async () => {
    await firstRunPerson();
    // A fixture session as the store keeps one (issue 810's via), written
    // straight into the session file from the install's secret.
    const id = randomBytes(32).toString("base64url");
    const ak = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    const key = createHmac("sha256", secret())
      .update("den-session-v1:" + id)
      .digest("hex");
    const f = path.join(stateDir, WEB_SESSIONS_FILE);
    const data = JSON.parse(fs.readFileSync(f, "utf-8")) as {
      sessions: Record<string, unknown>;
    };
    const now = Date.now();
    data.sessions[key] = {
      createdAt: now,
      lastSeenAt: now,
      userAgent: UA,
      csrf,
      host: `localhost:${port}`,
      reach: "loopback",
      via: "fixture",
      approveKeyHash: approveKeyHash(ak),
    };
    fs.writeFileSync(f, JSON.stringify(data), { mode: 0o600 });
    const a = json(await call("POST", "/api/signin/code", lan(), "{}"));
    const r = await call(
      "POST",
      "/api/web/approve",
      local({
        cookie: `den_session_${port}=${id}`,
        origin: `http://localhost:${port}`,
        "x-den-csrf": csrf,
        "x-den-approve-key": ak,
      }),
      JSON.stringify({ code: a.code }),
    );
    expect(r.status === 200).toBe(false);
    expect(json(await poll(a.id)).state).toBe("pending");
  });
});

describe("6. each refusal and wait says what to do next, in plain words", () => {
  it("the pairing screen a link lands on says where to approve it (Settings › Access)", async () => {
    await firstRunPerson();
    const { page: r } = await openOnNewDevice(bareLink());
    expect(String(signinOf(r).message ?? "")).toMatch(/Settings › Access/);
  });

  it("approving with the CLI's bearer is refused, and says to approve from a signed-in browser", async () => {
    await firstRunPerson();
    const a = json(await call("POST", "/api/signin/code", lan(), "{}"));
    const r = await call(
      "POST",
      "/api/web/approve",
      bearer(),
      JSON.stringify({ code: a.code }),
    );
    expect([r.status, String(json(r).error ?? "")]).toEqual([
      403,
      expect.stringMatching(/signed-in browser.*Settings › Access/),
    ]);
  });
});
