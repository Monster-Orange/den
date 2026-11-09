/**
 * The running product's names, for code that needs them at runtime.
 *
 * Den never hard-codes a product name: the CLI, env-var prefix, config and
 * manifest file names and directories all come from the distribution's
 * profile (den.yml, see profile.ts). This module is the safe accessor: it
 * never throws, falling back to DEN_PROFILE or Den's own profile when no
 * distribution root can be found (e.g. help text printed outside a checkout).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { getDistRoot } from "./paths.js";
import {
  loadProfile,
  profileFrom,
  readProfileFile,
  type ProductProfile,
} from "./profile.js";

export interface Product extends ProductProfile {
  /**
   * Display name (D11): the org config's brand.name ("Acme Den") when it is
   * safe to show anywhere (TITLE_SAFE), else the name with its first letter
   * upper-cased ("Acme-den").
   */
  title: string;
  /** The YAML manifest file name (".den.yml"). */
  manifestYml: string;
  /** The JSON manifest file name (".den.json"). */
  manifestJson: string;
}

/**
 * What a brand.name may hold to be the display title: letters, digits,
 * spaces, ".", "_" and "-", up to 40. The title is filled into page scripts
 * (inside "…" and '…' strings) and HTML attributes, so no quote, backslash,
 * "<" or "&" may reach it (the 0.4.20 hyphen bug's kin).
 */
export const TITLE_SAFE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

/** The name, first letter upper-cased: "acme-den" → "Acme-den". */
export function nameTitle(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The org config's brand.name, trimmed, or undefined. Never throws. */
export function brandNameAt(root: string | null, configFile: string) {
  if (!root) return undefined;
  try {
    const raw = parseYaml(
      fs.readFileSync(path.join(root, configFile), "utf-8"),
    ) as { brand?: { name?: unknown } } | null;
    const n = raw?.brand?.name;
    return typeof n === "string" && n.trim() ? n.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The display title: a safe brand.name, else nameTitle. */
export function titleOf(name: string, brandName?: string): string {
  return brandName && TITLE_SAFE.test(brandName) ? brandName : nameTitle(name);
}

function withDerived(p: ProductProfile, root: string | null = null): Product {
  const yml = p.manifestFiles[0];
  return {
    ...p,
    title: titleOf(p.name, brandNameAt(root, p.configFile)),
    manifestYml: yml,
    manifestJson: p.manifestFiles[1] ?? yml.replace(/\.ya?ml$/, "") + ".json",
  };
}

let derived: { profile: ProductProfile; product: Product } | null = null;

/** The running product. Never throws. */
export function product(): Product {
  try {
    const root = getDistRoot();
    const profile = loadProfile(root);
    // Same profile object (loadProfile caches it): same derived names.
    if (derived?.profile !== profile)
      derived = { profile, product: withDerived(profile, root) };
    return derived.product;
  } catch {
    const pinned = process.env.DEN_PROFILE?.trim();
    try {
      return withDerived(pinned ? readProfileFile(pinned) : profileFrom());
    } catch {
      return withDerived(profileFrom());
    }
  }
}

/** The env-var name this product uses for `key`: envKey("ROOT") → "DEN_ROOT". */
export function envKey(key: string): string {
  return `${product().envPrefix}_${key}`;
}

/** The value of this product's `key` env var, or undefined. */
export function envValue(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[envKey(key)];
}

/**
 * Placeholders the web pages use for product names; serveFile fills them in.
 * Pages are static files, so they cannot ask the profile themselves.
 */
export function productTokens(p: Product = product()): Record<string, string> {
  return {
    __DEN_CLI__: p.cli,
    __DEN_NAME__: p.name,
    __DEN_TITLE__: p.title,
    __DEN_ENV_PREFIX__: p.envPrefix,
    __DEN_CONFIG_FILE__: p.configFile,
    __DEN_MANIFEST_YML__: p.manifestYml,
    __DEN_MANIFEST_JSON__: p.manifestJson,
    __DEN_SERVICES_DIR__: p.servicesDir,
    __DEN_WORKSPACES_DIR__: p.workspacesDir,
  };
}

/** Replace every product placeholder in `text`. */
export function fillProductTokens(
  text: string,
  p: Product = product(),
): string {
  let out = text;
  for (const [token, value] of Object.entries(productTokens(p)))
    out = out.split(token).join(value);
  return out;
}
