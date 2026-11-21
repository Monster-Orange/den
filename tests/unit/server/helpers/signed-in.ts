/**
 * Sign-in for tests: the one shared way a test's browser or request gets a
 * session on a real server, through the person's own paths (issue 819), so
 * the server's checks are never weakened and nothing is exempt. No code,
 * cookie or token is printed.
 *
 *   - first run (nobody has signed in on that install yet): a `web login`
 *     link, registered with the CLI's bearer from this process as the CLI
 *     does, then opened: it signs in by itself;
 *   - after that: the signed-out page's own request (a pairing code),
 *     approved from a person's signed-in browser (the last session made
 *     here, kept per install and address: its cookie and approval key),
 *     then claimed by its poll, which sets the cookie;
 *   - when no signed-in person is left to approve (a test signed everyone
 *     out, or signed in another way first), an approving session is
 *     written into the install's session store, as a person's browser that
 *     signed in earlier: it approves as above, then signs out, so the
 *     install holds only the sessions the test made.
 *
 *   - signIn(context, stateDir, base): a Playwright context holds the
 *     session cookie, as a browser that was approved does;
 *   - signInPage(page, stateDir, base, next): the same for a page's
 *     context, then the page opens `next` with the session's approval key
 *     (as a sign-in's landing carries it);
 *   - signedIn(stateDir, base): the cookie and that session's CSRF token,
 *     for a request shaped as the page's own (Origin, X-Den-CSRF).
 *   - signedIn(stateDir, base, named): the same on Den's named https
 *     address, through the edge's headers (where the session lives once
 *     such an address works: a `__Host-` cookie, never on localhost).
 */
import { createHmac, randomBytes } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import {
  approveKeyHash,
  checkLoginCode,
  mintLoginCode,
  WEB_SESSIONS_FILE,
} from "../../../../src/shared/web-session.js";
import { readWebSecret } from "../../../../src/shared/web-secret.js";
import { FIRST_RUN_FILE } from "../../../../src/ui/server/first-run.js";
import { denAuth } from "./den-auth.js";

export interface SignedIn {
  /** `den_session_<port>=<id>` (`__Host-…` on https), for a Cookie header. */
  cookie: string;
  /** The session's id (the cookie's value). */
  value: string;
  /** The cookie's name. */
  name: string;
  /** That session's own CSRF token (GET /api/session). */
  csrf: string;
  /** The session's approval key (what a sign-in's landing carries). */
  approveKey: string;
  /** The page's headers for a write: Cookie, Origin, X-Den-CSRF. */
  headers: Record<string, string>;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function call(
  base: string,
  method: string,
  p: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Reply> {
  const u = new URL(p, base);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        agent: false,
        timeout: 15_000,
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
            headers: res.headers,
            body: out,
          }),
        );
      },
    );
    r.on("error", reject);
    r.on("timeout", () =>
      r.destroy(new Error(`timeout: ${method} ${u.pathname}`)),
    );
    r.end(body);
  });
}

const parse = (r: Reply): Record<string, unknown> => {
  try {
    return JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** Den's named https address, reached through the edge (its headers). */
export interface NamedHost {
  /** The address's host name, as the edge forwards it. */
  host: string;
  /** What the edge adds: its proof, X-Forwarded-For, X-Forwarded-Proto. */
  edge: Record<string, string>;
}

/** Where a sign-in happens: the server, the origin, the edge's headers. */
interface Where {
  stateDir: string;
  server: string;
  origin: string;
  via: Record<string, string>;
  named?: NamedHost;
}

/** A session the sign-in made: its cookie line and approval key. */
interface Minted {
  pair: string;
  approveKey: string;
}

/** The session cookie a reply set, or null. */
function cookieSet(r: Reply): string | null {
  return (
    ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .map((c) => c.split(";")[0])
      .find((c) => /^(__Host-)?den_session_\d+=./.test(c)) ?? null
  );
}

/**
 * First run: a `web login` link registered from this process (the CLI's
 * bearer, on the loopback name as the CLI calls), then opened. Null when
 * the install is set up already, or the link didn't sign in.
 */
async function firstRun(w: Where): Promise<Minted | null> {
  if (fs.existsSync(path.join(w.stateDir, FIRST_RUN_FILE))) return null;
  const secret = readWebSecret(w.stateDir);
  if (!secret) throw new Error("no web.secret under the test's state dir yet");
  const code = mintLoginCode(secret);
  const c = checkLoginCode(code, secret);
  if (!c.ok) return null;
  const port = new URL(w.server).port;
  const reg = await call(
    w.server,
    "POST",
    "/api/web/logins",
    { host: `localhost:${port}`, ...denAuth(w.stateDir) },
    JSON.stringify({ nonce: c.nonce, expiresAt: c.expiresAt }),
  );
  if (reg.status !== 200) return null;
  const r = await call(
    w.server,
    "GET",
    `/auth?c=${encodeURIComponent(code)}&next=${encodeURIComponent("/api/server-info")}`,
    { "sec-fetch-site": "none", ...w.via },
  );
  const pair = cookieSet(r);
  const ak = /#ak=([A-Za-z0-9_-]{43})/.exec(String(r.headers.location ?? ""));
  if (r.status !== 303 || !pair || !ak) return null;
  return { pair, approveKey: ak[1] };
}

/** A person's browser that may approve: its cookie and approval key. */
interface Approver extends Minted {
  key: string;
}
const APPROVERS = new Map<string, Approver>();
const keyOf = (w: Where) => `${w.stateDir}|${w.origin}`;

/**
 * A new device, approved by `a`: the signed-out page's request, Approve
 * from that browser, then the request's poll, which sets the cookie. Null
 * when `a` can't approve (signed out since).
 */
async function approved(w: Where, a: Approver): Promise<Minted | null> {
  const me = await call(w.server, "GET", "/api/session", {
    cookie: a.pair,
    "sec-fetch-site": "same-origin",
    ...w.via,
  });
  const csrf = parse(me).csrf;
  if (
    me.status !== 200 ||
    parse(me).signedIn !== true ||
    typeof csrf !== "string"
  )
    return null;
  const asked = await call(
    w.server,
    "POST",
    "/api/signin/code",
    { origin: w.origin, ...w.via },
    "{}",
  );
  const req = parse(asked);
  if (asked.status !== 200 || typeof req.id !== "string")
    throw new Error(`the signed-out page's request failed (${asked.status})`);
  const ok = await call(
    w.server,
    "POST",
    "/api/web/approve",
    {
      ...w.via,
      cookie: a.pair,
      origin: w.origin,
      "x-den-csrf": csrf,
      "x-den-approve-key": a.approveKey,
    },
    JSON.stringify({ code: req.code }),
  );
  if (ok.status !== 200) return null;
  const done = await call(
    w.server,
    "GET",
    `/api/signin/code/${encodeURIComponent(req.id)}`,
    { "sec-fetch-site": "same-origin", ...w.via },
  );
  const pair = cookieSet(done);
  const ak = parse(done).approveKey;
  if (!pair || typeof ak !== "string")
    throw new Error(`the approved request set no session (${done.status})`);
  return { pair, approveKey: ak };
}

/**
 * A person's browser session written into the install's store (as one
 * that signed in earlier), to approve with when none is left.
 */
function written(w: Where): Approver {
  const secret = readWebSecret(w.stateDir);
  if (!secret) throw new Error("no web.secret under the test's state dir yet");
  const id = randomBytes(32).toString("base64url");
  const approveKey = randomBytes(32).toString("base64url");
  const key = createHmac("sha256", secret)
    .update("den-session-v1:" + id)
    .digest("hex");
  const file = path.join(w.stateDir, WEB_SESSIONS_FILE);
  let data: {
    v?: number;
    sessions?: Record<string, unknown>;
    usedCodes?: Record<string, number>;
  } = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8")) as typeof data;
  } catch {
    /* none yet */
  }
  const now = Date.now();
  const port = new URL(w.server).port;
  data = {
    v: 1,
    usedCodes: data.usedCodes ?? {},
    sessions: {
      ...(data.sessions ?? {}),
      [key]: {
        createdAt: now,
        lastSeenAt: now,
        userAgent: "test approver",
        csrf: randomBytes(32).toString("base64url"),
        host: w.named ? w.named.host : new URL(w.server).host,
        reach: w.named ? "edge" : "loopback",
        ...(w.named ? { secure: true } : {}),
        via: "link",
        approveKeyHash: approveKeyHash(approveKey),
      },
    },
  };
  fs.mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  const name = `${w.named ? "__Host-" : ""}den_session_${port}`;
  return { key: keyOf(w), pair: `${name}=${id}`, approveKey };
}

/** Sign `a` out (its own page's sign-out). */
async function signOut(w: Where, a: Minted): Promise<void> {
  const me = await call(w.server, "GET", "/api/session", {
    cookie: a.pair,
    "sec-fetch-site": "same-origin",
    ...w.via,
  });
  const csrf = parse(me).csrf;
  if (typeof csrf !== "string") return;
  await call(
    w.server,
    "POST",
    "/api/session/logout",
    { ...w.via, cookie: a.pair, origin: w.origin, "x-den-csrf": csrf },
    "{}",
  );
}

/** A new session at `w`, by first run or a person's approval. */
async function mint(w: Where): Promise<Minted> {
  const k = keyOf(w);
  const prior = APPROVERS.get(k);
  let s = prior ? await approved(w, prior) : null;
  if (!s) s = await firstRun(w);
  if (!s) {
    const a = written(w);
    s = await approved(w, a);
    await signOut(w, a);
    if (!s) throw new Error("the test's approving browser couldn't approve");
  }
  APPROVERS.set(k, { key: k, ...s });
  return s;
}

/**
 * A fresh session on the server at `base` (its state dir `stateDir`); on
 * `named`, through the edge's headers to the same server.
 */
export async function signedIn(
  stateDir: string,
  base: string,
  named?: NamedHost,
): Promise<SignedIn> {
  const server = new URL(base).origin;
  const origin = named ? `https://${named.host}` : server;
  const via: Record<string, string> = named
    ? { host: named.host, ...named.edge }
    : {};
  const m = await mint({ stateDir, server, origin, via, named });
  const pair = m.pair;
  const i = pair.indexOf("=");
  const name = pair.slice(0, i);
  const value = pair.slice(i + 1);
  // Its CSRF token, when the server answers /api/session (a server whose
  // config doesn't load answers no route but sign-in: "" then).
  const me = await call(server, "GET", "/api/session", {
    cookie: pair,
    "sec-fetch-site": "same-origin",
    ...via,
  });
  let csrf = "";
  if (me.status === 200) {
    const b = JSON.parse(me.body) as { csrf?: string; signedIn?: boolean };
    if (!b.signedIn || typeof b.csrf !== "string")
      throw new Error("the session isn't signed in");
    csrf = b.csrf;
  }
  return {
    cookie: pair,
    name,
    value,
    csrf,
    approveKey: m.approveKey,
    headers: { ...via, cookie: pair, origin, "x-den-csrf": csrf },
  };
}

/** What signIn needs of a Playwright BrowserContext. */
interface CookieJar {
  addCookies(
    cookies: {
      name: string;
      value: string;
      url: string;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: "Lax" | "Strict" | "None";
    }[],
  ): Promise<void>;
}

/**
 * Sign a Playwright context in to the server at `base`, as an approved
 * device is: its session cookie, HttpOnly and Lax, as the server set it.
 * Returns the session (its CSRF token for a test's own request).
 */
export async function signIn(
  context: CookieJar,
  stateDir: string,
  base: string,
): Promise<SignedIn> {
  const s = await signedIn(stateDir, base);
  await context.addCookies([
    {
      name: s.name,
      value: s.value,
      url: new URL(base).origin,
      httpOnly: true,
      // A __Host- cookie is Secure (the named https address).
      ...(s.name.startsWith("__Host-") ? { secure: true } : {}),
      sameSite: "Lax",
    },
  ]);
  return s;
}

/** What signInPage needs of a Playwright Page. */
interface PageLike<R> {
  context(): CookieJar;
  goto(
    url: string,
    opts?: {
      waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
    },
  ): Promise<R>;
}

/**
 * Sign the page's context in (signIn), then open `next` on `base` as a
 * sign-in lands: with the session's approval key in the fragment, which
 * the page keeps to approve with. Returns goto's response.
 */
export async function signInPage<R>(
  page: PageLike<R>,
  stateDir: string,
  base: string,
  next = "/",
  opts?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" },
): Promise<R> {
  const s = await signIn(page.context(), stateDir, base);
  const u = new URL(next, base);
  u.hash = `ak=${s.approveKey}`;
  return page.goto(u.href, opts);
}
