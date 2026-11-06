/**
 * Where a service's app opens in a browser, per environment, for the UI's
 * open-in-new-tab links. Health URLs point at /healthz and friends, never the
 * app, so they only ever contribute their origin.
 *
 * Order, first answer wins:
 *   1. manifest `services.<svc>.urls.<env>`
 *   2. local only: the edge route for the service's compose container,
 *      `https://<route>.<stack>.<edge domain>` (`http://` and the edge's http
 *      port for `tls: none`, 0.3.0-dev.40); the stack-wide service (the
 *      entrypoint, or one named after the stack) takes the `app` route, else
 *      the first route
 *   3. the origin of the env's HTTP health URL
 * Only http(s) URLs are returned.
 */
import { manifestStackName } from "./stacks/config.js";
import { parseTarget } from "./stacks/render.js";
import type { RawManifest as DenManifest } from "./types/index.js";

export interface OpenLink {
  label: string;
  url: string;
}

/** The URL if it is absolute http(s), else null. */
export function httpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * How the edge serves its routes: https on 443 (every edge.tls strategy but
 * `none`), or http on its http port for `tls: none`. A non-default port is
 * part of the URL.
 */
export interface EdgeOrigin {
  https: boolean;
  port?: number | null;
}

function edgeRouteUrl(
  manifest: DenManifest,
  subsystem: string,
  repoName: string,
  edgeDomain: string,
  origin: EdgeOrigin,
): string | null {
  const routes = manifest.compose?.routes;
  if (!routes || !Object.keys(routes).length) return null;
  const stack = manifestStackName(manifest, repoName);
  const names = Object.keys(routes).sort();
  let route = names.find((r) => {
    try {
      return parseTarget(routes[r]).service === subsystem;
    } catch {
      return false;
    }
  });
  if (!route && (manifest.entrypoint === subsystem || subsystem === stack))
    route = routes.app ? "app" : names[0];
  if (!route) return null;
  const scheme = origin.https ? "https" : "http";
  const dflt = origin.https ? 443 : 80;
  const port = origin.port && origin.port !== dflt ? `:${origin.port}` : "";
  return `${scheme}://${route}.${stack}.${edgeDomain}${port}/`;
}

export function openUrlFor(opts: {
  manifest: DenManifest;
  subsystem: string;
  repoName: string;
  env: string;
  /** The env's HTTP health URL, when the check is HTTP. */
  healthUrl?: string | null;
  /** Primary edge domain; local edge routes are skipped without it. */
  edgeDomain?: string | null;
  /** The edge's scheme and port (default: https on 443). */
  edgeOrigin?: EdgeOrigin;
}): string | null {
  const svc = opts.manifest.services?.[opts.subsystem];
  const declared = httpUrl(
    (svc?.urls as Record<string, string> | undefined)?.[opts.env],
  );
  if (declared) return declared;
  if (opts.env === "local" && opts.edgeDomain) {
    const routed = edgeRouteUrl(
      opts.manifest,
      opts.subsystem,
      opts.repoName,
      opts.edgeDomain,
      opts.edgeOrigin ?? { https: true },
    );
    if (routed) return routed;
  }
  const health = httpUrl(opts.healthUrl);
  return health ? `${new URL(health).origin}/` : null;
}

/** Extra named links (`services.<svc>.links`) that have a URL for the env. */
export function linksFor(
  manifest: DenManifest,
  subsystem: string,
  env: string,
): OpenLink[] {
  const out: OpenLink[] = [];
  for (const l of manifest.services?.[subsystem]?.links ?? []) {
    const url = httpUrl((l?.urls as Record<string, string> | undefined)?.[env]);
    if (url && typeof l.label === "string") out.push({ label: l.label, url });
  }
  return out;
}

/**
 * Swap the primary edge domain for the alias the viewer is on (e.g. the UI was
 * opened as den.<alias> from another machine), so links resolve there too.
 */
export function rehost(
  url: string,
  primary: string,
  host: string | undefined,
  aliases: string[],
): string {
  const h = (host ?? "").split(":")[0].toLowerCase();
  const alias = aliases.find((a) => h === a || h.endsWith(`.${a}`));
  if (!alias) return url;
  try {
    const u = new URL(url);
    if (u.hostname === primary || u.hostname.endsWith(`.${primary}`)) {
      u.hostname = u.hostname.slice(0, -primary.length) + alias;
      return u.href;
    }
  } catch {
    /* not a URL: leave it */
  }
  return url;
}
