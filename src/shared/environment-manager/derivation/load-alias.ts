/**
 * The alias resolver for this machine: built-in topology, the team's
 * `graph.aliases`, and every repo in the engineer's catalog.
 */
import { readDenConfig } from "../../den-config.js";
import { readCatalog } from "../catalog.js";
import { buildAliasResolver, type AliasResolver } from "./alias.js";

export function loadAliasResolver(): AliasResolver {
  return buildAliasResolver(readDenConfig().graph, Object.keys(readCatalog()));
}
