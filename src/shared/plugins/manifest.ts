/**
 * The plugin contract, den.plugin/v1 (PL-1a): a `den-plugin.json` naming what
 * a plugin provides (one entry per extension point) and the capabilities it
 * needs. See schemas/den.plugin.v1.json.
 *
 * A directory that holds only a `den-theme.json` is an implicit theme plugin,
 * `{provides: [{kind: "theme", manifest: "den-theme.json"}], capabilities: []}`,
 * so every published and local theme keeps working unchanged.
 *
 * validatePluginDir checks the schema, each provided kind with its own
 * validator (a theme with the den.theme/v1 validator, a page's entry module
 * on disk) and admission rules 1-3:
 *   1. it names a maintainer (the schema requires one);
 *   2. a README says its tier, what it may touch and what it must never do
 *      (files-tier plugins, themes among them, are exempt);
 *   3. an SPDX license (the rule den.theme/v1 has), and every bundled font
 *      licensed (the theme validator's rule).
 */
import * as fs from "fs";
import * as path from "path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { getEngineRoot } from "../paths.js";
import {
  THEME_FILE,
  schemaIssues,
  validateThemeDir,
  type ContrastFailure,
  type ThemeManifest,
} from "../theme/contract.js";

export const PLUGIN_SCHEMA_ID = "den.plugin/v1";
export const PLUGIN_FILE = "den-plugin.json";
/** A plugin id, and so its directory's name. */
export const PLUGIN_ID = /^[a-z][a-z0-9-]{1,39}$/;
/** Den's own id: its built-in theme. A distribution plugin may not use it. */
export const BUILTIN_ID = "den";

export type PluginTier = "files" | "browser" | "server";

/** Every kind, by tier (PL-SPEC §4). */
export const KIND_TIERS: Readonly<Record<string, PluginTier>> = {
  theme: "files",
  catalog: "files",
  "persona-pack": "files",
  page: "browser",
  "mcp-tools": "server",
  "work-items": "server",
  runtime: "server",
  "session-backend": "server",
  notifier: "server",
  secrets: "server",
  identity: "server",
  "health-source": "server",
};

export interface PluginProvide {
  kind: string;
  /** kind theme: the den-theme.json, relative to the plugin. */
  manifest?: string;
  /** kind page: the ES module, relative to the plugin. */
  entry?: string;
  nav?: { group: string; label: string; icon?: string };
  [field: string]: unknown;
}

export interface PluginManifest {
  schema: typeof PLUGIN_SCHEMA_ID;
  id: string;
  name: string;
  version: string;
  license: string;
  den: string;
  maintainer: string;
  description?: string;
  homepage?: string;
  readme?: string;
  provides: PluginProvide[];
  capabilities?: string[];
}

/** A plugin as Den sees it, whichever manifest it came from. */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  /** Derived from provides, in order, once each (the lock's `kinds`). */
  kinds: string[];
  /** Declared capabilities; for a local plugin, its approved set. */
  capabilities: string[];
  tier: PluginTier;
  /** The file it was read from: den-plugin.json or den-theme.json. */
  manifestFile: string;
  /** True for a directory holding only a den-theme.json. */
  implicit: boolean;
  /** The parsed den-plugin.json (absent for an implicit theme plugin). */
  manifest?: PluginManifest;
  /** The theme it provides, when it validated. */
  theme?: ThemeManifest;
}

export interface PluginIssue {
  /** Where: a file in the plugin, with a JSON pointer ("den-plugin.json#/id"). */
  at: string;
  message: string;
}

export interface PluginValidation {
  ok: boolean;
  /** The manifest it was read from, or null when the dir has neither. */
  manifestFile: string | null;
  plugin?: PluginInfo;
  issues: PluginIssue[];
  contrast: ContrastFailure[];
}

/**
 * Capabilities that act, rather than only read or add a nav entry. A local
 * plugin declaring one gets the git warning (see plugin validate).
 */
export function actingCapabilities(capabilities: string[]): string[] {
  return capabilities.filter((c) =>
    /^(api\.actions|secrets|exec|net|send):/.test(c),
  );
}

export function tierOf(kinds: string[]): PluginTier {
  const tiers = kinds.map((k) => KIND_TIERS[k] ?? "server");
  return tiers.includes("server")
    ? "server"
    : tiers.includes("browser")
      ? "browser"
      : "files";
}

let validator: ReturnType<InstanceType<typeof Ajv2020>["compile"]> | null =
  null;

function schemaValidator() {
  if (validator) return validator;
  const read = (f: string) =>
    JSON.parse(
      fs.readFileSync(path.join(getEngineRoot(), "schemas", f), "utf-8"),
    ) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  // den.plugin/v1 takes its id, version and SPDX license rules from
  // den.theme/v1 by $ref, so the two never diverge.
  ajv.addSchema(read("den.theme.v1.json"));
  validator = ajv.compile(read("den.plugin.v1.json"));
  return validator;
}

const CAPABILITY_MESSAGE =
  "unknown capability: the vocabulary is ui.nav, api.read, api.actions:<id,...>, secrets:<ref,...>, net:<host,...>, exec:<binary,...>, send:<channel>";

function pluginMessage(e: {
  instancePath: string;
  keyword: string;
}): string | null {
  if (/^\/capabilities\/\d+$/.test(e.instancePath) && e.keyword === "pattern")
    return CAPABILITY_MESSAGE;
  return null;
}

/**
 * Files in `dir` that are symlinks, relative. A plugin is vendored and
 * served by path, so a link could reach outside it.
 */
function symlinksIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), {
      withFileTypes: true,
    })) {
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push(r);
      else if (e.isDirectory()) walk(r);
    }
  };
  walk("");
  return out;
}

/** `rel` inside `root` as an absolute path, or null when it escapes. */
function inside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs.startsWith(path.resolve(root) + path.sep) ? abs : null;
}

/**
 * Admission rule 2: a browser- or server-tier plugin has a README that says
 * its tier, what it may touch and what it must never do. Den can check the
 * file is there, names the tier and says "never"; the words are for review.
 */
function readmeIssues(
  dir: string,
  m: PluginManifest,
  tier: PluginTier,
): PluginIssue[] {
  if (tier === "files") return [];
  const rel = m.readme ?? "README.md";
  const abs = inside(dir, rel);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile())
    return [
      {
        at: rel,
        message: `missing: a ${tier}-tier plugin needs a README that says its tier, what it may touch (its capabilities, in words) and what it must never do`,
      },
    ];
  const text = fs.readFileSync(abs, "utf-8");
  const missing = [
    new RegExp(`\\b${tier}\\b`, "i").test(text) ? null : `its tier (${tier})`,
    /\bnever\b/i.test(text) ? null : "what it must never do",
  ].filter((x): x is string => !!x);
  return missing.length
    ? [{ at: rel, message: `does not say ${missing.join(" or ")}` }]
    : [];
}

/**
 * Validate the plugin in `dir`: den-plugin.json, or an implicit theme plugin
 * (den-theme.json only). With `expectId`, the manifest's id must match its
 * directory. A directory with neither manifest is an error, never skipped
 * (PL-1a): an id can't collide unseen.
 */
export function validatePluginDir(
  dir: string,
  opts: { expectId?: string } = {},
): PluginValidation {
  const pluginFile = path.join(dir, PLUGIN_FILE);
  if (!fs.existsSync(pluginFile)) {
    if (!fs.existsSync(path.join(dir, THEME_FILE)))
      return {
        ok: false,
        manifestFile: null,
        issues: [
          {
            at: "",
            message: `no ${PLUGIN_FILE} or ${THEME_FILE}: a plugin needs a manifest`,
          },
        ],
        contrast: [],
      };
    // An implicit theme plugin: the theme validator is the whole check.
    const v = validateThemeDir(dir, opts);
    return {
      ok: v.ok,
      manifestFile: THEME_FILE,
      issues: v.issues,
      contrast: v.contrast,
      ...(v.theme
        ? {
            plugin: {
              id: v.theme.id,
              name: v.theme.name,
              version: v.theme.version,
              kinds: ["theme"],
              capabilities: [],
              tier: "files",
              manifestFile: THEME_FILE,
              implicit: true,
              theme: v.theme,
            },
          }
        : {}),
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(pluginFile, "utf-8"));
  } catch (e) {
    return {
      ok: false,
      manifestFile: PLUGIN_FILE,
      issues: [
        {
          at: PLUGIN_FILE,
          message: `not valid JSON: ${(e as Error).message}`,
        },
      ],
      contrast: [],
    };
  }
  const validate = schemaValidator();
  if (!validate(raw))
    return {
      ok: false,
      manifestFile: PLUGIN_FILE,
      issues: schemaIssues(validate.errors, pluginMessage).map((i) => ({
        at: `${PLUGIN_FILE}${i.at ? `#${i.at}` : ""}`,
        message: i.message,
      })),
      contrast: [],
    };

  const m = raw as PluginManifest;
  const kinds = m.provides
    .map((p) => p.kind)
    .filter((k, i, a) => a.indexOf(k) === i);
  const tier = tierOf(kinds);
  const issues: PluginIssue[] = [];
  const contrast: ContrastFailure[] = [];
  let theme: ThemeManifest | undefined;
  if (opts.expectId && m.id !== opts.expectId)
    issues.push({
      at: `${PLUGIN_FILE}#/id`,
      message: `id "${m.id}" does not match its directory "${opts.expectId}"`,
    });

  // Each kind's own validator. Kinds without one yet (catalog, persona-pack,
  // the server tier) are checked by the schema only, until their slice.
  m.provides.forEach((p, i) => {
    const at = `${PLUGIN_FILE}#/provides/${i}`;
    if (p.kind === "theme" && p.manifest) {
      const abs = inside(dir, p.manifest);
      if (!abs || !fs.existsSync(abs)) {
        issues.push({ at, message: `${p.manifest} is missing` });
        return;
      }
      const v = validateThemeDir(path.dirname(abs), { expectId: m.id });
      for (const t of v.issues)
        issues.push({
          at: `${p.manifest}${t.at ? `#${t.at}` : ""}`,
          message: t.message,
        });
      contrast.push(...v.contrast);
      theme = v.theme;
    } else if (p.kind === "page" && p.entry) {
      const abs = inside(dir, p.entry);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile())
        issues.push({ at, message: `${p.entry} is missing` });
    }
  });
  issues.push(...readmeIssues(dir, m, tier));
  for (const link of symlinksIn(dir))
    issues.push({
      at: link,
      message: "is a symlink: a plugin's files must be its own",
    });

  return {
    ok: issues.length === 0 && contrast.length === 0,
    manifestFile: PLUGIN_FILE,
    plugin: {
      id: m.id,
      name: m.name,
      version: m.version,
      kinds,
      capabilities: m.capabilities ?? [],
      tier,
      manifestFile: PLUGIN_FILE,
      implicit: false,
      manifest: m,
      ...(theme ? { theme } : {}),
    },
    issues,
    contrast,
  };
}

/**
 * The directory holding the theme a plugin provides: the plugin itself for
 * an implicit theme plugin, else the directory of its theme provide's
 * manifest. Null when it provides no theme. Reads den-plugin.json without
 * the schema (the runtime validates the theme itself), so it only trusts a
 * manifest path that stays inside the plugin.
 */
export function themeDirIn(pluginDir: string): string | null {
  const file = path.join(pluginDir, PLUGIN_FILE);
  if (!fs.existsSync(file))
    return fs.existsSync(path.join(pluginDir, THEME_FILE)) ? pluginDir : null;
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      provides?: { kind?: unknown; manifest?: unknown }[];
    };
    const p = (Array.isArray(m.provides) ? m.provides : []).find(
      (x) => x?.kind === "theme" && typeof x.manifest === "string",
    );
    if (!p) return null;
    const rel = p.manifest as string;
    if (path.basename(rel) !== THEME_FILE) return null;
    const abs = inside(pluginDir, rel);
    return abs && fs.existsSync(abs) ? path.dirname(abs) : null;
  } catch {
    return null;
  }
}
