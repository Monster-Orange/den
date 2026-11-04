/**
 * Rule — declared compose dependencies.
 *
 * A repo's `.den.yml` `compose.uses` names the stacks it calls. That is an
 * explicit declaration, so each entry is a hard http edge.
 */
import { parse as parseYaml } from "yaml";
import type { AliasResolver } from "./alias.js";
import type { DerivedEdge, ScannedRepo } from "./types.js";

import { product } from "../../product.js";
export function deriveComposeEdges(
  repo: ScannedRepo,
  alias: AliasResolver,
): DerivedEdge[] {
  const file = repo.files.find((f) => f.rel === `${product().manifestYml}`);
  if (!file) return [];
  let uses: unknown;
  try {
    uses = (parseYaml(file.content) as { compose?: { uses?: unknown } })
      ?.compose?.uses;
  } catch {
    return [];
  }
  if (!Array.isArray(uses)) return [];
  const out: DerivedEdge[] = [];
  for (const u of uses) {
    if (typeof u !== "string") continue;
    const to = alias.resolve(u);
    if (!to || to === repo.repoName) continue;
    out.push({
      from: repo.repoName,
      to,
      kind: "http",
      blocking: "hard",
      signal: "compose:uses",
      evidence: `${product().manifestYml} compose.uses: ${u}`,
      confidence: "high",
    });
  }
  return out;
}
