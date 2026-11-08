/**
 * Where a service's live log comes from (0.4.18): one rule for the Logs
 * page and the service panel's Logs, so they never disagree.
 *
 *   - Den's own server log (the "__DEN_CLI__/server" pseudo-service):
 *     /api/server-log, the server's log ring;
 *   - a local service: /api/service/taillog, the workspace page's source
 *     chain (the manifest's command, the conventional container, the
 *     daemon's startup log). /api/service/logs answers 404 for a service
 *     with no `logs:` block;
 *   - any other env: /api/service/logs, for cloud sources and the reauth
 *     flow.
 */

/** The server's own log, shown like a service's. */
export function isServerLog(repo, service) {
  return repo === "__DEN_CLI__" && service === "server";
}

/** The SSE URL of `repo/service`'s live log in `env`. */
export function logStreamUrl(repo, service, env) {
  if (isServerLog(repo, service)) return "/api/server-log";
  if (env === "local")
    return `/api/service/taillog?${new URLSearchParams({ repo, service })}`;
  return `/api/service/logs?${new URLSearchParams({ repo, service, env })}`;
}
