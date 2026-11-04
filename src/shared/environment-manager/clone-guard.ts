/**
 * Clone-destination preflight (defense in depth for the Jun 29 incident).
 *
 * Path anchoring (getDistRoot) is the first line of defense; this guard is
 * the second: even if some entry point regresses and computes a destination
 * from the wrong anchor, refuse to clone anywhere that could damage another
 * repo. Refusal conditions:
 *
 *  1. OUTSIDE DEN-OWNED LOCATIONS — destinations must live under the
 *     repos root, den-workspaces, .den-services, or .smoke-clones.
 *
 *  2. SELF-NESTING — the destination is inside a checkout of the same repo
 *     being cloned (e.g. ~/projects/infra-stack/infra-stack).
 *
 *  3. FOREIGN WORKING TREE — the destination sits inside an existing git
 *     working tree that den does not own. (Den's own tree is expected:
 *     .den-services/ and .smoke-clones/ live inside the den checkout.
 *     A tree that already enclosed the allowed root itself — e.g. a
 *     home-directory dotfiles repo above ~/projects — is the user's chosen
 *     layout and is allowed.)
 *
 * Refusals throw with the computed destination, cwd, and resolved den root
 * so a misconfiguration is diagnosable in one glance.
 */

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { getDistRoot } from "../paths.js";
import { getReposRoot } from "../den-config.js";
import { DEN_SERVICES_DIR, DEN_WORKSPACES_DIR } from "./workspaces.js";

import { envKey, product } from "../product.js";
export class CloneDestinationError extends Error {}

/**
 * Split `p` into the realpath of its nearest EXISTING ancestor plus the
 * not-yet-existing suffix. Never collapses the suffix — a collapsed path
 * compared against the allowlist would over- or under-permit.
 */
function splitExisting(p: string): { real: string; suffix: string } {
  let probe = path.resolve(p);
  let suffix = "";
  for (;;) {
    if (fs.existsSync(probe)) {
      let real = probe;
      try {
        real = fs.realpathSync(probe);
      } catch {
        /* keep unresolved */
      }
      return { real, suffix };
    }
    suffix = suffix
      ? path.join(path.basename(probe), suffix)
      : path.basename(probe);
    const parent = path.dirname(probe);
    if (parent === probe) return { real: probe, suffix };
    probe = parent;
  }
}

/** `p` with symlinks resolved on its existing prefix (macOS /tmp → /private/tmp). */
function realFull(p: string): string {
  const { real, suffix } = splitExisting(p);
  return suffix ? path.join(real, suffix) : real;
}

/** Toplevel of the git working tree containing existing dir `dir`, or null. */
function gitToplevelOf(dir: string): string | null {
  try {
    const out = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return out ? realFull(out) : null;
  } catch {
    return null; // not inside a git working tree (or git unavailable)
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function refuse(
  reason: string,
  dest: string,
  extra: Record<string, string> = {},
): never {
  const lines = [
    `${product().cli}: REFUSING to clone — ${reason}`,
    `  destination:  ${dest}`,
    `  process cwd:  ${process.cwd()}`,
    `  ${product().cli} root:  ${getDistRoot()}`,
  ];
  for (const [k, v] of Object.entries(extra)) lines.push(`  ${k}:  ${v}`);
  lines.push(
    `  If the destination is wrong, fix the anchor (${envKey("ROOT")} / ` +
      `repos_root in ${product().configFile}) rather than cloning by hand.`,
  );
  throw new CloneDestinationError(lines.join("\n"));
}

/**
 * Throw (CloneDestinationError) unless `dest` is a safe place to create a
 * fresh clone of `repoName`. Call BEFORE any mkdir/clone side effect.
 */
export function assertSafeCloneDestination(
  dest: string,
  repoName: string,
): void {
  const absDest = path.resolve(dest);
  const distRoot = realFull(getDistRoot());

  const allowedRoots = [
    realFull(getReposRoot()),
    realFull(DEN_WORKSPACES_DIR),
    realFull(DEN_SERVICES_DIR),
    realFull(path.join(distRoot, ".smoke-clones")),
  ];

  const destReal = realFull(absDest);
  const containingRoot = allowedRoots.find((r) => isWithin(destReal, r));
  if (!containingRoot) {
    refuse(
      `destination is outside every ${product().cli}-owned location`,
      absDest,
      {
        "allowed under": allowedRoots.join(" | "),
      },
    );
  }

  const enclosingTree = gitToplevelOf(
    splitExisting(path.dirname(absDest)).real,
  );
  if (enclosingTree) {
    if (path.basename(enclosingTree) === repoName) {
      refuse(
        `destination would nest ${repoName} inside a checkout of itself`,
        absDest,
        { "enclosing git working tree": enclosingTree },
      );
    }
    const isDenTree = enclosingTree === distRoot;
    // A tree that encloses the allowed root itself (repos root under a
    // dotfiles-home repo, etc.) predates den's write — user's layout.
    const enclosesAllowedRoot = isWithin(containingRoot, enclosingTree);
    if (!isDenTree && !enclosesAllowedRoot) {
      refuse(
        `destination is inside a git working tree ${product().cli} does not own`,
        absDest,
        { "enclosing git working tree": enclosingTree },
      );
    }
  }
}
