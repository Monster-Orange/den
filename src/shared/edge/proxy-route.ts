/**
 * Issue 455, clause 8: when another proxy already owns port 80, the route
 * that proxy needs so Den's name reaches Den: one block to paste, for
 * nginx, Caddy or Traefik (a dynamic-config file). Den never edits another
 * project's files; it only shows these (Settings › Edge, `edge route`).
 *
 * Each sends Den's host name to Den's web port, keeps the Host header
 * (Den answers only to its own names) and passes WebSocket upgrades (the
 * terminal and the live views use them). Each is proved in its proxy's
 * official image by tests/unit/edge/proxy-route.integration.test.ts.
 */

export const PROXIES = ["nginx", "caddy", "traefik"] as const;
export type ProxyKind = (typeof PROXIES)[number];

export function isProxyKind(v: unknown): v is ProxyKind {
  return typeof v === "string" && (PROXIES as readonly string[]).includes(v);
}

export interface RouteTarget {
  /** Den's name on that proxy ("den.acme.localhost"). */
  host: string;
  /** The port the proxy listens on (80). */
  listen: number;
  /** Where the proxy reaches Den: host.docker.internal from a container. */
  upstreamHost: string;
  /** Den's web port. */
  upstreamPort: number;
  /** The route's name in Traefik (the product's command, "den"). */
  name: string;
}

/** Where a proxy reaches Den: from a container, the host's name for itself. */
export function upstreamHostFor(kind: "container" | "process" | null): string {
  return kind === "process" ? "127.0.0.1" : "host.docker.internal";
}

function nginx(t: RouteTarget): string {
  return [
    "server {",
    `  listen ${t.listen};`,
    `  server_name ${t.host};`,
    "  location / {",
    `    proxy_pass http://${t.upstreamHost}:${t.upstreamPort};`,
    "    proxy_http_version 1.1;",
    "    proxy_set_header Host $host;",
    "    proxy_set_header Upgrade $http_upgrade;",
    '    proxy_set_header Connection "upgrade";',
    "  }",
    "}",
  ].join("\n");
}

function caddy(t: RouteTarget): string {
  // http:// keeps Caddy from issuing a certificate for the name.
  const site =
    t.listen === 80 ? `http://${t.host}` : `http://${t.host}:${t.listen}`;
  return [
    `${site} {`,
    `  reverse_proxy ${t.upstreamHost}:${t.upstreamPort}`,
    "}",
  ].join("\n");
}

function traefik(t: RouteTarget): string {
  return [
    "http:",
    "  routers:",
    `    ${t.name}:`,
    `      rule: "Host(\`${t.host}\`)"`,
    `      service: ${t.name}`,
    "  services:",
    `    ${t.name}:`,
    "      loadBalancer:",
    "        servers:",
    `          - url: "http://${t.upstreamHost}:${t.upstreamPort}"`,
  ].join("\n");
}

/** The block to paste into `kind`'s config. */
export function proxyRoute(kind: ProxyKind, t: RouteTarget): string {
  return kind === "nginx" ? nginx(t) : kind === "caddy" ? caddy(t) : traefik(t);
}

/** Every proxy's block, for the page. */
export function proxyRoutes(t: RouteTarget): Record<ProxyKind, string> {
  return { nginx: nginx(t), caddy: caddy(t), traefik: traefik(t) };
}

/** The proxy a holder most likely is ("nginx" for an nginx image), else nginx. */
export function proxyKindOf(owner: string | null | undefined): ProxyKind {
  const o = String(owner ?? "").toLowerCase();
  if (o.includes("caddy")) return "caddy";
  if (o.includes("traefik")) return "traefik";
  return "nginx";
}
