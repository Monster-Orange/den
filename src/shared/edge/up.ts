/**
 * `edge up`, as the CLI and Settings (issue 395) both run it: the edge from
 * the config, then the running stacks rejoin its networks so their routes
 * stay up. One function, so the page never does less than the command.
 */
import { rejoinRunningStacks } from "../stacks/status.js";
import { readEdgeConfig } from "./config.js";
import { edgeUp } from "./runtime.js";
import type { EdgeConfig } from "./types.js";

export async function runEdgeUp(
  opts: {
    cfg?: EdgeConfig;
    takeOver?: boolean;
    rotateProof?: boolean;
    log?: (line: string) => void;
  } = {},
) {
  const cfg = opts.cfg ?? readEdgeConfig();
  const r = await edgeUp(cfg, {
    takeOver: opts.takeOver,
    rotateProof: opts.rotateProof,
    log: opts.log,
  });
  rejoinRunningStacks(opts.log);
  return { cfg, ...r };
}
