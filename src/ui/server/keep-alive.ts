/**
 * #257: the web server's idle-connection limit. Node closes an idle
 * kept-alive connection after 5 s by default, the page's own poll
 * interval, so a client could reuse a connection just as the server
 * closed it and get a reset (proxies and test clients don't retry).
 * web.keep_alive_seconds (default 120) keeps it open longer than any
 * poll or common proxy idle time; headers may take a little longer
 * still, as Node requires.
 */
import type * as http from "http";

export function applyKeepAlive(server: http.Server, seconds: number): void {
  server.keepAliveTimeout = Math.round(seconds * 1000);
  server.headersTimeout = server.keepAliveTimeout + 5_000;
}
