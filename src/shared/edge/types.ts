/**
 * The org's edge: one Traefik that terminates TLS as `edge.tls` says (none,
 * mkcert or files) and routes `<name>.<domain>` to local services.
 * File-provider routes, plus Docker labels when `docker_labels` opts in
 * (through a read-only socket proxy; the edge never mounts the socket).
 *
 * Standalone by default: the edge publishes host :80/:443 itself. Set
 * `edge.publish: false` when something else on the machine owns those ports
 * and forwards to the edge over its Docker network (`<org>-edge`); the edge
 * neither knows nor cares what that is.
 */

export interface EdgePorts {
  http: number;
  https: number;
}

import type { AccessLogConfig } from "./access-log.js";

export type EdgeTls =
  | { strategy: "none" }
  | { strategy: "mkcert"; ca: string | null }
  | { strategy: "files"; ca: string | null };

export interface EdgeConfig {
  /** Org slug — names the edge container and its Docker network. */
  org: string;
  /** Apex domain; every subdomain is served. */
  domain: string;
  /** More apex domains served identically (e.g. a tailnet-resolvable one). */
  aliases: string[];
  /** Pinned Traefik image. */
  image: string;
  /** Workspaces that get a wildcard cert (`*.<ws>.<domain>`). */
  workspaces: string[];
  /** Extra wildcard labels on the cert (`*.<label>.<domain>`), e.g. stack names. */
  subzones?: string[];
  /** `<name>` → upstream URL, served at `https://<name>.<domain>`. */
  routes: Record<string, string>;
  /** Host ports to publish, or null when another proxy fronts the edge. */
  ports: EdgePorts | null;
  /** Where the org's CA, certs and generated config live. */
  stateDir: string;
  /**
   * The state dir the config names, when DEN_EDGE_DIR overrides it with
   * another (0.3.0-dev.40): an unlabelled edge is adopted only from that one.
   */
  defaultStateDir?: string;
  /**
   * How the edge gets its certificates: the `edge.tls` strategy (see
   * tls.ts). `none`: http only, no https entrypoint. `mkcert`: the edge
   * issues its own wildcard cert from a local CA (its own under `stateDir`,
   * or `ca`, an existing one it never mints or uninstalls). `files`: the
   * included dynamic config and mounts hold the certs; `ca` is the CA that
   * signed them, if Den should trust it for health checks.
   */
  tls: EdgeTls;
  /**
   * Where `tls` came from: `explicit` (edge.tls), `legacy` (edge.caroot /
   * edge.issue_cert, mapped), or `implicit` (neither: mkcert with a local CA,
   * deprecated, warned once per run).
   */
  tlsFrom: "explicit" | "legacy" | "implicit";
  /** Catch-all HTTP→HTTPS redirect. Off when included config decides per name. */
  httpsRedirect: boolean;
  /**
   * Opt-in: also route by `traefik.*` labels on containers, read through a
   * read-only socket proxy. Nothing is exposed unless labelled; `network` is
   * the Docker network the edge reaches labelled containers on.
   */
  dockerLabels: { network: string } | null;
  /** A directory of Traefik dynamic-config files copied in beside the generated one. */
  include: string | null;
  /** Extra read-only bind mounts: host path → container path. */
  mounts: Record<string, string>;
  /** Extra external Docker networks the edge joins. */
  networks: string[];
  /**
   * Extra Traefik static-config arguments. Den owns the entrypoints'
   * forwarded-header and PROXY-protocol trust (SEC-2a): an argument that
   * sets either is dropped, with a warning at `edge up`.
   */
  args: string[];
  /**
   * `edge.proxy_protocol.trusted_ips` (SEC-2a): the front proxies (IPs or
   * CIDRs) whose PROXY protocol header the entrypoints believe, so a TCP
   * passthrough in front can pass on the real client. Empty: none.
   */
  proxyProtocolTrustedIps?: string[];
  /**
   * `edge.upstream_idle_seconds` (#67, default 1): how long the edge keeps
   * an idle connection to an upstream. Below the upstream's own keep-alive
   * (Node 5 s, gunicorn 2 s), so the edge never sends a request on one the
   * upstream has just closed (a 502 with no retry).
   */
  upstreamIdleSeconds?: number;
  /**
   * `edge.access_log` (#63, off by default): Traefik's access log, masked
   * by Den into `edge-access.log` before it is kept.
   */
  accessLog?: AccessLogConfig;
}
