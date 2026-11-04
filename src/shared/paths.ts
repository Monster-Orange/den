import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadProfile,
  PROFILE_FILE,
  readEnv,
  type ProductProfile,
} from "./profile.js";

/** Den's package name: the engine root is the directory that has it. */
export const ENGINE_PACKAGE = "@monster-orange/den";

/** A distribution root is a directory holding den.yml. */
function isDistRootAt(dir: string): boolean {
  return fs.existsSync(path.join(dir, PROFILE_FILE));
}

function isEngineRootAt(dir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    return (JSON.parse(raw) as { name?: unknown }).name === ENGINE_PACKAGE;
  } catch {
    return false;
  }
}

function walkUp(start: string, test: (dir: string) => boolean): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (test(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const entryDir = (): string | null =>
  process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;

/**
 * An explicit root from the environment: DEN_ROOT, or `<PREFIX>_ROOT` where
 * <PREFIX> is the env prefix of the profile found there (ACME_ROOT for a
 * product named acme). Validated rather than trusted: everything downstream (clone
 * destinations, the clone-guard allowlist, config writes) anchors here, so a
 * stale or mistyped value must not re-open the Jun 29 incident.
 */
function rootFromEnv(): string | null {
  const den = process.env.DEN_ROOT?.trim();
  if (den) {
    const resolved = path.resolve(den);
    if (!isDistRootAt(resolved))
      throw new Error(
        `DEN_ROOT is set to "${den}" but that directory has no ${PROFILE_FILE}. ` +
          `Point it at your distribution's checkout, or unset it.`,
      );
    return resolved;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^[A-Z][A-Z0-9_]*_ROOT$/.test(key) || !value?.trim()) continue;
    const resolved = path.resolve(value.trim());
    if (
      isDistRootAt(resolved) &&
      `${loadProfile(resolved).envPrefix}_ROOT` === key
    )
      return resolved;
  }
  return null;
}

/**
 * The distribution root: where den.yml, config/, manifests/, reports/ and
 * results/ live. Never process.cwd(): on Jun 29 a cwd-derived root caused a
 * bulk clone of 13 repos into an unrelated checkout. Anything the walk can't
 * anchor fails loudly.
 */
export function getDistRoot(): string {
  const fromEnv = rootFromEnv();
  if (fromEnv) return fromEnv;
  const start = entryDir();
  const root = start ? walkUp(start, isDistRootAt) : null;
  if (root !== null) {
    // The distribution's own <PREFIX>_ROOT, if set, must have been accepted
    // above: one that points elsewhere is a mistake, never silently ignored.
    const key = `${loadProfile(root).envPrefix}_ROOT`;
    const set = process.env[key]?.trim();
    if (set)
      throw new Error(
        `${key} is set to "${set}" but that directory has no ${PROFILE_FILE} ` +
          `for this product. Point ${key} at your checkout, or unset it.`,
      );
    return root;
  }
  // Name any product root variable that was set but pointed nowhere useful.
  for (const [key, value] of Object.entries(process.env))
    if (/^[A-Z][A-Z0-9_]*_ROOT$/.test(key) && value?.trim()) {
      const resolved = path.resolve(value.trim());
      if (
        fs.existsSync(resolved) &&
        !isDistRootAt(resolved) &&
        isProductRootVar(resolved, key)
      )
        throw new Error(
          `${key} is set to "${value}" but that directory has no ${PROFILE_FILE}. ` +
            `Point ${key} at your checkout, or unset it.`,
        );
    }
  throw new Error(
    `cannot locate the distribution root: walked up from ` +
      `"${start ?? "(no entry script)"}" without finding ${PROFILE_FILE}. ` +
      `Set DEN_ROOT (or <PRODUCT>_ROOT) to your checkout directory ` +
      `(the current directory, "${process.cwd()}", is never used as an anchor).`,
  );
}

/**
 * Whether `<PREFIX>_ROOT` is a product root variable (rather than some other
 * tool's): the active profile, if one is pinned by DEN_PROFILE, owns it.
 */
function isProductRootVar(dir: string, key: string): boolean {
  const pinned = process.env.DEN_PROFILE?.trim();
  if (!pinned) return false;
  return `${loadProfile(dir).envPrefix}_ROOT` === key;
}

/**
 * Where Den's own files live (src/, public pages, make/): the directory whose
 * package.json is @monster-orange/den. In a distribution that is
 * node_modules/@monster-orange/den; in Den's own checkout, its root.
 */
export function getEngineRoot(): string {
  const env = process.env.DEN_ENGINE_ROOT?.trim();
  if (env) return path.resolve(env);
  for (const start of [entryDir(), process.cwd()]) {
    if (!start) continue;
    const viaWalk = walkUp(start, isEngineRootAt);
    if (viaWalk) return viaWalk;
    const nested = path.join(
      start,
      "node_modules",
      ...ENGINE_PACKAGE.split("/"),
    );
    if (isEngineRootAt(nested)) return nested;
  }
  throw new Error(
    `cannot locate Den's own files: no package.json named ${ENGINE_PACKAGE} ` +
      `above the entry script or the current directory. Set DEN_ENGINE_ROOT.`,
  );
}

/** Den's own version (its package.json), or undefined when unreadable. */
export function engineVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(getEngineRoot(), "package.json"), "utf-8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** This distribution's profile. */
export function getProfile(): ProductProfile {
  return loadProfile(getDistRoot());
}

/**
 * The caller's cwd, handed over by the CLI wrapper (bin/den) in
 * DEN_INVOKE_CWD, or the product's own `<PREFIX>_INVOKE_CWD`.
 */
export function getInvokeCwd(): string {
  const handed = process.env.DEN_INVOKE_CWD?.trim();
  if (handed) return handed;
  try {
    return readEnv(getProfile(), "INVOKE_CWD") ?? process.cwd();
  } catch {
    return process.cwd(); // no distribution root yet: the caller's cwd
  }
}

/**
 * Per-user state directory for this instance (web server, daemons, logs,
 * history): the profile's state_dir (~/.<name>), or `<PREFIX>_HOME`, so two
 * instances on one machine never share or stop each other's processes.
 */
export function getStateDir(): string {
  const profile = getProfile();
  const home = readEnv(profile, "HOME")?.trim();
  return home ? path.resolve(home) : profile.stateDir;
}
