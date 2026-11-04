/**
 * Journey spec discovery (journeys pillar).
 *
 * Manifest-driven, mirroring how synthetics resolve their spec home: each
 * registered repo may declare a top-level `journeys: {testDir, testMatch}`
 * block in its .den.yml. Discovery iterates discoverRepos(), resolves
 * testDir against the registered local checkout, globs testMatch, and
 * validates every matching file through the journey spec loader.
 *
 * Failure posture is LOUD by design:
 * - a declared testDir that does not exist on disk throws (misconfigured
 *   manifest or unregistered checkout — never silently zero specs);
 * - an invalid spec file throws JourneySpecError carrying the file path —
 *   invalid specs are never skipped.
 *
 * Deployed-SHA clone parity for non-local environments is deferred to the
 * jrn-manifest-ci packet; v1 always reads from the registered checkout.
 */

import * as fs from "fs";
import * as path from "path";
import { discoverRepos } from "../smoke/discover.js";
import { loadJourneySpec } from "./spec/loader.js";
import {
  parseJourneysAppConfig,
  type JourneysAppConfig,
} from "./app-config.js";
import type { JourneySpec } from "./spec/schema.js";
import type { DiscoveredRepo } from "../../shared/types/index.js";

import { product } from "../../shared/product.js";
// ── Result shape ─────────────────────────────────────────────────────────────

/** A validated journey spec with its source repo/path metadata. */
export interface DiscoveredJourneySpec {
  /** Manifest name of the repo the spec came from. */
  repoName: string;
  /** Absolute path of the registered repo checkout. */
  repoPath: string;
  /** Absolute path of the *.journey.yml file. */
  specPath: string;
  /** The loader-validated spec. */
  spec: JourneySpec;
  /** The app under test, from the repo manifest's `journeys.app` ({} if absent). */
  app: JourneysAppConfig;
}

// ── Glob matching (dependency-free) ──────────────────────────────────────────

/**
 * Convert a testMatch glob (e.g. "**\/*.journey.yml") to a RegExp over
 * POSIX-style relative paths. Supports `**` (any depth, including zero),
 * `*` (within one segment), and `?` (single char within a segment).
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more whole segments; a trailing `**` matches
        // anything (including slashes).
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Recursively collect all regular files under `dir` (absolute paths). */
function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(abs));
    } else if (entry.isFile()) {
      files.push(abs);
    }
  }
  return files;
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Discover and validate journey specs across registered repos.
 *
 * @param repos Repo list to scan; defaults to discoverRepos() (workspace or
 *   registry). Injectable for tests.
 * @throws Error when a repo declares journeys but its testDir is missing.
 * @throws JourneySpecError when any matched spec file fails validation.
 */
export function discoverJourneySpecs(
  repos: DiscoveredRepo[] = discoverRepos(),
): DiscoveredJourneySpec[] {
  const results: DiscoveredJourneySpec[] = [];

  const sortedRepos = [...repos].sort((a, b) =>
    a.repoName.localeCompare(b.repoName),
  );

  for (const repo of sortedRepos) {
    const journeys = repo.manifest.journeys;
    if (!journeys) continue;

    const testDir = path.resolve(repo.repoPath, journeys.testDir);
    if (!fs.existsSync(testDir)) {
      throw new Error(
        `Journeys testDir "${journeys.testDir}" declared in ${repo.repoName}'s ` +
          `manifest does not exist at ${testDir}. ` +
          `Check the journeys: block in its ${product().manifestYml} or re-register the repo.`,
      );
    }

    // An invalid app block throws loudly, like an invalid spec.
    const app = parseJourneysAppConfig(
      journeys.app,
      `${repo.repoName}'s manifest`,
    );

    const matcher = globToRegExp(journeys.testMatch);
    const specPaths = walkFiles(testDir)
      .filter((abs) =>
        matcher.test(path.relative(testDir, abs).split(path.sep).join("/")),
      )
      .sort((a, b) => a.localeCompare(b));

    for (const specPath of specPaths) {
      // loadJourneySpec throws JourneySpecError (with the file path) on any
      // invalid spec — discovery deliberately does not catch it.
      const spec = loadJourneySpec(specPath);
      results.push({
        repoName: repo.repoName,
        repoPath: repo.repoPath,
        specPath,
        spec,
        app,
      });
    }
  }

  return results;
}
