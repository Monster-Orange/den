/**
 * Den's own files, wherever Den is installed.
 *
 * Two roots, never confused:
 *   - the engine root (getEngineRoot): Den's package — src/, scripts/, make/.
 *     In a distribution that is node_modules/@monster-orange/den.
 *   - the distribution root (getDistRoot): den.yml, config/, manifests/,
 *     tests/pillars/, reports/, results/.
 * In Den's own checkout they are the same directory.
 *
 * Anything that names an engine file or runs an engine script goes through
 * here instead of joining "src/…" onto the dist root or relying on the cwd.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getDistRoot, getEngineRoot } from "./paths.js";

/** An absolute path inside Den's own package. */
export function enginePath(...parts: string[]): string {
  return path.join(getEngineRoot(), ...parts);
}

/**
 * A binary Den depends on (tsx, playwright, …): the nearest
 * node_modules/.bin/<name> at or above the engine root. npm hoists Den's
 * dependencies into the distribution's node_modules, so the walk covers both
 * a Den checkout and a packaged install. Falls back to the bare name (PATH).
 */
export function engineBin(name: string, engineRoot = getEngineRoot()): string {
  let dir = path.resolve(engineRoot);
  for (;;) {
    const candidate = path.join(dir, "node_modules", ".bin", name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return name;
    dir = parent;
  }
}

/**
 * A file inside a package Den depends on (e.g. "tsx/dist/loader.mjs"): the
 * nearest node_modules/<rel> at or above the engine root, or null.
 */
export function engineModuleFile(
  rel: string,
  engineRoot = getEngineRoot(),
): string | null {
  let dir = path.resolve(engineRoot);
  for (;;) {
    const candidate = path.join(dir, "node_modules", rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The tsx binary that runs Den's TypeScript sources. */
export function tsxBin(): string {
  return engineBin("tsx");
}

/** A command that runs one of Den's scripts with tsx. */
export interface EngineCommand {
  command: string;
  args: string[];
}

/** `tsx <engine>/<script> ...args`. `script` is relative to the engine root. */
export function tsxCommand(script: string, ...args: string[]): EngineCommand {
  return { command: tsxBin(), args: [enginePath(script), ...args] };
}

/**
 * An absolute path inside the distribution (reports, results, staged tests,
 * config): the counterpart of enginePath. Same directory in Den's checkout.
 */
export function distPath(...parts: string[]): string {
  return path.join(getDistRoot(), ...parts);
}

/** `playwright ...args` from Den's own @playwright/test. */
export function playwrightCommand(...args: string[]): EngineCommand {
  return { command: engineBin("playwright"), args };
}
