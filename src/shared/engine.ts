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
import { pathToFileURL } from "node:url";
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

/**
 * How to run Den's CLI as a background process of its own, whatever process
 * asks (the CLI, the web server): one node process, never the tsx CLI (a
 * parent that relays signals). Live TypeScript source with tsx's loader in
 * a checkout or a package install; the compiled build when tsx is absent,
 * or with DEN_USE_DIST=1. Mirrors the web server's resolveServerEntrypoint.
 */
export function cliEntrypoint(engine: string = getEngineRoot()): EngineCommand {
  const built = path.join(engine, "dist/src/ui/cli/index.js");
  if (process.env.DEN_USE_DIST === "1" && fs.existsSync(built))
    return { command: process.execPath, args: [built] };
  const loader = engineModuleFile("tsx/dist/loader.mjs", engine);
  const src = path.join(engine, "src/ui/cli/index.ts");
  if (loader && fs.existsSync(src))
    return {
      command: process.execPath,
      args: ["--import", pathToFileURL(loader).href, src],
    };
  if (fs.existsSync(built)) return { command: process.execPath, args: [built] };
  return { command: engineBin("tsx", engine), args: [src] };
}
