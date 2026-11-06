/**
 * Read-only edge status: what `edge status` shows, as data. The CLI prints
 * it; the web server serves it at /api/edge (and through it the MCP
 * `edge_status` tool).
 */
import * as fs from "fs";
import * as path from "path";
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
  certIssued: boolean;
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
    certIssued: issued !== null,
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
