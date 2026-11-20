/**
 * Sign-in on this machine too (0.4.71), for tests: the one shared way a
 * test's browser or request gets a session on a real server. It opens the
 * same one-time link `<cli> web up` opens (signInUrl, minted from the
 * server's own web.secret), so the server's checks are never weakened and
 * nothing is exempt. No code, cookie or token is printed.
 *
 *   - signIn(context, stateDir, base): a Playwright context holds the
 *     session cookie, as a browser that opened the link does;
 *   - signedIn(stateDir, base): the cookie and that session's CSRF token,
 *     for a request shaped as the page's own (Origin, X-Den-CSRF).
 *   - signedIn(stateDir, base, named): the same on Den's named https
 *     address, through the edge's headers (where the session lives once
 *     such an address works: a `__Host-` cookie, never on localhost).
 */
import * as http from "http";
import { signInUrl } from "./den-auth.js";

export interface SignedIn {
  /** `den_session_<port>=<id>` (`__Host-…` on https), for a Cookie header. */
  cookie: string;
  /** The session's id (the cookie's value). */
  value: string;
  /** The cookie's name. */
  name: string;
  /** That session's own CSRF token (GET /api/session). */
  csrf: string;
  /** The page's headers for a write: Cookie, Origin, X-Den-CSRF. */
  headers: Record<string, string>;
}

function get(
  base: string,
  p: string,
  headers: Record<string, string>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const u = new URL(p, base);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        agent: false,
        timeout: 15_000,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (d: Buffer) => (body += d.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error(`timeout: GET ${u.pathname}`)));
    r.end();
  });
}

/** Den's named https address, reached through the edge (its headers). */
export interface NamedHost {
  /** The address's host name, as the edge forwards it. */
  host: string;
  /** What the edge adds: its proof, X-Forwarded-For, X-Forwarded-Proto. */
  edge: Record<string, string>;
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
  const link = new URL(signInUrl(stateDir, origin, "/api/server-info"));
  const auth = await get(server, link.pathname + link.search, {
    "sec-fetch-site": "none",
    ...via,
  });
  if (auth.status !== 303)
    throw new Error(`the one-time link didn't sign in (${auth.status})`);
  const set = ([] as string[]).concat(auth.headers["set-cookie"] ?? []);
  const pair = set
    .map((c) => c.split(";")[0])
    .find((c) => /^(__Host-)?den_session_/.test(c));
  if (!pair) throw new Error("the sign-in set no session cookie");
  const i = pair.indexOf("=");
  const name = pair.slice(0, i);
  const value = pair.slice(i + 1);
  // Its CSRF token, when the server answers /api/session (a server whose
  // config doesn't load answers no route but sign-in: "" then).
  const me = await get(server, "/api/session", {
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
 * Sign a Playwright context in to the server at `base`, as opening the
 * one-time link would: its session cookie, HttpOnly and Lax, as the
 * server set it. Returns the session (its CSRF token for a test's own
 * request).
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
