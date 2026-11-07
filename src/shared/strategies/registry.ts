/**
 * Strategy registry: every concern that varies by distribution (secrets
 * backend today; TLS and others next) is a strategy, and Den's built-ins
 * register here exactly as a plugin would. An entry is
 * `{ id, kind, detect(), capabilities }`:
 *
 *  - `kind` names the concern ("secrets"); ids are unique per kind;
 *  - `detect()` is cheap and side-effect free: it never prompts, never
 *    spawns a CLI that could prompt, and never prints a secret. It says
 *    whether the strategy can work on this machine, and why not;
 *  - `capabilities` is the kind's own interface (a factory, optional setup,
 *    optional env injection, ...).
 *
 * No plugin loading happens here: a future plugin kind calls
 * registerStrategy() with its entry.
 */
import * as fs from "fs";
import * as path from "path";

export interface DetectResult {
  available: boolean;
  /** Why the strategy is unavailable, or a note (e.g. "not configured"). */
  reason?: string;
}

export interface StrategyEntry<K extends string = string, C = unknown> {
  id: string;
  kind: K;
  detect(env?: NodeJS.ProcessEnv): DetectResult;
  capabilities: C;
}

const registries = new Map<string, Map<string, StrategyEntry>>();

/** Register (or replace) a strategy under its kind. */
export function registerStrategy<K extends string, C>(
  entry: StrategyEntry<K, C>,
): void {
  let byId = registries.get(entry.kind);
  if (!byId) {
    byId = new Map();
    registries.set(entry.kind, byId);
  }
  byId.set(entry.id, entry as StrategyEntry);
}

/** Remove strategy `id` of `kind` (no-op when it isn't there). */
export function unregisterStrategy(kind: string, id: string): void {
  registries.get(kind)?.delete(id);
}

/** The strategy `id` of `kind`, or undefined. */
export function getStrategy<K extends string, C>(
  kind: K,
  id: string,
): StrategyEntry<K, C> | undefined {
  return registries.get(kind)?.get(id) as StrategyEntry<K, C> | undefined;
}

/** Every kind with a registered strategy, in registration order. */
export function strategyKinds(): string[] {
  return [...registries.keys()];
}

/** Every registered id of `kind`, in registration order. */
export function strategyIds(kind: string): string[] {
  return [...(registries.get(kind)?.keys() ?? [])];
}

/**
 * True when an executable named `bin` is on `env.PATH`. A file check only:
 * nothing is run, so it can never prompt (Touch ID, a login) or print.
 */
export function onPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, bin + ext), fs.constants.X_OK);
        if (fs.statSync(path.join(dir, bin + ext)).isFile()) return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}
