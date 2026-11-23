/**
 * Issue 728: the folders that hold the edge's secrets: its whole state
 * folder (its CA's key under ca/, its TLS key under certs/, its proof and
 * the dynamic/ file carrying it, stacks' generated secrets), and an
 * existing CA named by edge.tls.ca. Read
 * from the resolved edge config, so edge.state_dir and DEN_EDGE_DIR are
 * followed; with DEN_EDGE_DIR, the configured dir is named too, since keys
 * made before the override stay there. An agent's deny rules cover these.
 */
import * as os from "os";
import * as path from "path";
import { readEdgeConfig } from "./config.js";
import { caDir } from "./tls.js";
import type { EdgeConfig } from "./types.js";

export function edgeKeyDirsOf(cfg: EdgeConfig): string[] {
  // The whole edge state folder: its CA and TLS keys, its proof (dynamic/
  // carries it for Traefik) and stacks' generated secrets all live there.
  const dirs = [cfg.stateDir];
  if (cfg.defaultStateDir) dirs.push(cfg.defaultStateDir);
  // A CA named by edge.tls.ca lives outside it.
  dirs.push(caDir(cfg));
  const all = dirs.map((d) => path.resolve(d));
  // Drop a folder already inside another one listed.
  return [...new Set(all)].filter(
    (d, _, xs) => !xs.some((o) => o !== d && d.startsWith(o + path.sep)),
  );
}

/**
 * The parts of an edge state folder that Den protects, each with its writer:
 * the org's CA (tls.ts caDir), the edge's TLS key (tls.ts ensureCerts),
 * the dynamic/ file carrying the proof (runtime.ts edgeUp), stacks'
 * generated secrets (stacks/runtime.ts stackDir), the proof (proof.ts), and
 * the access log, raw and swept (access-sweep.ts: request details).
 */
export const EDGE_SECRET_PARTS = [
  "ca",
  "certs",
  "dynamic",
  "stacks",
  "den-edge-proof",
  "access",
  "edge-access.log",
] as const;

/**
 * For this install's own rules: an edge folder that is, or holds, one of
 * `own` (its state folder, checkout or workspace: edge.state_dir set there)
 * is narrowed to its secret parts, so the agent's own files stay readable.
 */
export function narrowEdgeDirs(dirs: string[], own: string[]): string[] {
  return dirs.flatMap((d) =>
    own.some((o) => o === d || o.startsWith(d + path.sep))
      ? EDGE_SECRET_PARTS.map((p) => path.join(d, p))
      : [d],
  );
}

/**
 * The key folders of the edge `root` configures; none when it has no edge.
 * When its edge config is there but can't be read, keys made before it
 * broke may still sit in the default place, for an org the config can't be
 * trusted to name: then every org's default ca/ and certs/ (an edge.state_dir
 * the broken config named is not known).
 */
export function edgeKeyDirs(root: string): string[] {
  let cfg: EdgeConfig;
  try {
    cfg = readEdgeConfig(root);
  } catch (e) {
    if (/has no `edge:` block/.test((e as Error).message)) return [];
    const share =
      process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    return [path.join(share, "*", "edge")];
  }
  return edgeKeyDirsOf(cfg);
}
