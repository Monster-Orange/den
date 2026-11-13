/**
 * Reads `edge:` (and `web:`) from config/den.yml, with per-engineer
 * overrides from config/local/user.yml.
 *
 *   edge:
 *     org: acme
 *     domain: acme.localhost
 *     aliases: [acme.internal]
 *     image: traefik:v3.7.17
 *     workspaces: [main]
 *     routes: { <name>: <upstream url> }
 *     publish: true          # false: another proxy fronts the edge
 *     http_port: 80
 *     https_port: 443
 *     tls: none              # http only; or (see tls.ts):
 *     #   tls: { strategy: mkcert }                   # own local CA, per machine
 *     #   tls: { strategy: mkcert, ca: ~/path/to/ca } # an existing CA; never minted
 *     #   tls: { strategy: files, include: edge/dynamic, mounts: {...} }
 *     #        # included config holds the certs; optional ca: the CA that
 *     #        # signed them, trusted by health checks
 *     # legacy (still read, mapped to tls, deprecated):
 *     #   caroot: <ca>       → tls: { strategy: mkcert, ca: <ca> }
 *     #   issue_cert: false  → tls: { strategy: files }
 *     #   neither, no tls    → mkcert with a local CA, and a warning
 *     # opt-ins (all off by default):
 *     https_redirect: false         # included config redirects per name
 *     docker_labels: { network: apps-network }
 *     include: edge/dynamic         # dynamic-config files, repo-relative
 *     mounts: { <host path>: <container path> }   # read-only
 *     networks: [<external network>]
 *     args: [--accesslog=true]
 *     proxy_protocol:               # a TCP-passthrough front proxy that
 *       trusted_ips: [172.18.0.5]   # sends the PROXY protocol (SEC-2a)
 *     upstream_idle_seconds: 1      # idle upstream connections kept (#67)
 *   web:
 *     port: 7777             # the web UI; routed as `<brand name>`
 */
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { brandSlug, defaultBrand } from "../brand.js";
import { DEFAULT_PORT } from "../constants.js";
import { getDistRoot } from "../paths.js";
import { cachedRead } from "../read-cache.js";
import { readManifestStacks } from "../stacks/config.js";
import { getActiveWorkspaces } from "../environment-manager/workspaces.js";
import { assertDomain } from "./render.js";
import { tlsStrategyIds } from "./tls.js";
import type { EdgeConfig, EdgeTls } from "./types.js";

import { product } from "../product.js";
export const DEFAULT_TRAEFIK_IMAGE = "traefik:v3.7.17";

interface RawEdge {
  org?: string;
  domain?: string;
  aliases?: string[];
  image?: string;
  workspaces?: string[];
  routes?: Record<string, string>;
  state_dir?: string;
  publish?: boolean;
  http_port?: number;
  https_port?: number;
  tls?: unknown;
  caroot?: string;
  issue_cert?: boolean;
  https_redirect?: boolean;
  docker_labels?: { network?: string } | boolean;
  include?: string;
  mounts?: Record<string, string>;
  networks?: string[];
  args?: string[];
  proxy_protocol?: { trusted_ips?: unknown } | null;
  upstream_idle_seconds?: unknown;
}

function readYaml(file: string): Record<string, unknown> {
  try {
    return (
      (yaml.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>) ??
      {}
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

function layers(root: string) {
  return {
    team: readYaml(path.join(root, product().configFile)),
    user: readYaml(path.join(root, "config", "local", "user.yml")),
  };
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** `~/x` → home; a relative path → under the repo root. */
function resolvePath(p: string, root: string): string {
  const e = expandHome(p);
  return path.isAbsolute(e) ? e : path.join(root, e);
}

function list(v: unknown, name: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new Error(`edge.${name} must be a list of strings`);
  return v as string[];
}

function dockerLabels(v: RawEdge["docker_labels"]): { network: string } | null {
  if (v === undefined || v === false) return null;
  const network = typeof v === "object" ? v.network : undefined;
  if (!network || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(network))
    throw new Error(
      "edge.docker_labels needs docker_labels.network: the Docker network " +
        "the edge reaches labelled containers on, e.g. { network: apps-network }",
    );
  return { network };
}

function mounts(v: RawEdge["mounts"], root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [host, target] of Object.entries(v ?? {})) {
    if (typeof target !== "string" || !path.posix.isAbsolute(target))
      throw new Error(
        `edge.mounts: "${host}" must map to an absolute container path, got "${String(target)}"`,
      );
    out[resolvePath(host, root)] = target;
  }
  return out;
}

const TLS_KEYS: Record<string, string[]> = {
  none: ["strategy"],
  mkcert: ["strategy", "ca"],
  files: ["strategy", "ca", "include", "mounts"],
};

interface ResolvedTls {
  tls: EdgeTls;
  from: EdgeConfig["tlsFrom"];
  /** `files`' own include and mounts (raw, resolved by the caller). */
  include?: string;
  mounts?: Record<string, string>;
}

/**
 * `edge.tls` (user.yml's replaces the team's), or the legacy keys mapped to
 * it (EXT-1 rule 6): `issue_cert: false` → files, `caroot` → mkcert with
 * `ca`, neither → mkcert with a local CA (implicit, warned).
 */
function readTls(team: RawEdge, user: RawEdge, root: string): ResolvedTls {
  const raw = user.tls ?? team.tls;
  const caroot = user.caroot ?? team.caroot;
  const issue = user.issue_cert ?? team.issue_cert;
  const ids = tlsStrategyIds();
  const builtIns = ids.join(", ");
  if (raw === undefined) {
    const ca = caroot ? resolvePath(caroot, root) : null;
    return {
      tls:
        issue === false
          ? { strategy: "files", ca }
          : { strategy: "mkcert", ca },
      from: caroot === undefined && issue === undefined ? "implicit" : "legacy",
    };
  }
  const legacy = [
    ...(caroot !== undefined ? ["caroot"] : []),
    ...(issue !== undefined ? ["issue_cert"] : []),
  ];
  if (legacy.length)
    throw new Error(
      `edge.tls replaces edge.${legacy.join(" and edge.")}; remove ${legacy.length > 1 ? "them" : "it"} ` +
        "(caroot is tls.ca, issue_cert: false is tls.strategy: files).",
    );
  const obj: Record<string, unknown> =
    typeof raw === "string"
      ? { strategy: raw }
      : raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
  const id = obj.strategy;
  if (typeof id !== "string" || !id)
    throw new Error(
      `edge.tls must be a strategy id or { strategy: <id>, ... }; the built-ins are ${builtIns}`,
    );
  if (!ids.includes(id))
    throw new Error(
      `edge.tls.strategy "${id}" is not a known TLS strategy; the built-ins are ${builtIns}`,
    );
  const allowed = TLS_KEYS[id] ?? ["strategy"];
  for (const k of Object.keys(obj))
    if (!allowed.includes(k))
      throw new Error(
        `edge.tls.${k} does not apply to strategy ${id} (it takes ${allowed.join(", ")})`,
      );
  let ca: string | null = null;
  if (obj.ca !== undefined) {
    if (typeof obj.ca !== "string" || !obj.ca.trim())
      throw new Error(
        "edge.tls.ca must be the path to an existing CA directory",
      );
    ca = resolvePath(obj.ca, root);
  }
  if (
    obj.include !== undefined &&
    (typeof obj.include !== "string" || !obj.include)
  )
    throw new Error(
      "edge.tls.include must be a directory of dynamic-config files",
    );
  if (
    obj.mounts !== undefined &&
    (!obj.mounts || typeof obj.mounts !== "object" || Array.isArray(obj.mounts))
  )
    throw new Error("edge.tls.mounts must map host paths to container paths");
  const tls: EdgeTls =
    id === "none"
      ? { strategy: "none" }
      : { strategy: id as "mkcert" | "files", ca };
  return {
    tls,
    from: "explicit",
    include: obj.include as string | undefined,
    mounts: obj.mounts as Record<string, string> | undefined,
  };
}

/** True when the org config has an `edge:` block (an edge is configured). */
export function hasEdgeBlock(root: string = getDistRoot()): boolean {
  return layers(root).team.edge !== undefined;
}

/** The web UI's route name: the brand name as a slug ("Den" → "den"). */
function webRouteName(team: Record<string, unknown>): string {
  const name = (team.brand as { name?: string } | undefined)?.name?.trim();
  return brandSlug({ ...defaultBrand(), name: name || defaultBrand().name });
}

function port(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535)
    throw new Error(`${name} must be a port number, got "${String(v)}"`);
  return n;
}

/** The den web UI port: user `web.port` > team `web.port` > 7777. */
export function readWebPort(root: string = getDistRoot()): number {
  const { team, user } = layers(root);
  const v =
    (user.web as { port?: number } | undefined)?.port ??
    (team.web as { port?: number } | undefined)?.port ??
    DEFAULT_PORT;
  return port(v, "web.port");
}

/** Stacks declared in repo manifests across the active workspaces. */
function manifestStackNames(): string[] {
  try {
    return getActiveWorkspaces().flatMap((ws) =>
      Object.keys(readManifestStacks(ws)),
    );
  } catch {
    return []; // a broken manifest must not stop the edge
  }
}

export function readEdgeConfig(root: string = getDistRoot()): EdgeConfig {
  // The web server reads this on every request (open links, health rows);
  // reused for the read cache's TTL there, read fresh everywhere else. An
  // error is cached as such: most instances have no edge block at all.
  const r = cachedRead(`edge-config:${root}`, () => {
    try {
      return { config: computeEdgeConfig(root) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  if ("error" in r) throw new Error(r.error);
  return r.config;
}

function computeEdgeConfig(root: string): EdgeConfig {
  const { team: t, user: u } = layers(root);
  const team = (t.edge ?? {}) as RawEdge;
  const user = (u.edge ?? {}) as RawEdge;
  if (!team.org || !team.domain)
    throw new Error(
      `${product().configFile} has no \`edge:\` block with \`org\` and \`domain\` — ` +
        "add one to give this instance its own HTTPS edge.",
    );
  if (!/^[a-z0-9-]+$/.test(team.org))
    throw new Error(
      `edge.org "${team.org}" must be lowercase letters, digits and dashes`,
    );
  assertDomain(team.domain);
  const aliases = user.aliases ?? team.aliases ?? [];
  if (!Array.isArray(aliases))
    throw new Error("edge.aliases must be a list of domains");
  aliases.forEach(assertDomain);
  const publish = user.publish ?? team.publish ?? true;
  const tls = readTls(team, user, root);
  if (tls.include !== undefined && team.include !== undefined)
    throw new Error(
      "edge.include and edge.tls.include are both set; keep one (tls.include for files' certs)",
    );
  const include = tls.include ?? team.include;
  // The state dir the config names (or the XDG default), DEN_EDGE_DIR aside.
  const configuredStateDir = expandHome(
    user.state_dir ??
      team.state_dir ??
      path.join(
        process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
        team.org,
        "edge",
      ),
  );
  return {
    org: team.org,
    domain: team.domain,
    aliases,
    image: user.image ?? team.image ?? DEFAULT_TRAEFIK_IMAGE,
    workspaces: user.workspaces ?? team.workspaces ?? ["main"],
    subzones: [
      ...new Set([
        ...Object.keys((t.stacks as Record<string, unknown>) ?? {}),
        ...manifestStackNames(),
      ]),
    ].sort(),
    routes: {
      [webRouteName(t)]: `http://host.docker.internal:${readWebPort(root)}`,
      ...(team.routes ?? {}),
      ...(user.routes ?? {}),
    },
    ports: publish
      ? {
          http: port(user.http_port ?? team.http_port ?? 80, "edge.http_port"),
          https: port(
            user.https_port ?? team.https_port ?? 443,
            "edge.https_port",
          ),
        }
      : null,
    stateDir:
      process.env.DEN_EDGE_DIR !== undefined
        ? expandHome(process.env.DEN_EDGE_DIR)
        : configuredStateDir,
    // Set only when DEN_EDGE_DIR overrides it: the dir the config names.
    ...(process.env.DEN_EDGE_DIR !== undefined &&
    expandHome(process.env.DEN_EDGE_DIR) !== configuredStateDir
      ? { defaultStateDir: configuredStateDir }
      : {}),
    tls: tls.tls,
    tlsFrom: tls.from,
    httpsRedirect: (user.https_redirect ?? team.https_redirect) !== false,
    dockerLabels: dockerLabels(user.docker_labels ?? team.docker_labels),
    include: include ? resolvePath(include, root) : null,
    mounts: mounts(
      { ...(team.mounts ?? {}), ...(user.mounts ?? {}), ...(tls.mounts ?? {}) },
      root,
    ),
    networks: [
      ...new Set([
        ...list(team.networks, "networks"),
        ...list(user.networks, "networks"),
      ]),
    ],
    args: [...list(team.args, "args"), ...list(user.args, "args")],
    proxyProtocolTrustedIps: proxyProtocolIps(
      user.proxy_protocol ?? team.proxy_protocol,
    ),
    upstreamIdleSeconds: upstreamIdle(
      user.upstream_idle_seconds ?? team.upstream_idle_seconds,
    ),
  };
}

/** `edge.upstream_idle_seconds` (#67): a whole number, 1 to 600; default 1. */
export function upstreamIdle(v: unknown): number {
  if (v === undefined || v === null) return 1;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 600)
    return v;
  throw new Error(
    "edge.upstream_idle_seconds must be a whole number of seconds, 1 to 600",
  );
}

/**
 * `edge.proxy_protocol.trusted_ips`: a list of IPs or CIDRs (SEC-2a), or
 * none. Throws naming the key on anything else.
 */
export function proxyProtocolIps(v: RawEdge["proxy_protocol"]): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v !== "object" || Array.isArray(v))
    throw new Error(
      "edge.proxy_protocol must be a map: { trusted_ips: [...] }",
    );
  for (const k of Object.keys(v))
    if (k !== "trusted_ips")
      throw new Error(
        `edge.proxy_protocol: unknown key "${k}" (known: trusted_ips)`,
      );
  const ips = list(v.trusted_ips, "proxy_protocol.trusted_ips");
  for (const ip of ips) {
    const [addr, bits, more] = ip.split("/");
    const fam = net.isIP(addr);
    const max = fam === 6 ? 128 : 32;
    if (
      !fam ||
      more !== undefined ||
      (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > max))
    )
      throw new Error(
        `edge.proxy_protocol.trusted_ips: "${ip}" is not an IP address or CIDR`,
      );
  }
  return ips;
}
