/**
 * Rule C — event choreography (EventBridge).
 *
 * A consumer declares an EventBridge rule whose `event_pattern.source` names the
 * upstream producer (e.g. `acme.orders`). Each source string is resolved
 * through the org's `graph.aliases`, so no namespace is hard-wired.
 * Scanning the consumer's IaC therefore recovers a directed producer→consumer
 * flow edge — no `.den.yml` needed. Event edges are shown in the graph but
 * never gate startup (the bus buffers), so they are always `soft`.
 *
 * Wildcard patterns (`{"prefix": "acme."}`) match many sources and can't be
 * attributed to a single producer, so they are skipped.
 */

import type { AliasResolver } from "./alias.js";
import type { DerivedEdge, ScannedRepo } from "./types.js";
import { evidenceAt, isCommentedLine } from "./text.js";

const IAC_FILE = /\.py$/;
const SOURCE_BLOCK = /["']source["']\s*:\s*\[([^\]]*)\]/g;
const SOURCE_STRING = /["']([A-Za-z0-9_.-]+)["']/g;

export function deriveEventEdges(
  repo: ScannedRepo,
  alias: AliasResolver,
): DerivedEdge[] {
  const out: DerivedEdge[] = [];
  for (const file of repo.files) {
    if (!IAC_FILE.test(file.rel)) continue;
    for (const block of file.content.matchAll(SOURCE_BLOCK)) {
      const group = block[1];
      if (group.includes("prefix")) continue; // wildcard — unattributable
      if (isCommentedLine(file.content, block.index ?? 0)) continue;
      for (const src of group.matchAll(SOURCE_STRING)) {
        const producer = alias.resolve(src[1]);
        if (!producer || producer === repo.repoName) continue;
        out.push({
          from: producer,
          to: repo.repoName,
          kind: "event",
          blocking: "soft",
          signal: "event:eventbridge-rule",
          evidence: evidenceAt(file, block.index ?? 0),
          confidence: "high",
        });
      }
    }
  }
  return out;
}
