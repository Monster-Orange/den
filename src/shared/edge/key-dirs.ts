/**
 * Issue 728: the folders that hold the edge's private keys: its CA's
 * (rootCA-key.pem, in caDir: the org's own under the edge's state dir, or
 * an existing CA named by edge.tls.ca) and its own TLS key (certs/). Read
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
  const dirs = [caDir(cfg), path.join(cfg.stateDir, "certs")];
  if (cfg.defaultStateDir)
    dirs.push(
      path.join(cfg.defaultStateDir, "ca"),
      path.join(cfg.defaultStateDir, "certs"),
    );
  return [...new Set(dirs.map((d) => path.resolve(d)))];
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
    return ["ca", "certs"].map((d) => path.join(share, "*", "edge", d));
  }
  return edgeKeyDirsOf(cfg);
}
