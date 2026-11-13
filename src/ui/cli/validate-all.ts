/**
 * Bare `<cli> validate` in the distribution root: every manifest the
 * distribution uses, without cloning anything.
 *
 * - Each repo of every workspace, once per distinct checkout path: its
 *   layered manifest (own or held, then the override, then the merge).
 * - A repo with no checkout on disk (a managed clone not made yet, a
 *   dev-managed path that is gone) falls back to its held manifest, marked
 *   "held only, no checkout"; with no held manifest either it is a warning,
 *   not a failure.
 * - Each held manifest (and override) in manifests/ that no repo above used.
 *
 * The layered validator comes in as `validate` (validateManifestLayers), so
 * this file stays under the typecheck gate (see validate-layers.ts).
 *
 * `--held` checks only manifests/, as if nothing were checked out: a result
 * that does not depend on the machine (an upgrade gate).
 */
import * as fs from "fs";
import * as path from "path";
import { product } from "../../shared/product.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import {
  readWorkspacesFile,
  resolveServiceSource,
} from "../../shared/environment-manager/workspaces.js";
import {
  heldManifestsDir,
  overrideSuffix,
} from "../../shared/manifest/read-manifest.js";
import type { LayeredValidation } from "../../shared/manifest/validate-layers.js";

export interface RepoValidation {
  repo: string;
  /** The checkout validated, or null when only manifests/ was read. */
  checkout: string | null;
  /** Workspaces that use this checkout. */
  workspaces: string[];
  /** own | held, plus "+ override" when one layered on. */
  source: string;
  /** Set when there was no checkout and the held manifest stood in. */
  note?: string;
  /** No checkout and no held manifest: reported, not failed. */
  missing?: boolean;
  result: LayeredValidation;
}

/**
 * A path that never exists, named after the repo, so the layer lookup finds
 * only manifests/<repo>… and never a checkout's own manifest.
 */
function heldOnlyPath(repo: string): string {
  return path.join(heldManifestsDir(), ".held-only", repo);
}

function sourceOf(result: LayeredValidation): string {
  const base = result.layers.find(
    (l) => l.layer === "repo" || l.layer === "held",
  );
  const own = base?.layer === "repo" ? "own" : base ? "held" : "none";
  return result.layers.some((l) => l.layer === "override")
    ? `${own} + override`
    : own;
}

/** The repo keys manifests/ holds a manifest or an override for. */
function heldKeys(): string[] {
  const dir = heldManifestsDir();
  if (!fs.existsSync(dir)) return [];
  const yml = product().manifestYml;
  const over = overrideSuffix();
  const keys = new Set<string>();
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(over)) keys.add(name.slice(0, -over.length));
    else if (name.endsWith(yml)) keys.add(name.slice(0, -yml.length));
  }
  return [...keys].sort();
}

type Validate = (repoPath: string) => LayeredValidation;

function heldOnly(repo: string, validate: Validate): RepoValidation {
  const result = validate(heldOnlyPath(repo));
  return {
    repo,
    checkout: null,
    workspaces: [],
    source: sourceOf(result),
    result,
  };
}

export function validateAll(opts: {
  held?: boolean;
  validate: Validate;
}): RepoValidation[] {
  const { validate } = opts;
  if (opts.held)
    return heldKeys().map((k) => {
      const r = heldOnly(k, validate);
      // An override with no held base layers onto the repo's own manifest,
      // which --held deliberately does not read: noted, not failed.
      const overrideOnly =
        r.result.layers.length > 0 &&
        r.result.layers.every((l) => l.layer === "override");
      return overrideOnly
        ? {
            ...r,
            source: "override",
            missing: true,
            note: "override only: its base is the repo's own manifest (not read with --held)",
          }
        : r;
    });

  const file = readWorkspacesFile();
  const catalog = readCatalog();
  // repo + checkout path → the workspaces that use it.
  const seen = new Map<
    string,
    { repo: string; path: string; workspaces: string[] }
  >();
  for (const [ws, config] of Object.entries(file.workspaces)) {
    for (const address of Object.keys(config.services ?? {})) {
      const src = resolveServiceSource(address, ws, config, catalog);
      const repo = src?.repoName ?? address.split("/")[0];
      const p = src?.repoPath ? path.resolve(src.repoPath) : "";
      const key = `${repo}\0${p}`;
      const hit = seen.get(key);
      if (hit) {
        if (!hit.workspaces.includes(ws)) hit.workspaces.push(ws);
      } else seen.set(key, { repo, path: p, workspaces: [ws] });
    }
  }

  const out: RepoValidation[] = [];
  const used = new Set<string>();
  for (const { repo, path: p, workspaces } of seen.values()) {
    used.add(repo);
    if (p && fs.existsSync(p)) {
      const result = validate(p);
      out.push({
        repo,
        checkout: p,
        workspaces,
        source: sourceOf(result),
        result,
        ...(result.layers.length === 0 ? { missing: true } : {}),
      });
      continue;
    }
    const held = heldOnly(repo, validate);
    out.push({
      ...held,
      checkout: p || null,
      workspaces,
      ...(held.result.layers.length
        ? { note: "held only, no checkout" }
        : { missing: true, note: "no checkout and no held manifest" }),
    });
  }
  for (const key of heldKeys())
    if (!used.has(key))
      out.push({ ...heldOnly(key, validate), note: "held, in no project" });
  return out;
}

/** Whether the run fails: any layer invalid, ignoring `missing` entries. */
export function validateAllFailed(results: RepoValidation[]): boolean {
  return results.some((r) => !r.missing && !r.result.valid);
}
