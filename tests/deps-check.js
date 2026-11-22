/**
 * Issue 1036: a run whose node_modules no longer matches package-lock.json
 * failed far from the cause. A checkout installed weeks ago (or a worktree
 * that borrows another's node_modules) lacked the optional
 * @lydell/node-pty, so agent create answered 503; axe-core and @codemirror
 * were "not found". Global setup checks the direct dependencies first and
 * stops the run with the list and `npm ci`. DEN_DEPS_CHECK=off skips it.
 */
import * as fs from "fs";
import * as path from "path";

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf-8"));

/** Whether the lock skips `entry` on this platform (its os or cpu list). */
function skippedHere(entry) {
  const not = (list, v) =>
    Array.isArray(list) &&
    !list.some((x) => x === v) &&
    !list.every((x) => typeof x === "string" && x.startsWith("!"));
  return not(entry.os, process.platform) || not(entry.cpu, process.arch);
}

/**
 * Each direct dependency (dependencies, devDependencies,
 * optionalDependencies) that isn't installed at the lock's version, as a
 * line. Empty when everything matches, or when there is no lock (an
 * installed package, not a checkout).
 * @param {string} root
 * @returns {string[]}
 */
export function depsDrift(root) {
  const lockFile = path.join(root, "package-lock.json");
  if (!fs.existsSync(lockFile)) return [];
  const pkg = readJson(path.join(root, "package.json"));
  const packages = readJson(lockFile).packages ?? {};
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
  const out = [];
  for (const name of [...new Set(names)]) {
    const entry = packages[`node_modules/${name}`];
    if (!entry?.version || skippedHere(entry)) continue;
    let have = null;
    try {
      have = readJson(
        path.join(root, "node_modules", name, "package.json"),
      ).version;
    } catch {
      /* not installed */
    }
    if (have === entry.version) continue;
    out.push(
      have
        ? `${name}: ${have} installed, the lock has ${entry.version}`
        : `${name}: not installed (the lock has ${entry.version})`,
    );
  }
  return out;
}

/**
 * Throws when node_modules drifted from the lock, unless
 * DEN_DEPS_CHECK=off.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env
 */
export function checkDeps(root, env = process.env) {
  if (env.DEN_DEPS_CHECK === "off") return;
  const drift = depsDrift(root);
  if (!drift.length) return;
  const shown = drift.slice(0, 12);
  throw new Error(
    `node_modules does not match package-lock.json (issue 1036):\n` +
      shown.map((l) => `  ${l}`).join("\n") +
      (drift.length > shown.length
        ? `\n  … and ${drift.length - shown.length} more`
        : "") +
      `\nRun \`npm ci\` in ${root} (a worktree needs its own node_modules, ` +
      `not a link to another checkout's). DEN_DEPS_CHECK=off skips this check.`,
  );
}
