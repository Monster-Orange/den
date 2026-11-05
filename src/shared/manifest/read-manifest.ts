/**
 * Manifest reader — supports .den.yml (preferred) and .den.json (fallback).
 *
 * Import this helper instead of calling fs.readFileSync('.den.json') directly
 * so all callers automatically get YAML support.
 *
 * A repo's own manifest always wins. When a checkout has none, Den's own
 * copy is used: `manifests/<github-repo>.den.yml` in the Den repo, keyed by
 * the checkout's `origin` repo name. That covers repos whose manifest is not
 * merged yet and repos Den should not commit to.
 *
 * Whichever base won, `manifests/<github-repo>.override.yml` (when present)
 * is deep-merged on top: see merge-override.ts for the rules.
 */

import * as fs from "fs";
import * as path from "path";
import { readOriginUrl } from "../git/origin-url.js";
import { getDistRoot } from "../paths.js";
import { parse as parseYaml } from "yaml";
import type { RawManifest } from "../types/index.js";

import { product } from "../product.js";
import { mergeOverride } from "./merge-override.js";
/** Names probed in order. First match wins. */
const MANIFEST_NAMES = [
  `${product().manifestYml}`,
  `${product().manifestJson}`,
] as const;

/** The repo's own manifest file, or null. */
export function repoManifestPath(repoPath: string): string | null {
  for (const name of MANIFEST_NAMES) {
    const p = path.join(repoPath, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Den-held manifests ───────────────────────────────────────────────────
// For a repo that doesn't carry a manifest yet (one we don't commit to, or
// whose PR hasn't merged), den keeps one in manifests/<repo>.den.yml,
// keyed by the git origin's repo name (falling back to the folder name). The
// repo's own file always wins.

const originCache = new Map<string, string | null>();

/** Repo name of `repoPath`'s git origin (`…/<name>.git`), cached. */
export function originRepoName(repoPath: string): string | null {
  if (originCache.has(repoPath)) return originCache.get(repoPath)!;
  // Read from the git config file, never by spawning git: this runs on the
  // web server's request path for every repo without its own manifest.
  const url = readOriginUrl(repoPath);
  const name = url
    ? url
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .pop() || null
    : null;
  originCache.set(repoPath, name);
  return name;
}

/** Directory of den-held manifests (override: DEN_MANIFESTS_DIR). */
export function heldManifestsDir(): string {
  return process.env.DEN_MANIFESTS_DIR ?? path.join(getDistRoot(), "manifests");
}

/** The repo name of a `.den-services/<repo>/<branch>` path, else null. */
function managedCloneRepo(repoPath: string): string | null {
  const parent = path.dirname(repoPath);
  return path.basename(path.dirname(parent)) === `${product().servicesDir}`
    ? path.basename(parent)
    : null;
}

/** The names `repoPath` is known by: origin repo, managed clone, folder. */
function repoKeys(repoPath: string): string[] {
  return [
    originRepoName(repoPath),
    // A managed clone lives at .den-services/<repo>/<branch>,
    // and need not be cloned yet.
    managedCloneRepo(repoPath),
    path.basename(repoPath),
  ].filter((k): k is string => !!k);
}

/** The first `manifests/<key><suffix>` that exists, or null. */
function heldFile(repoPath: string, suffix: string): string | null {
  for (const key of repoKeys(repoPath)) {
    const p = path.join(heldManifestsDir(), `${key}${suffix}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** The den-held manifest for `repoPath`, or null. */
export function heldManifestPath(repoPath: string): string | null {
  return heldFile(repoPath, `${product().manifestYml}`);
}

/**
 * The override suffix: `.override` plus the manifest's extension, so a
 * profile whose manifest is `.acme.yml` reads `manifests/<repo>.override.yml`.
 */
export function overrideSuffix(): string {
  return `.override${path.extname(product().manifestYml) || ".yml"}`;
}

/**
 * The override for `repoPath` (`manifests/<repo>.override.yml`), or null.
 * Matched by the same names, in the same order, as the held manifest.
 */
export function overrideManifestPath(repoPath: string): string | null {
  return heldFile(repoPath, overrideSuffix());
}

/**
 * Resolve the base manifest for `repoPath`: the repo's own .den.yml (or
 * .json), else the one den holds for it. Returns null if neither exists.
 * An override is layered on top by readManifest; it is never a base.
 */
export function resolveManifestPath(repoPath: string): string | null {
  return repoManifestPath(repoPath) ?? heldManifestPath(repoPath);
}

/** Where `repoPath`'s base manifest comes from. */
export function manifestSource(repoPath: string): "repo" | "held" | null {
  if (repoManifestPath(repoPath)) return "repo";
  return heldManifestPath(repoPath) ? "held" : null;
}

// ── Layers ───────────────────────────────────────────────────────────────

/** A layer of a resolved manifest. The base comes first. */
export type ManifestLayer = "repo" | "held" | "override";

export interface ManifestLoad {
  /** The merged manifest, or null when none is usable. */
  manifest: RawManifest | null;
  /** The layers that applied, base first: e.g. ["repo", "override"]. */
  layers: ManifestLayer[];
  /** The base manifest file (repo or held), or null. */
  baseFile: string | null;
  /** The base's layer, or null when there is no base. */
  baseLayer: "repo" | "held" | null;
  /** The override file, or null. */
  overrideFile: string | null;
  /** Why no manifest is usable, when files exist but cannot be used. */
  error?: string;
}

/** Parse a manifest file's text: a map, or null for anything else. */
export function parseManifestText(
  filePath: string,
  raw: string,
): Record<string, unknown> | null {
  const parsed: unknown = filePath.endsWith(".json")
    ? JSON.parse(raw)
    : parseYaml(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    return null; // scalar/array/empty manifest is not usable
  return parsed as Record<string, unknown>;
}

/**
 * Parsed manifests by file, reused while the file's text is unchanged. A
 * single web request reads the same manifests several times (kind, health
 * plan, stack names, edge links), and parsing YAML is the expensive part:
 * it held the event loop ~100-200ms per /api/health run. Callers get their
 * own copy, so mutating a result never leaks into the cache.
 */
const parsedCache = new Map<
  string,
  { raw: string; parsed: Record<string, unknown> | null }
>();

function parseCached(
  file: string,
  raw: string,
): Record<string, unknown> | null {
  const hit = parsedCache.get(file);
  if (hit && hit.raw === raw) return hit.parsed && structuredClone(hit.parsed);
  const parsed = parseManifestText(file, raw);
  parsedCache.set(file, { raw, parsed });
  return parsed && structuredClone(parsed);
}

/** The message for an override that has no base to apply to. */
export function orphanOverrideMessage(): string {
  return `an override with no base manifest is not a manifest: add a ${product().manifestYml} to the repo, or to manifests/`;
}

interface Located {
  baseFile: string | null;
  baseLayer: "repo" | "held" | null;
  overrideFile: string | null;
}

function locate(repoPath: string): Located {
  const own = repoManifestPath(repoPath);
  const held = own ? null : heldManifestPath(repoPath);
  return {
    baseFile: own ?? held,
    baseLayer: own ? "repo" : held ? "held" : null,
    overrideFile: overrideManifestPath(repoPath),
  };
}

/** Parse and merge the located files' texts. Never throws. */
function combine(
  at: Located,
  baseRaw: string | null,
  overrideRaw: string | null,
): ManifestLoad {
  const out: ManifestLoad = { manifest: null, layers: [], ...at };
  const parse = (file: string, raw: string): Record<string, unknown> => {
    const parsed = parseCached(file, raw);
    if (!parsed) throw new Error(`${file}: not a map`);
    return parsed;
  };
  if (!at.baseFile || !at.baseLayer || baseRaw === null) {
    if (at.overrideFile)
      out.error = `${at.overrideFile}: ${orphanOverrideMessage()}`;
    return out;
  }
  try {
    let manifest = parse(at.baseFile, baseRaw);
    const layers: ManifestLayer[] = [at.baseLayer];
    if (at.overrideFile && overrideRaw !== null) {
      manifest = mergeOverride(manifest, parse(at.overrideFile, overrideRaw));
      layers.push("override");
    }
    out.manifest = manifest as unknown as RawManifest;
    out.layers = layers;
  } catch (e) {
    out.error = (e as Error).message;
  }
  return out;
}

/** Resolve, read and merge `repoPath`'s manifest layers. Never throws. */
export function loadManifest(repoPath: string): ManifestLoad {
  const at = locate(repoPath);
  try {
    return combine(
      at,
      at.baseFile && fs.readFileSync(at.baseFile, "utf-8"),
      at.overrideFile && fs.readFileSync(at.overrideFile, "utf-8"),
    );
  } catch (e) {
    return { manifest: null, layers: [], ...at, error: (e as Error).message };
  }
}

/** The layers of `repoPath`'s manifest that applied, e.g. ["held", "override"]. */
export function manifestLayers(repoPath: string): ManifestLayer[] {
  return loadManifest(repoPath).layers;
}

/** "repo", "held + override", … ("none" when no manifest applied). */
export function manifestLayersLabel(layers: readonly ManifestLayer[]): string {
  return layers.length > 0 ? layers.join(" + ") : "none";
}

/**
 * Read and parse the manifest from `repoPath`, its override merged in.
 * Supports both YAML and JSON.
 * Returns null if no manifest file exists or parsing fails.
 */
export function readManifest(repoPath: string): RawManifest | null {
  return loadManifest(repoPath).manifest;
}

/**
 * Async version of readManifest.
 */
export async function readManifestAsync(
  repoPath: string,
): Promise<RawManifest | null> {
  const at = locate(repoPath);
  try {
    const { readFile } = await import("fs/promises");
    return combine(
      at,
      at.baseFile && (await readFile(at.baseFile, "utf-8")),
      at.overrideFile && (await readFile(at.overrideFile, "utf-8")),
    ).manifest;
  } catch {
    return null;
  }
}

/** The canonical manifest filename for display/error messages. */
export const MANIFEST_DISPLAY_NAME = `${product().manifestYml}`;
