/**
 * Read-only edge status: what `edge status` shows, as data. The CLI prints
 * it; the web server serves it at /api/edge (and through it the MCP
 * `edge_status` tool).
 */
import * as fs from "fs";
import * as path from "path";
import * as tls from "tls";
import { certNames, edgeDomains, edgeNames, routeUrl } from "./render.js";
import {
  includedRouters,
  stackRouters,
  type IncludedRouters,
} from "./included.js";
import { caTrusted, containerState } from "./runtime.js";
import { caDir } from "./tls.js";
import type { EdgeConfig, EdgePorts } from "./types.js";

export interface EdgeStatus {
  org: string;
  container: string;
  /** Docker's container state ("running", "exited", …) or "absent". */
  state: string;
  up: boolean;
  /** Published host ports, or null when another proxy fronts the edge. */
  ports: EdgePorts | null;
  network: string;
  domains: string[];
  routes: { name: string; url: string; upstream: string }[];
  /** Names on the issued cert, or the planned ones when none is issued yet. */
  certNames: string[];
  /**
   * Whether Den minted the edge's cert itself (mkcert: its names stamp is
   * there). False under `tls: files` (the distribution supplies the cert)
   * and `tls: none`, whether or not HTTPS serves: see `https`.
   */
  certIssuedByDen: boolean;
  /** @deprecated certIssuedByDen (MCP-2.5); kept for one release. */
  certIssued: boolean;
  /** MCP-2.5: the TLS strategy in words, and whether HTTPS is serving. */
  https: EdgeHttps;
  /** Fields kept for one release under an old name, and what replaces them. */
  deprecated: { certIssued: string };
  /** Whether the CA is trusted on this machine (null: can't tell, or none). */
  caTrusted: boolean | null;
  /**
   * The edge.tls strategy; whether nothing chose it (implicit mkcert);
   * where it came from (edge.tls, the legacy caroot/issue_cert keys, or
   * neither); and the CA directory (mkcert: the one it issues from; files:
   * `ca` when set; none: null).
   */
  tls: {
    strategy: EdgeConfig["tls"]["strategy"];
    implicit: boolean;
    from: EdgeConfig["tlsFrom"];
    ca: string | null;
  };
  /**
   * Routers in the included dynamic files (`edge include`), each with its
   * source file: Traefik serves them, Den doesn't generate them.
   */
  included: IncludedRouters["routers"];
  /** Included files that could not be parsed (listed, never fatal). */
  includedErrors: IncludedRouters["errors"];
  /**
   * Routers in the stacks' route files (`stack-*.yml`, written by `stack
   * up` into the edge's dynamic directory), each with its file (0.3.0-dev.32).
   */
  stacks: IncludedRouters["routers"];
  /** Stack route files that could not be parsed (listed, never fatal). */
  stackErrors: IncludedRouters["errors"];
}

export interface EdgeHttps {
  strategy: EdgeConfig["tls"]["strategy"];
  /**
   * Who supplies the cert: "den" (mkcert, minted here), "distribution"
   * (`tls: files`, or the legacy `issue_cert: false`), or "none" (http only).
   */
  certs: "den" | "distribution" | "none";
  /**
   * Whether the edge answers a TLS handshake on its https port: true, false,
   * or null when it was not probed (`edge status` from the CLI, or a proxy
   * in front owns the port).
   */
  serving: boolean | null;
  /** How `serving` was decided, in words. */
  detail: string;
}

export const CERT_ISSUED_DEPRECATION =
  "certIssued is renamed certIssuedByDen (0.4.4) and goes in the release " +
  "after: it says whether Den minted the cert itself, so it is false under " +
  "tls strategy files while HTTPS serves. Read https.serving for that.";

export interface EdgeStatusDeps {
  containerState: (name: string) => string;
  caTrusted: (cfg: EdgeConfig) => boolean | null;
  /** Names on the issued cert (its stamp file), or null when none is issued. */
  issuedNames: (cfg: EdgeConfig) => string[] | null;
  /** The included files' routers (read from disk by default). */
  included?: (cfg: EdgeConfig) => IncludedRouters;
  /** The stacks' route files' routers (read from disk by default). */
  stacks?: (cfg: EdgeConfig) => IncludedRouters;
}

/** The names stamp `ensureCerts` writes beside the cert. */
export function issuedCertNames(cfg: EdgeConfig): string[] | null {
  const stamp = path.join(cfg.stateDir, "certs", "names.txt");
  if (!fs.existsSync(stamp)) return null;
  return fs.readFileSync(stamp, "utf-8").split("\n").filter(Boolean);
}

const defaultDeps: EdgeStatusDeps = {
  containerState,
  caTrusted,
  issuedNames: issuedCertNames,
  included: includedRouters,
  stacks: stackRouters,
};

/** Den's own routes: `<name>.<domain>` → upstream (no Docker asked). */
export function edgeRoutes(cfg: EdgeConfig): EdgeStatus["routes"] {
  return Object.entries(cfg.routes).map(([name, upstream]) => ({
    name,
    url: routeUrl(name, cfg),
    upstream,
  }));
}

export function edgeStatus(
  cfg: EdgeConfig,
  deps: EdgeStatusDeps = defaultDeps,
): EdgeStatus {
  const n = edgeNames(cfg.org);
  const state = deps.containerState(n.container);
  const issued = deps.issuedNames(cfg);
  const inc = (deps.included ?? includedRouters)(cfg);
  const stk = (deps.stacks ?? stackRouters)(cfg);
  return {
    org: cfg.org,
    container: n.container,
    state,
    up: state === "running",
    ports: cfg.ports,
    network: n.network,
    domains: edgeDomains(cfg),
    routes: edgeRoutes(cfg),
    certNames: issued ?? (cfg.tls.strategy === "none" ? [] : certNames(cfg)),
    certIssuedByDen: issued !== null,
    certIssued: issued !== null,
    https: {
      strategy: cfg.tls.strategy,
      certs:
        cfg.tls.strategy === "mkcert"
          ? "den"
          : cfg.tls.strategy === "files"
            ? "distribution"
            : "none",
      serving: cfg.tls.strategy === "none" ? false : null,
      detail:
        cfg.tls.strategy === "none"
          ? "tls: none: the edge serves http only"
          : "not probed",
    },
    deprecated: { certIssued: CERT_ISSUED_DEPRECATION },
    caTrusted: cfg.tls.strategy === "none" ? null : deps.caTrusted(cfg),
    tls: {
      strategy: cfg.tls.strategy,
      implicit: cfg.tlsFrom === "implicit",
      from: cfg.tlsFrom,
      ca:
        cfg.tls.strategy === "mkcert"
          ? caDir(cfg)
          : cfg.tls.strategy === "files"
            ? cfg.tls.ca
            : null,
    },
    included: inc.routers,
    includedErrors: inc.errors,
    stacks: stk.routers,
    stackErrors: stk.errors,
  };
}

/** One TLS handshake: whether something on host:port speaks TLS. */
export type TlsHandshake = (o: {
  host: string;
  port: number;
  servername: string;
  timeoutMs: number;
}) => Promise<{ ok: boolean; error?: string }>;

/**
 * Connect, complete a TLS handshake, close. Trust is not checked here (that
 * is `caTrusted`): only whether HTTPS is being served at all.
 */
export const tlsHandshake: TlsHandshake = ({
  host,
  port,
  servername,
  timeoutMs,
}) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (v: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(v);
    };
    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(
      () => done({ ok: false, error: `no TLS answer in ${timeoutMs}ms` }),
      timeoutMs,
    );
    socket.once("secureConnect", () => done({ ok: true }));
    socket.once("error", (e: NodeJS.ErrnoException) =>
      done({ ok: false, error: e.code ?? e.message }),
    );
    socket.once("close", () =>
      done({ ok: false, error: "closed before a TLS handshake" }),
    );
  });

/**
 * `st` with `https.serving` probed (MCP-2.5): a TLS handshake on this
 * machine's published https port, named as one of the edge's hosts. Not
 * probed when a proxy in front owns the port (no published ports), and
 * false without a handshake when the edge container is not running.
 */
export async function withHttpsServing(
  st: EdgeStatus,
  cfg: EdgeConfig,
  handshake: TlsHandshake = tlsHandshake,
): Promise<EdgeStatus> {
  if (cfg.tls.strategy === "none") return st;
  const set = (serving: boolean | null, detail: string): EdgeStatus => ({
    ...st,
    https: { ...st.https, serving, detail },
  });
  if (!st.ports)
    return set(
      null,
      "not probed: a proxy in front of the edge owns its ports (edge.publish: false)",
    );
  if (!st.up) return set(false, `the edge container is ${st.state}`);
  const port = st.ports.https;
  const servername = `${Object.keys(cfg.routes)[0] ?? "edge"}.${cfg.domain}`;
  const r = await handshake({
    host: "127.0.0.1",
    port,
    servername,
    timeoutMs: 1500,
  });
  return r.ok
    ? set(true, `TLS handshake answered on 127.0.0.1:${port} (${servername})`)
    : set(
        false,
        `no TLS on 127.0.0.1:${port} (${servername}): ${r.error ?? "failed"}`,
      );
}
