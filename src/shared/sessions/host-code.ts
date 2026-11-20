/**
 * Issue 597: the terminal host's own code, as a content hash.
 *
 * The host restarts after an update only when what it runs changed: its
 * code, or the native terminal module it loaded (pty.ts). Its code is its
 * module graph: the files reached from src/shared/sessions/host.ts by
 * relative imports, under the engine root. The host hashes them as it
 * starts (the files it loaded); the web server hashes the installed ones
 * the same way. The same files give the same id whatever the Den version,
 * so a release that doesn't touch the host keeps it, and its agents.
 *
 * A fixed walk (not what the module loader loaded) keeps the two sides
 * comparable: the same function, the same files. A walk that changes
 * between versions changes the id, which only costs a restart.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getEngineRoot } from "../paths.js";

/** The host's entry, relative to the engine root. */
export const HOST_ENTRY = "src/shared/sessions/host.ts";

/** Relative imports, re-exports and dynamic imports (no packages). */
const IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g;

/** The source file a relative specifier names (".js" → ".ts" first). */
function sourceOf(dir: string, spec: string): string {
  const p = path.resolve(dir, spec);
  if (p.endsWith(".js")) {
    const ts = p.slice(0, -3) + ".ts";
    if (fs.existsSync(ts)) return ts;
  }
  return p;
}

/**
 * The host's module graph under `root`: paths relative to it (posix
 * separators), the entry first, then in the order found. A file that
 * isn't there is still listed (its absence is part of the id).
 */
export function hostCodeFiles(root: string = getEngineRoot()): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const walk = (abs: string): void => {
    if (seen.has(abs)) return;
    seen.add(abs);
    order.push(abs);
    let src: string;
    try {
      src = fs.readFileSync(abs, "utf-8");
    } catch {
      return;
    }
    for (const m of src.matchAll(IMPORT))
      walk(sourceOf(path.dirname(abs), m[1]));
  };
  walk(path.join(root, HOST_ENTRY));
  return order.map((f) => path.relative(root, f).split(path.sep).join("/"));
}

/**
 * The id of the host code under `root`: "sha256:<hex>" over each file's
 * path and content hash (sorted), or null when the entry isn't there.
 * Never throws.
 */
export function hostCodeId(root: string = getEngineRoot()): string | null {
  try {
    if (!fs.existsSync(path.join(root, HOST_ENTRY))) return null;
    const h = createHash("sha256");
    for (const rel of [...hostCodeFiles(root)].sort()) {
      let id = "missing";
      try {
        id = createHash("sha256")
          .update(fs.readFileSync(path.join(root, rel)))
          .digest("hex");
      } catch {
        /* gone: "missing" */
      }
      h.update(`${rel}\0${id}\n`);
    }
    return `sha256:${h.digest("hex")}`;
  } catch {
    return null;
  }
}
