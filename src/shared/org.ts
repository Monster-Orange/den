/**
 * The org this den instance serves: the root of
 * Org > Application > Repo > Services. One instance = one org.
 *
 *   org:
 *     id: globex      # defaults to edge.org
 *     title: Globex   # defaults to the id
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { getDistRoot } from "./paths.js";

import { product } from "./product.js";
export interface OrgConfig {
  id?: string;
  title?: string;
}

export interface Org {
  id: string;
  title: string;
}

/** Pure: the org from a parsed config/den.yml, or undefined if unnamed. */
export function resolveOrg(
  parsed: { org?: OrgConfig; edge?: { org?: string } } | null | undefined,
): Org | undefined {
  const id = parsed?.org?.id?.trim() || parsed?.edge?.org?.trim();
  if (!id) return undefined;
  return { id, title: parsed?.org?.title?.trim() || id };
}

export function readOrg(root: string = getDistRoot()): Org | undefined {
  try {
    return resolveOrg(
      yaml.parse(
        fs.readFileSync(path.join(root, product().configFile), "utf-8"),
      ),
    );
  } catch {
    return undefined;
  }
}
