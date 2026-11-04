/**
 * AWS Profile loader
 *
 * Reads config/local/aws-profiles.json — a gitignored per-user file that maps
 * den environments to AWS CLI profile names (set via `make aws-configure`).
 *
 * Returns empty object if the file doesn't exist (local-only usage).
 */

import * as fs from "fs";
import * as path from "path";
import type { Environment } from "../types/index.js";
import { getDistRoot } from "../paths.js";

// The profiles file lives under the den repo root, not the caller's cwd —
// den is frequently invoked from inside other repos.
const PROFILES_FILE = path.resolve(
  getDistRoot(),
  "config",
  "local",
  "aws-profiles.json",
);

let cache: Partial<Record<Environment, string>> | null = null;

export function loadAwsProfiles(): Partial<Record<Environment, string>> {
  if (cache) return cache;
  if (!fs.existsSync(PROFILES_FILE)) return (cache = {});
  try {
    cache = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf-8"));
    return cache!;
  } catch {
    return (cache = {});
  }
}

/**
 * Returns { AWS_PROFILE: "..." } for the given env if a profile is configured,
 * otherwise returns {}. Spread into process.env when spawning AWS CLI commands.
 */
export function awsProfileEnv(env: Environment): Record<string, string> {
  const profile = loadAwsProfiles()[env];
  return profile ? { AWS_PROFILE: profile } : {};
}

/** Invalidate cache (used in tests or after aws-configure runs). */
export function clearAwsProfileCache(): void {
  cache = null;
}
