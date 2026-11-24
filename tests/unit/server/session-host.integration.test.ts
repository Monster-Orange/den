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
import {
  mintLoginCode,
  WebSessionStore,
} from "../../../src/shared/web-session.js";
import { startDenServer, stopServer } from "../../child-servers.js";
import {
  bindActorSession,
  mintActorToken,
} from "../../../src/shared/actor-token.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
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
/**
 * Issue 819: once a person has signed in, a link opens the pairing screen
 * on the address. `q` opened there, approved from a person's browser on
 * the address, and claimed by its page's poll: that reply (its
 * Set-Cookie). The link's own reply when it showed no pairing screen.
 */
const people = new Map<string, SignedIn>();
async function signInThere(q: string): Promise<Reply> {
  // Issue 819: a person signed in first (first run over), so the link
  // opens the pairing screen for that person's browser to approve.
  let person = people.get(stateDir);
  if (!person) {
    person = await signedIn(stateDir, `http://localhost:${port}`, {
      host: NAMED,
      edge: EDGE,
    });
    people.set(stateDir, person);
  }
  const opened = await call("GET", q, { ...named(), ...nav });
  const m =
    /<script type="application\/json" id="den-error">\s*([\s\S]*?)\s*<\/script>/.exec(
      opened.body,
    );
  const pair = m
    ? (JSON.parse(m[1]) as { signin?: { pair?: { id: string; code: string } } })
        .signin?.pair
    : undefined;
  if (!pair) return opened;
  const ok = await call(
    "POST",
    "/api/web/approve",
    {
      ...person.headers,
      "sec-fetch-site": "same-origin",
      "x-den-approve-key": person.approveKey,
    },
    JSON.stringify({ code: pair.code }),
  );
  expect(ok.status).toBe(200);
  return call("GET", `/api/signin/code/${pair.id}`, {
    ...named(),
    "sec-fetch-site": "same-origin",
  });
}
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

/**
 * A fresh server on a fresh install. `lan`: a plain-http LAN bind, so this
 * machine's LAN name reaches it too (and every edge request is beyond).
 */
async function boot(lan: boolean): Promise<void> {
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
      // Issue 796: an agent's token from this test process.
      "agents:",
      "  token_binding: false",
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
      ...(lan ? ["  allow_plain_http_remote: true"] : []),
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
        ...(lan ? { DEN_BIND_HOST: "0.0.0.0" } : {}),
      },
    },
    { timeoutMs: 40_000 },
  );
  server = started.server;
  port = started.port;
}

beforeAll(() => boot(false), 60_000);

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

describe("issue 1299: a held sessions lock never stalls the server", () => {
  it("a sign-in waits for the lock, while another request answers at once", async () => {
    // Another live process (this test) holds the lock.
    const lock = path.join(stateDir, "web-sessions.lock");
    fs.writeFileSync(lock, `${process.pid}\n`, { mode: 0o600 });
    try {
      let answeredAt = 0;
      const signIn = call("GET", `/auth?c=${encodeURIComponent(code())}`, {
        ...local(),
        ...nav,
      }).then((r) => {
        answeredAt = Date.now();
        return r;
      });
      await new Promise((r) => setTimeout(r, 100));
      const t0 = Date.now();
      const other = await call("GET", "/api/session", {
        ...local(),
        "sec-fetch-site": "same-origin",
      });
      expect(other.status).toBeGreaterThan(0);
      expect(Date.now() - t0).toBeLessThan(100);
      // The sign-in is still waiting; the holder lets go and it goes on
      // (what it answers then is this file's sign-in rules, never a 503).
      expect(answeredAt).toBe(0);
      const letGo = Date.now();
      fs.unlinkSync(lock);
      const r = await signIn;
      expect(answeredAt).toBeGreaterThanOrEqual(letGo);
      expect(r.status).not.toBe(503);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });
});

describe("on the named https address", () => {
  it("the sign-in sets a __Host- cookie: host-only, Secure, Path=/", async () => {
    // Issue 819: the link's device, approved, then its page's poll.
    const r = await signInThere(`/auth?c=${encodeURIComponent(code())}`);
    expect(r.status).toBe(200);
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
    // The same link, on the named address: it signs in there (issue 819:
    // its device approved).
    const there = await signInThere(q);
    expect(there.status).toBe(200);
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

describe("once it works: an agent's read-only view stays on loopback", () => {
  /** An agent's token, bound to a session that runs, as Den's start does. */
  const agentToken = () => {
    const dir = sessionPaths(stateDir).dir;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s-viewer.json"), "{}");
    const t = mintActorToken(stateDir, {
      agentId: "viewer",
      workspace: "north",
      sessionName: "viewer",
    });
    bindActorSession(stateDir, t.key, "s-viewer");
    return t.token;
  };
  const viewLink = async () => {
    const r = await call(
      "POST",
      "/api/agents/self/view",
      { ...local(), authorization: `Bearer ${agentToken()}` },
      JSON.stringify({ next: "/agents" }),
    );
    expect(r.status).toBe(200);
    const u = new URL(String((JSON.parse(r.body) as { url: string }).url));
    return `${u.pathname}${u.search}`;
  };

  it("its link opens on loopback, never sent to the named address, and the view counts there", async () => {
    const r = await call("GET", await viewLink(), { ...local(), ...nav });
    expect([r.status, String(r.headers.location)]).toEqual([303, "/agents"]);
    const cookie = sessionLine(r).split(";")[0];
    expect(cookie).not.toBe("");
    const me = await call("GET", "/api/session", {
      ...local(),
      cookie,
      "sec-fetch-site": "same-origin",
    });
    const body = JSON.parse(me.body) as {
      csrf?: string;
      view?: { readOnly?: boolean };
    };
    expect(body.view?.readOnly).toBe(true);
    // Signed out again: the install holds only the sessions the rest make.
    const out = await call(
      "POST",
      "/api/session/logout",
      {
        ...local(),
        cookie,
        origin: `http://localhost:${port}`,
        "x-den-csrf": body.csrf ?? "",
        "sec-fetch-site": "same-origin",
      },
      "{}",
    );
    expect(out.status).toBe(200);
  });

  it("its link opened through the edge is refused, and makes no session", async () => {
    const r = await call("GET", await viewLink(), { ...named(), ...nav });
    expect(r.status === 303).toBe(false);
    expect(sessionLine(r)).toBe("");
  });
});

describe("once it works: a session made on loopback counts nowhere", () => {
  const bearer = () => ({
    authorization: cliAuthHeaders(stateDir).Authorization ?? "",
  });
  it("it was ended when the address was proven (web sessions no longer lists it)", async () => {
    const r = await call("GET", "/api/web/sessions", {
      ...local(),
      ...bearer(),
    });
    expect(r.status).toBe(200);
    const hosts = (
      JSON.parse(r.body) as { sessions: { host: string }[] }
    ).sessions.map((x) => x.host);
    expect(hosts.filter((h) => h === `localhost:${port}`)).toEqual([]);
    expect(hosts.filter((h) => h === NAMED).length).toBeGreaterThan(0);
  });

  // A local app holding the copied loopback cookie sends it to Den's port
  // with the named Host and X-Forwarded-Proto, with and without the proof.
  const value = () => loopCookie.slice(loopCookie.indexOf("=") + 1);
  for (const [what, extra] of [
    ["no proof", {}],
    ["the edge's proof", EDGE_PROOF],
  ] as const)
    for (const name of ["den_session_", "__Host-den_session_"])
      it(`the copied cookie as ${name}<port> on the named Host (${what}): no CSRF token, and a write is 401`, async () => {
        const h: Record<string, string> = {
          host: NAMED,
          "x-forwarded-for": "127.0.0.1",
          "x-forwarded-proto": "https",
          ...extra,
          cookie: `${name}${port}=${value()}`,
        };
        const me = await call("GET", "/api/session", {
          ...h,
          "sec-fetch-site": "same-origin",
        });
        const b = JSON.parse(me.body) as { csrf: unknown; signedIn: unknown };
        expect([b.signedIn === true, typeof b.csrf === "string"]).toEqual([
          false,
          false,
        ]);
        const w = await call(
          WRITE.method,
          WRITE.path,
          {
            ...h,
            origin: `https://${NAMED}`,
            "sec-fetch-site": "same-origin",
            "x-den-csrf": loopCsrf,
          },
          WRITE.body,
        );
        expect([w.status, codeOf(w)]).toEqual([401, "signin_required"]);
      });

  it("a POST /auth on loopback mints nothing: the same 303 to the named address", async () => {
    const q = `/auth?c=${encodeURIComponent(code())}`;
    const r = await call(
      "POST",
      q,
      {
        ...local(),
        origin: `http://localhost:${port}`,
        "sec-fetch-site": "same-origin",
      },
      '{"code":"ABCD-EFGH"}',
    );
    // Compared, never shown: the location carries the one-time code.
    expect([
      r.status,
      String(r.headers.location) === `https://${NAMED}${q}`,
      sessionLine(r),
    ]).toEqual([303, true, ""]);
  });
});

describe('once it works: "This is my computer" (/attest), with no loop', () => {
  const RET = `https://${NAMED}/`;
  const q = `/attest?return=${encodeURIComponent(RET)}`;
  let namedCookie: Record<string, string> = {};
  beforeAll(async () => {
    const s = await signedIn(stateDir, `http://localhost:${port}`, {
      host: NAMED,
      edge: EDGE,
    });
    namedCookie = { cookie: s.cookie };
  });
  const loc = (r: Reply) => String(r.headers.location ?? "");

  it("on loopback it goes to the named address's /attest", async () => {
    const r = await call("GET", q, { ...local(), ...nav });
    expect([r.status, loc(r)]).toEqual([303, `https://${NAMED}${q}`]);
  });

  it("on the named address with no session: the sign-in page, never a redirect (no loop)", async () => {
    const r = await call("GET", q, { ...named(), ...nav });
    expect(r.status).toBe(401);
    expect(r.headers.location).toBeUndefined();
  });

  it("signed in there, a browser the edge places here: straight back with the code", async () => {
    const r = await call("GET", q, { ...named(), ...namedCookie, ...nav });
    expect(r.status).toBe(303);
    expect(loc(r).startsWith(`${RET}#den-attest=a1.`)).toBe(true);
  });

  it("signed in there, a browser the edge can't place: through loopback once, then back with the code", async () => {
    const away = { ...named(), "x-forwarded-for": "0.250.250.254" };
    const r = await call("GET", q, { ...away, ...namedCookie, ...nav });
    expect(r.status).toBe(303);
    const hop = new URL(loc(r));
    expect([hop.origin, hop.pathname]).toEqual([
      `http://localhost:${port}`,
      "/attest",
    ]);
    const back = await call("GET", hop.pathname + hop.search, {
      ...local(),
      ...nav,
    });
    expect(back.status).toBe(303);
    expect(loc(back).startsWith(`${RET}#den-attest=a1.`)).toBe(true);
    // The hop works once.
    const again = await call("GET", hop.pathname + hop.search, {
      ...local(),
      ...nav,
    });
    expect(loc(again).includes("#den-attest=")).toBe(false);
  });
});

describe("once it works: sessions count only when minted on the proven address", () => {
  // The address's name on Den's own port: plain http, no edge proof.
  const plainNamed = () => ({ host: `${NAMED}:${port}` });
  let plain = "";
  let plainCsrf = "";
  beforeAll(() => {
    // A record not minted over the address (sign-in there now goes to the
    // address, so one is made as before 0.4.72 would have made it).
    const made = new WebSessionStore({
      stateDir: () => stateDir,
      secret: () => readWebSecret(stateDir),
    }).create({ host: `${NAMED}:${port}`, reach: "edge", via: "link" });
    plain = made.id;
    plainCsrf = made.session.csrf;
  });

  it("a session minted over plain http on the address's name exists", () => {
    expect([plain.length > 0, plainCsrf.length > 0]).toEqual([true, true]);
  });

  for (const [what, h] of [
    [
      "the address with the edge's proof",
      () => ({ ...named(), "x-forwarded-proto": "https" }),
    ],
    ["the address's name on Den's port", plainNamed],
    ["a loopback name", local],
  ] as const)
    for (const name of ["den_session_", "__Host-den_session_"])
      it(`it counts nowhere: as ${name}<port> on ${what}, no CSRF token and a write is 401`, async () => {
        const base = { ...h(), cookie: `${name}${port}=${plain}` };
        const me = await call("GET", "/api/session", {
          ...base,
          "sec-fetch-site": "same-origin",
        });
        const b = JSON.parse(me.body) as { csrf: unknown; signedIn: unknown };
        expect([b.signedIn === true, typeof b.csrf === "string"]).toEqual([
          false,
          false,
        ]);
        const w = await call(
          WRITE.method,
          WRITE.path,
          {
            ...base,
            origin: `http://${NAMED}:${port}`,
            "sec-fetch-site": "same-origin",
            "x-den-csrf": plainCsrf,
          },
          WRITE.body,
        );
        expect([w.status, codeOf(w)]).toEqual([401, "signin_required"]);
      });

  it("sign-out with its own CSRF token ends it on the server", async () => {
    const r = await call(
      "POST",
      "/api/session/logout",
      {
        ...plainNamed(),
        origin: `http://${NAMED}:${port}`,
        "sec-fetch-site": "same-origin",
        cookie: `den_session_${port}=${plain}`,
        "x-den-csrf": plainCsrf,
      },
      "{}",
    );
    expect([
      r.status,
      (JSON.parse(r.body) as { ended?: boolean }).ended,
    ]).toEqual([200, true]);
    const store = JSON.parse(
      fs.readFileSync(path.join(stateDir, "web-sessions.json"), "utf8"),
    ) as { sessions: Record<string, { csrf: string }> };
    expect(
      Object.values(store.sessions).some((x) => x.csrf === plainCsrf),
    ).toBe(false);
  });
});

describe("once it works: sign-in on every other name goes to the address", () => {
  // Its own server, bound to the LAN too, its address proven by the edge.
  beforeAll(async () => {
    await stopServer(server);
    fs.rmSync(tmp, { recursive: true, force: true });
    await boot(true);
    // A sign-in page through the edge, with its proof: the address is proven.
    const p = await call("GET", "/signin", { ...named(), ...nav });
    expect(p.status).not.toBe(303);
  }, 60_000);
  const lan = () => {
    const h = os.hostname().toLowerCase();
    return { host: `${h.endsWith(".local") ? h : `${h}.local`}:${port}` };
  };
  const plainNamed = () => ({ host: `${NAMED}:${port}` });
  for (const [what, h] of [
    ["a LAN name", lan],
    ["the address's name on Den's plain port", plainNamed],
  ] as const) {
    it(`${what}: /signin and /auth go to the address (303), no cookie, the code unspent`, async () => {
      const c = code();
      for (const [m, p] of [
        ["GET", "/signin"],
        ["GET", `/auth?c=${encodeURIComponent(c)}`],
        ["POST", "/auth"],
      ] as const) {
        const r =
          m === "POST"
            ? await call(
                m,
                p,
                {
                  ...h(),
                  origin: `http://${h().host}`,
                  "sec-fetch-site": "same-origin",
                },
                '{"code":"ABCD-EFGH"}',
              )
            : await call(m, p, { ...h(), ...nav });
        const to = String(r.headers.location ?? "");
        expect([
          r.status,
          to.startsWith(`https://${NAMED}/`),
          sessionLine(r) === "",
        ]).toEqual([303, true, true]);
      }
      // The code still works on the address: nothing was spent (issue
      // 819: its device approved there).
      const there = await signInThere(`/auth?c=${encodeURIComponent(c)}`);
      expect(sessionLine(there).startsWith("__Host-")).toBe(true);
    });
    it(`${what}: the sign-in APIs answer signin_elsewhere`, async () => {
      const r = await call(
        "POST",
        "/api/github/signin",
        {
          ...h(),
          origin: `http://${h().host}`,
          "sec-fetch-site": "same-origin",
        },
        "{}",
      );
      expect([r.status, codeOf(r)]).toEqual([403, "signin_elsewhere"]);
    });
    it(`${what}: the signed-out page names the address, and its CLI line signs in there`, async () => {
      const r = await call("GET", "/", { ...h(), ...nav });
      expect([
        r.status,
        r.body.includes(`"address":"https://${NAMED}"`),
        r.body.includes(`--origin https://${NAMED}`),
      ]).toEqual([401, true, true]);
    });
  }
  it("the address itself, through the edge for a device on the mesh: not sent away", async () => {
    const r = await call("GET", "/signin", {
      ...named(),
      "x-forwarded-for": "100.64.0.7",
      ...nav,
    });
    expect([r.status === 303, String(r.headers.location ?? "")]).toEqual([
      false,
      "",
    ]);
  });
});
