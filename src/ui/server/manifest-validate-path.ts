/**
 * GET /api/manifest/validate?path=<absolute path>: validate the manifest of
 * a repo folder of a project here (or one file in it), never quoting it.
 *
 * Issue 583: every file this opens passes the same containment check, and
 * each is read at the resolved path that was checked (readWithin):
 *   - the requested path: inside a configured repo root, as written and
 *     after every symlink;
 *   - the repo's own manifest: inside the requested repo folder;
 *   - a held manifest or override: inside the held manifests folder.
 * A configured repo root that is far too broad (broadRootReason: the whole
 * disk, a top-level folder, the home folder or one holding it, the state
 * folder or one holding it) is never a root; `doctor` says why.
 */
import * as fs from "fs";
import * as path from "path";
import {
  validateManifest,
  validateManifestLayers,
} from "../../shared/manifest/validate-manifest.js";
import {
  broadRootReason,
  isWithin,
  readWithin,
  realRoots,
  type BroadRootOptions,
} from "../../shared/manifest/contained-read.js";
import { product } from "../../shared/product.js";

export interface ValidatePathDeps extends BroadRootOptions {
  /** Every project's configured repo roots, as configured. */
  repoRoots: readonly string[];
  /** The held manifests folder (heldManifestsDir()). */
  heldDir: string;
}

/** A message's first line: a parser's code frame quotes the file. */
function firstLine(m: string): string {
  return String(m).split("\n")[0].replace(/:\s*$/, "");
}

/** The configured roots that are absolute and not far too broad. */
function usableRoots(deps: ValidatePathDeps): string[] {
  return deps.repoRoots.filter(
    (r) => !!r && path.isAbsolute(r) && broadRootReason(r, deps) === null,
  );
}

/**
 * Where `p` really is, when it is a usable repo root or inside one, both as
 * written and after resolving every symlink; else null.
 */
function inRepo(p: string, roots: string[]): string | null {
  if (!path.isAbsolute(p) || p.length > 4096 || p.includes("\0")) return null;
  const asWritten = path.resolve(p);
  if (!roots.some((r) => isWithin(asWritten, path.resolve(r)))) return null;
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    return null;
  }
  return realRoots(roots).some((r) => isWithin(real, r)) ? real : null;
}

export function validateAtPath(
  filePath: string,
  deps: ValidatePathDeps,
): { status: number; body: unknown } {
  const roots = usableRoots(deps);
  const real = inRepo(filePath, roots);
  if (!real)
    // Any other path is refused the same way, there or not.
    return {
      status: 403,
      body: {
        ok: false,
        code: "outside_repos",
        error:
          "Validate reads only a repo folder (or a file in one) of a project here.",
      },
    };
  // Errors name the file's line and column, never its text.
  const plain = (r: ReturnType<typeof validateManifest>) => ({
    ...r,
    errors: r.errors.map((e) => ({ ...e, message: firstLine(e.message) })),
    warnings: r.warnings.map((w) => ({ ...w, message: firstLine(w.message) })),
  });
  try {
    const isDir = fs.statSync(real).isDirectory();
    if (isDir) {
      // A repo folder: every layer that applies (repo or held, override,
      // merged), flattened into the usual shape; each error names its file.
      // The repo's own manifest is read inside this folder only; a held
      // manifest or override inside the held folder only.
      const layered = validateManifestLayers(real, {
        read: (file, layer) =>
          readWithin(file, layer === "repo" ? [real] : [deps.heldDir]),
      });
      if (layered.layers.length > 0)
        return {
          status: 200,
          body: {
            valid: layered.valid,
            version: layered.layers[0].result.version,
            errors: layered.layers.flatMap((l) => plain(l.result).errors),
            warnings: layered.layers.flatMap((l) => plain(l.result).warnings),
            manifestLayers: layered.applied ?? [],
            layers: layered.layers.map((l) => ({
              ...l,
              result: plain(l.result),
            })),
          },
        };
    }
    const file = isDir ? path.join(real, `${product().manifestYml}`) : real;
    const content = readWithin(file, isDir ? [real] : realRoots(roots));
    return { status: 200, body: plain(validateManifest(content)) };
  } catch (e) {
    return {
      status: 200,
      body: {
        valid: false,
        version: 1,
        errors: [
          {
            path: "",
            message:
              (e as NodeJS.ErrnoException).code === "ENOENT"
                ? "No manifest there."
                : "The manifest couldn't be read.",
          },
        ],
        warnings: [],
      },
    };
  }
}
