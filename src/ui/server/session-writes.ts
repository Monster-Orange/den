/**
 * Issue 1299: which requests may write the sessions file, and so wait for
 * its lock before they are handled (handleRequest in index.ts). A write
 * itself never waits: one that meets a held lock answers 503 "try again".
 *
 * Every request but GET/HEAD may sign out or revoke; /auth signs in with a
 * link or a claim; the pairing routes include the new device's poll, a GET
 * that signs in; the GitHub sign-in poll is a GET that signs in too.
 */
import { isPairRoute } from "./pair-routes.js";
import { isGithubSigninPoll } from "./github-routes.js";

export function mayWriteSessions(
  method: string | undefined,
  pathname: string,
): boolean {
  return (
    (method !== "GET" && method !== "HEAD") ||
    pathname === "/auth" ||
    isPairRoute(pathname) ||
    isGithubSigninPoll(pathname)
  );
}
