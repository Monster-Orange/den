/**
 * The running product's names, for code that needs them at runtime.
 *
 * Den never hard-codes a product name: the CLI, env-var prefix, config and
 * manifest file names and directories all come from the distribution's
 * profile (den.yml, see profile.ts). This module is the safe accessor: it
 * never throws, falling back to DEN_PROFILE or Den's own profile when no
 * distribution root can be found (e.g. help text printed outside a checkout).
 */

import { getDistRoot } from "./paths.js";
import {
  loadProfile,
  profileFrom,
  readProfileFile,
  type ProductProfile,
} from "./profile.js";

export interface Product extends ProductProfile {
  /** Display name: the name with its first letter upper-cased ("Den"). */
  title: string;
  /** The YAML manifest file name (".den.yml"). */
  manifestYml: string;
  /** The JSON manifest file name (".den.json"). */
  manifestJson: string;
}

function withDerived(p: ProductProfile): Product {
  const yml = p.manifestFiles[0];
  return {
    ...p,
    title: p.name.charAt(0).toUpperCase() + p.name.slice(1),
    manifestYml: yml,
    manifestJson: p.manifestFiles[1] ?? yml.replace(/\.ya?ml$/, "") + ".json",
  };
}

let derived: { profile: ProductProfile; product: Product } | null = null;

/** The running product. Never throws. */
export function product(): Product {
  try {
    const profile = loadProfile(getDistRoot());
    // Same profile object (loadProfile caches it): same derived names.
    if (derived?.profile !== profile)
      derived = { profile, product: withDerived(profile) };
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
