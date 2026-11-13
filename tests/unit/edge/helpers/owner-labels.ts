/**
 * The edge container's owner labels (`den.edge.root`, `den.edge.org`,
 * 0.3.0-dev.40) and its entrypoints' forwarded-header trust (SEC-2a,
 * 0.4.5) came after the golden files: those are older engines' own bytes.
 * Byte comparisons drop exactly these lines and nothing else; the labels and
 * the trust are asserted in render.test.ts.
 */
const OWNER_LABELS =
  /^ {4}labels:\n {6}den\.edge\.root: [^\n]*\n {6}den\.edge\.org: [^\n]*\n/m;
const EDGE_TRUST =
  /^ {6}- --entrypoints\.[a-z]+\.forwardedHeaders\.trustedIPs=[^\n]*\n/gm;

export function withoutOwnerLabels(compose: string): string {
  if (!OWNER_LABELS.test(compose))
    throw new Error("the edge's owner labels are missing");
  if (!compose.match(EDGE_TRUST))
    throw new Error("the edge's forwarded-header trust is missing");
  return compose.replace(OWNER_LABELS, "").replace(EDGE_TRUST, "");
}

/**
 * #67 (0.4.42): every generated service names the `den-upstream` servers
 * transport, defined once, after the golden files too. Byte comparisons of
 * the dynamic config drop exactly those lines; render.test.ts asserts them.
 */
const SERVICE_TRANSPORT = /^ {8}serversTransport: den-upstream\n/gm;
const TRANSPORTS =
  /^ {2}serversTransports:\n {4}den-upstream:\n {6}forwardingTimeouts:\n {8}idleConnTimeout: \d+s\n/m;

export function withoutUpstreamTransport(dynamic: string): string {
  const uses = dynamic.match(SERVICE_TRANSPORT)?.length ?? 0;
  const services =
    dynamic.match(/^ {4}route-[^\n]*:\n {6}loadBalancer:\n/gm)?.length ?? 0;
  if (uses !== services)
    throw new Error(
      `${services} routes but ${uses} name the den-upstream transport`,
    );
  if (services && !TRANSPORTS.test(dynamic))
    throw new Error("the den-upstream transport is missing");
  return dynamic.replace(SERVICE_TRANSPORT, "").replace(TRANSPORTS, "");
}
