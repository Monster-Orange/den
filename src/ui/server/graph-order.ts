/**
 * The dependency graph's top-down repo order (entry repo first, infra last),
 * which the health row and /api/services rank by.
 *
 * Deriving the graph walks every repo's sources (fingerprints, scans), so it
 * is far too slow to redo on each 5s poll. In the web server it is kept for
 * 30s and then recomputed after the request that noticed, never inside it
 * (read-cache.ts); a stale order only means a briefly stale sort.
 */
import { deriveGraph } from "../../shared/environment-manager/derivation/derive-graph.js";
import { orderForDown } from "../../shared/environment-manager/derivation/derived-up.js";
import { cachedReadStale } from "../../shared/read-cache.js";

const GRAPH_ORDER_MAX_AGE_MS = 30_000;

export function graphOrder(workspace: string | undefined): string[] {
  return cachedReadStale(
    `graph-order:${workspace ?? ""}`,
    GRAPH_ORDER_MAX_AGE_MS,
    () => orderForDown(deriveGraph({ scope: "all", workspace })),
  );
}
