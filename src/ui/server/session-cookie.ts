/**
 * Where the session cookie lives. Browsers share a host's cookies across
 * its ports: a cookie set on localhost reaches every other app the person
 * opens on localhost. So:
 *
 *  - over https (Den's own named address, through the edge): the cookie is
 *    `__Host-den_session_<port>`: host-only (no Domain), Path=/, Secure.
 *    The browser sends it to that host over https only.
 *  - over plain http (an install with no working https address): the
 *    plain `den_session_<port>`, host-only, on the one host the person
 *    uses. Doctor names the risk there (doctor-command.ts).
 *
 * Every line is HttpOnly and SameSite=Lax, for as long as a browser keeps
 * a cookie: the session itself never expires. Lax (0.4.45, was Strict): a
 * person's click on a link to Den from another site lands signed in; what
 * another site sends on its own still doesn't carry it, and every write
 * needs the page's X-Den-CSRF besides.
 */
import {
  SESSION_COOKIE_MAX_AGE_S,
  sessionCookieName,
} from "../../shared/web-session.js";

/** The `__Host-` prefix: a browser takes it only host-only, Secure, Path=/. */
export const HOST_PREFIX = "__Host-";

/** The cookie's names: the https one (`__Host-…`) and the plain one. */
export function sessionCookieNames(port: number): {
  secure: string;
  plain: string;
} {
  const plain = sessionCookieName(port);
  return { secure: `${HOST_PREFIX}${plain}`, plain };
}

/** The Set-Cookie line for session `id`, over https (`secure`) or not. */
export function sessionSetCookie(
  port: number,
  id: string,
  secure: boolean,
): string {
  const n = sessionCookieNames(port);
  const rest = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_S}`;
  return secure
    ? `${n.secure}=${id}; ${rest}; Secure`
    : `${n.plain}=${id}; ${rest}`;
}

/**
 * Sign-out's lines: over https both names (a browser signed in there
 * before the `__Host-` name may hold the plain one), over http the plain.
 */
export function clearSessionCookies(port: number, secure: boolean): string[] {
  const n = sessionCookieNames(port);
  const rest = "Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  return secure
    ? [`${n.secure}=; ${rest}; Secure`, `${n.plain}=; ${rest}; Secure`]
    : [`${n.plain}=; ${rest}`];
}

function cookieValue(raw: string, name: string): string | undefined {
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * The session id a request's Cookie header carries. Over https the
 * `__Host-` one, else the plain one a browser signed in there before kept
 * (host-only and Secure already); over http only the plain one.
 */
export function readSessionCookie(
  raw: string | undefined,
  port: number,
  secure: boolean,
): string | undefined {
  if (!raw) return undefined;
  const n = sessionCookieNames(port);
  if (secure) return cookieValue(raw, n.secure) ?? cookieValue(raw, n.plain);
  return cookieValue(raw, n.plain);
}
