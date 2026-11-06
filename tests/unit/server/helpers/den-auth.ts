/**
 * SEC-1a for tests: the credential the CLI sends (the person token from the
 * test server's own web.secret), through the same helper the CLI uses.
 * A test that POSTs to a real server sends these headers; it never weakens
 * the server's checks.
 */
import {
  cliAuthHeaders,
  readWebSecret,
} from "../../../../src/shared/web-secret.js";
import {
  loginLink,
  mintLoginCode,
} from "../../../../src/shared/web-session.js";

/**
 * SEC-1b: a one-time sign-in link for the server whose state dir is
 * `stateDir`, minted as `<cli> web login` mints it. A browser test opens it
 * to sign in (it never bypasses the check). Never printed.
 */
export function signInUrl(
  stateDir: string,
  origin: string,
  next = "/",
): string {
  const secret = readWebSecret(stateDir);
  if (!secret) throw new Error(`no web.secret under the test's state dir yet`);
  return loginLink(origin, mintLoginCode(secret), next);
}

/** `{ Authorization: "Bearer den_pt_…" }` for the server whose state dir is `stateDir`. */
export function denAuth(stateDir: string): Record<string, string> {
  const h = cliAuthHeaders(stateDir);
  if (!h.Authorization)
    throw new Error(`no web.secret under the test's state dir yet`);
  return h;
}
