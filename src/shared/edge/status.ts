/**
 * Read-only edge status: what `edge status` shows, as data. The CLI prints
 * it; the web server serves it at /api/edge (and through it the MCP
 * `edge_status` tool).
 */
import * as fs from "fs";
import * as path from "path";
import { certNames, edgeDomains, edgeNames, routeUrl } from "./render.js";
import { caTrusted, containerState } from "./runtime.js";
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
  /** The edge.tls strategy, and whether nothing chose it (implicit mkcert). */
  tls: { strategy: EdgeConfig["tls"]["strategy"]; implicit: boolean };
}

export interface EdgeStatusDeps {
  containerState: (name: string) => string;
  caTrusted: (cfg: EdgeConfig) => boolean | null;
  /** Names on the issued cert (its stamp file), or null when none is issued. */
  issuedNames: (cfg: EdgeConfig) => string[] | null;
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
};

export function edgeStatus(
  cfg: EdgeConfig,
  deps: EdgeStatusDeps = defaultDeps,
): EdgeStatus {
  const n = edgeNames(cfg.org);
  const state = deps.containerState(n.container);
  const issued = deps.issuedNames(cfg);
  return {
    org: cfg.org,
    container: n.container,
    state,
    up: state === "running",
    ports: cfg.ports,
    network: n.network,
    domains: edgeDomains(cfg),
    routes: Object.entries(cfg.routes).map(([name, upstream]) => ({
      name,
      url: routeUrl(name, cfg),
      upstream,
    })),
    certNames: issued ?? (cfg.tls.strategy === "none" ? [] : certNames(cfg)),
    certIssued: issued !== null,
    caTrusted: cfg.tls.strategy === "none" ? null : deps.caTrusted(cfg),
    tls: { strategy: cfg.tls.strategy, implicit: cfg.tlsFrom === "implicit" },
  };
}
