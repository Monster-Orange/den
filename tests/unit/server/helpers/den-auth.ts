/**
 * SEC-1a for tests: the credential the CLI sends (the person token from the
 * test server's own web.secret), through the same helper the CLI uses.
 * A test that POSTs to a real server sends these headers; it never weakens
 * the server's checks.
 */
import { cliAuthHeaders } from "../../../../src/shared/web-secret.js";

/** `{ Authorization: "Bearer den_pt_…" }` for the server whose state dir is `stateDir`. */
export function denAuth(stateDir: string): Record<string, string> {
  const h = cliAuthHeaders(stateDir);
  if (!h.Authorization)
    throw new Error(`no web.secret under the test's state dir yet`);
  return h;
}
