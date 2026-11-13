/**
 * Pure renderers for the edge's Traefik configuration. No I/O, so routing is
 * unit-testable; runtime.ts writes the results.
 */
import * as yaml from "yaml";
import type { EdgeConfig } from "./types.js";

const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function assertDomain(d: string): void {
  if (!DOMAIN_RE.test(d)) throw new Error(`"${d}" is not a valid domain`);
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

export function edgeNames(org: string) {
  const s = slug(org);
  return { container: `${s}-edge`, network: `${s}-edge`, project: `${s}-edge` };
}

/** Hostname for a route: `<name>.<domain>`. */
export function routeHost(name: string, domain: string): string {
  return `${name}.${domain}`;
}

/** Every apex domain the edge serves: the primary first, then aliases. */
export function edgeDomains(cfg: EdgeConfig): string[] {
  return [...new Set([cfg.domain, ...(cfg.aliases ?? [])])];
}

/** `Host()` rule matching `<name>` under every edge domain. */
function hostRule(name: string, cfg: EdgeConfig): string {
  return edgeDomains(cfg)
    .map((d) => `Host(\`${routeHost(name, d)}\`)`)
    .join(" || ");
}

/** True when the edge serves https: every edge.tls strategy but `none`. */
export function edgeHttps(cfg: EdgeConfig): boolean {
  return cfg.tls.strategy !== "none";
}

/** The entrypoint routes listen on: websecure, or web for `tls: none`. */
export function routeEntryPoint(cfg: EdgeConfig): "web" | "websecure" {
  return edgeHttps(cfg) ? "websecure" : "web";
}

/** A router's TLS block: `{ tls: {} }`, or nothing for `tls: none`. */
export function routerTls(cfg: EdgeConfig): { tls?: Record<string, never> } {
  return edgeHttps(cfg) ? { tls: {} } : {};
}

/**
 * Public URL for a route, including the port when it isn't the default
 * (443, or 80 for an http-only edge).
 */
export function routeUrl(
  name: string,
  cfg: EdgeConfig,
  domain = cfg.domain,
): string {
  if (!edgeHttps(cfg)) {
    const h = cfg.ports?.http ?? 80;
    return `http://${routeHost(name, domain)}${h === 80 ? "" : `:${h}`}`;
  }
  const p = cfg.ports?.https ?? 443;
  return `https://${routeHost(name, domain)}${p === 443 ? "" : `:${p}`}`;
}

/**
 * The edge routes to a web server on one of `ports` (an upstream on the
 * docker host or loopback), under every edge domain: `{ host, url }`, the
 * hostname (lowercase) and the URL a browser uses there.
 */
export function webRouteHosts(
  cfg: EdgeConfig,
  ports: ReadonlySet<number>,
): { host: string; url: string }[] {
  return Object.entries(cfg.routes)
    .filter(([, upstream]) => {
      try {
        const u = new URL(upstream);
        return (
          ports.has(Number(u.port || (u.protocol === "https:" ? 443 : 80))) &&
          ["host.docker.internal", "localhost", "127.0.0.1"].includes(
            u.hostname,
          )
        );
      } catch {
        return false;
      }
    })
    .flatMap(([name]) =>
      edgeDomains(cfg).map((d) => ({
        host: routeHost(name, d).toLowerCase(),
        url: routeUrl(name, cfg, d),
      })),
    );
}

/** Names that go on the org's certificate. */
export function certNames(cfg: EdgeConfig): string[] {
  const zones = [...cfg.workspaces, ...(cfg.subzones ?? [])];
  // A dotted route (`app.shop`) is served at app.shop.<domain>, which `*.<domain>`
  // does not cover: add its zone (`shop`) unless a workspace or subzone has it.
  const routeZones = Object.keys(cfg.routes)
    .filter((n) => n.includes("."))
    .map((n) => n.slice(n.indexOf(".") + 1))
    .filter((z, i, all) => !zones.includes(z) && all.indexOf(z) === i);
  return edgeDomains(cfg).flatMap((d) => [
    d,
    `*.${d}`,
    ...[...zones, ...routeZones].map((z) => `*.${z}.${d}`),
  ]);
}

/** The servers transport every generated route's service uses (#67). */
export const UPSTREAM_TRANSPORT = "den-upstream";

/**
 * Dynamic config: TLS cert, HTTP→HTTPS redirect, dashboard, routes. With
 * `tls: none` every router is on the http entrypoint, with no TLS and no
 * redirect.
 */
export function renderEdgeDynamic(cfg: EdgeConfig): string {
  const httpsPort = cfg.ports?.https ?? 443;
  const redirectPort = httpsPort !== 443 ? { port: String(httpsPort) } : {};
  const https = edgeHttps(cfg);
  const redirect = https && cfg.httpsRedirect;
  // Fresh objects per router: a shared one would render as a YAML anchor.
  const entryPoints = () => [routeEntryPoint(cfg)];
  const routers: Record<string, unknown> = {
    ...(redirect
      ? {
          "to-https": {
            entryPoints: ["web"],
            rule: "PathPrefix(`/`)",
            priority: 1,
            middlewares: ["to-https"],
            service: "noop@internal",
          },
        }
      : {}),
    dashboard: {
      entryPoints: entryPoints(),
      rule: hostRule("edge", cfg),
      service: "api@internal",
      ...routerTls(cfg),
    },
  };
  const services: Record<string, unknown> = {};
  for (const [name, url] of Object.entries(cfg.routes).sort()) {
    if (name === "edge")
      throw new Error(`route name "edge" is reserved for the dashboard`);
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name))
      throw new Error(
        `route name "${name}" must be lowercase letters, digits, dots or dashes`,
      );
    const key = `route-${slug(name)}`;
    routers[key] = {
      entryPoints: entryPoints(),
      rule: hostRule(name, cfg),
      service: key,
      ...routerTls(cfg),
    };
    services[key] = {
      loadBalancer: {
        servers: [{ url }],
        serversTransport: UPSTREAM_TRANSPORT,
      },
    };
  }
  const cert = {
    certFile: "/etc/edge/certs/edge.pem",
    keyFile: "/etc/edge/certs/edge-key.pem",
  };
  return (
    "# Generated by `edge up` — edit config, not this file.\n" +
    yaml.stringify({
      http: {
        routers,
        ...(redirect
          ? {
              middlewares: {
                "to-https": {
                  redirectScheme: {
                    scheme: "https",
                    permanent: false,
                    ...redirectPort,
                  },
                },
              },
            }
          : {}),
        ...(Object.keys(services).length
          ? {
              services,
              // #67: drop idle upstream connections before the upstream does.
              serversTransports: {
                [UPSTREAM_TRANSPORT]: {
                  forwardingTimeouts: {
                    idleConnTimeout: `${cfg.upstreamIdleSeconds ?? 1}s`,
                  },
                },
              },
            }
          : {}),
      },
      ...(cfg.tls.strategy === "mkcert"
        ? {
            tls: {
              stores: { default: { defaultCertificate: cert } },
              certificates: [cert],
            },
          }
        : {}),
    })
  );
}

/** The socket proxy's container (and its private network) for docker_labels. */
export function dockerProxyName(org: string): string {
  return `${edgeNames(org).container}-docker`;
}

/**
 * Compose file for the edge; publishes host ports only when configured.
 * With `tls: none` there is no https entrypoint, port or cert volume.
 */
/** The labels that say which state dir and org own the edge container. */
export const EDGE_ROOT_LABEL = "den.edge.root";
export const EDGE_ORG_LABEL = "den.edge.org";

/**
 * The edge's compose.yml. Its container carries `den.edge.root` (the state
 * dir that owns it, `ownerRoot`: edgeUp passes its realpath) and
 * `den.edge.org` (0.3.0-dev.40): edgeUp and `edge down` touch an existing
 * edge only when its root is theirs.
 */
/**
 * The addresses the edge's entrypoints believe X-Forwarded-* headers from
 * (SEC-2a, in place of `forwardedHeaders.insecure`): loopback and the
 * Docker networks the edge and its own proxies run on (Docker's
 * 172.16.0.0/12, Docker Desktop's VM network). From anyone else Traefik
 * drops the client's headers and writes its own; either way the right-most
 * X-Forwarded-For entry is the peer it saw, which is all Den believes.
 */
export const EDGE_FORWARDED_TRUSTED_IPS: readonly string[] = [
  "127.0.0.1/32",
  "::1/128",
  "172.16.0.0/12",
  "192.168.65.0/24",
];

/** An `args` entry that sets what Den owns: the entrypoints' header or PROXY trust. */
const OWNED_ARG =
  /^--entrypoints\.[^.=]+\.(forwardedheaders\.(insecure|trustedips)|proxyprotocol\.)/i;

/** The `edge.args` entries Den drops (SEC-2a): forwarded-header or PROXY trust. */
export function droppedEdgeArgs(cfg: Pick<EdgeConfig, "args">): string[] {
  return cfg.args.filter((a) => OWNED_ARG.test(a));
}

/** The edge entrypoints' trust (SEC-2a): forwarded headers, and the PROXY protocol when set. */
export function edgeTrustArgs(cfg: EdgeConfig): string[] {
  const eps = ["web", ...(edgeHttps(cfg) ? ["websecure"] : [])];
  const pp = cfg.proxyProtocolTrustedIps ?? [];
  return eps.flatMap((ep) => [
    `--entrypoints.${ep}.forwardedHeaders.trustedIPs=${EDGE_FORWARDED_TRUSTED_IPS.join(",")}`,
    ...(pp.length
      ? [`--entrypoints.${ep}.proxyProtocol.trustedIPs=${pp.join(",")}`]
      : []),
  ]);
}

/** The edge container's command (its Traefik static config). */
export function edgeCommand(cfg: EdgeConfig): string[] {
  const https = edgeHttps(cfg);
  const proxy = dockerProxyName(cfg.org);
  const labels = cfg.dockerLabels;
  return [
    "--entrypoints.web.address=:80",
    ...(https ? ["--entrypoints.websecure.address=:443"] : []),
    ...edgeTrustArgs(cfg),
    "--providers.file.directory=/etc/edge/dynamic",
    "--providers.file.watch=true",
    // #67: every route's default transport, Docker-label routes too (theirs
    // aren't Den's to give den-upstream): drop idle upstream connections
    // before the upstream does.
    `--serversTransport.forwardingTimeouts.idleConnTimeout=${cfg.upstreamIdleSeconds ?? 1}s`,
    ...(labels
      ? [
          "--providers.docker=true",
          `--providers.docker.endpoint=tcp://${proxy}:2375`,
          "--providers.docker.exposedbydefault=false",
          `--providers.docker.network=${labels.network}`,
        ]
      : []),
    "--api.dashboard=true",
    "--ping=true",
    "--log.level=WARN",
    ...accessLogArgs(cfg),
    ...cfg.args.filter((a) => !OWNED_ARG.test(a)),
  ];
}

/** Where Traefik writes its raw access log, in the container (#63). */
export const EDGE_ACCESS_DIR = "/var/log/edge";
export const EDGE_ACCESS_RAW = `${EDGE_ACCESS_DIR}/access.json`;

/**
 * `edge.access_log` (#63): Traefik's JSON access log into the raw file Den
 * masks, and tracing so each line (and the upstream, in `traceparent`)
 * has the request id. The OTLP exporter points at a closed local port:
 * the trace ids are wanted, the spans are not.
 */
export function accessLogArgs(cfg: EdgeConfig): string[] {
  if (!cfg.accessLog?.enabled) return [];
  return [
    "--accesslog=true",
    "--accesslog.format=json",
    `--accesslog.filepath=${EDGE_ACCESS_RAW}`,
    "--accesslog.bufferingsize=0",
    "--tracing=true",
    "--tracing.otlp=true",
    "--tracing.otlp.http.endpoint=http://127.0.0.1:1/v1/traces",
  ];
}

/**
 * What changed between a running edge's command and the one `edge up`
 * renders now, as words for its one-line notice; [] when nothing did (or
 * the running one isn't known).
 */
export function edgeCommandDrift(
  running: readonly string[] | null,
  rendered: readonly string[],
): string[] {
  if (!running) return [];
  const a = new Set(running);
  const b = new Set(rendered);
  const changed = [
    ...rendered.filter((x) => !a.has(x)),
    ...running.filter((x) => !b.has(x)),
  ];
  if (!changed.length) return [];
  const what = new Set<string>();
  for (const c of changed)
    what.add(
      /forwardedheaders/i.test(c)
        ? "forwarded-header trust"
        : /proxyprotocol/i.test(c)
          ? "PROXY protocol"
          : /^--serverstransport\./i.test(c)
            ? "upstream idle limit"
            : "its command",
    );
  return [...what];
}

export function renderEdgeCompose(
  cfg: EdgeConfig,
  ownerRoot: string = cfg.stateDir,
): string {
  const https = edgeHttps(cfg);
  const n = edgeNames(cfg.org);
  const proxy = dockerProxyName(cfg.org);
  const labels = cfg.dockerLabels;
  const external = [
    ...new Set([...(labels ? [labels.network] : []), ...cfg.networks]),
  ].filter((x) => x !== n.network && x !== proxy);
  const edgeNets = [n.network, ...(labels ? [proxy] : []), ...external];
  const services: Record<string, unknown> = {
    edge: {
      image: cfg.image,
      container_name: n.container,
      restart: "unless-stopped",
      labels: { [EDGE_ROOT_LABEL]: ownerRoot, [EDGE_ORG_LABEL]: cfg.org },
      ...(labels ? { depends_on: ["docker-proxy"] } : {}),
      command: edgeCommand(cfg),
      ...(cfg.ports
        ? {
            ports: [
              `${cfg.ports.http}:80`,
              ...(https ? [`${cfg.ports.https}:443`] : []),
            ],
          }
        : {}),
      extra_hosts: ["host.docker.internal:host-gateway"],
      volumes: [
        "./dynamic:/etc/edge/dynamic:ro",
        ...(cfg.tls.strategy === "mkcert"
          ? ["./certs:/etc/edge/certs:ro"]
          : []),
        ...Object.entries(cfg.mounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([host, target]) => `${host}:${target}:ro`),
        ...(cfg.accessLog?.enabled ? [`./access:${EDGE_ACCESS_DIR}`] : []),
      ],
      networks: edgeNets,
    },
  };
  if (labels)
    // Read-only Docker API: container listing and events, nothing that writes.
    services["docker-proxy"] = {
      image: "tecnativa/docker-socket-proxy:0.3.0",
      container_name: proxy,
      restart: "unless-stopped",
      environment: {
        CONTAINERS: "1",
        NETWORKS: "1",
        EVENTS: "1",
        PING: "1",
        VERSION: "1",
        POST: "0",
      },
      volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"],
      networks: [proxy],
    };
  return yaml.stringify({
    name: n.project,
    services,
    networks: {
      [n.network]: { external: true },
      ...(labels ? { [proxy]: { internal: true } } : {}),
      ...Object.fromEntries(external.map((x) => [x, { external: true }])),
    },
  });
}
