/**
 * MCP-2.4: why a service has no health verdict, in words. A row with `ok:
 * null` and no reason reads as "broken" to an agent (it fell back to
 * `docker ps`); every unchecked row says which of these it is. One rule for
 * the web health row (/api/health) and the MCP `status` tool, which derives
 * it from a row an older web server served without one.
 */
import { product } from "../product.js";
import type { Runs } from "../manifest/placement.js";

export interface NotCheckedInput {
  /** The env being viewed. */
  env: string;
  runs: Runs | undefined;
  /** A remote service's target (its env), when it has one. */
  target?: { env?: string } | null;
  /** false when the repo has no manifest at all. */
  manifest?: boolean;
  /** The conventional probe tried (and not answered 2xx), if any. */
  conventional?: string | null;
}

export function notCheckedReason(o: NotCheckedInput): string {
  if (o.manifest === false)
    return `not checked: the repo has no ${product().manifestYml}`;
  if (o.runs === "remote") {
    const where = o.target?.env ?? o.env;
    return (
      `not checked: remote (runs in ${where}), and the manifest declares ` +
      `no health check or target.url for ${where}`
    );
  }
  if (o.runs === "none" || o.runs === undefined)
    return (
      `not checked: not deployed in ${o.env} (the manifest has no ` +
      `commands and no health check for ${o.env})`
    );
  return (
    `not checked: no health check in the manifest for ${o.env}` +
    (o.conventional ? `, and ${o.conventional} did not answer 2xx` : "")
  );
}
