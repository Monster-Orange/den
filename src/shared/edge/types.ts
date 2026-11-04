/**
 * The org's HTTPS edge: one Traefik that terminates TLS with the org's own CA
 * (mkcert, separate CAROOT) and routes `<name>.<domain>` to local services.
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
   * An existing mkcert CA to use instead of the org's own under `stateDir`
   * (e.g. a CA other devices already trust). The edge refuses to run if its
   * key is missing, so mkcert can never mint a replacement, and it never
   * uninstalls a shared CA.
   */
  caroot: string | null;
  /** Issue the edge's own wildcard cert. Off when included config holds the certs. */
  issueCert: boolean;
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
  /** Extra Traefik static-config arguments. */
  args: string[];
}
