/**
 * .den.yml manifest validator.
 *
 * Accepts a parsed object or a raw YAML string.
 * Returns a ValidationResult describing any errors or warnings.
 */

import * as yaml from "yaml";
import { z } from "zod";
import {
  CURRENT_SCHEMA_VERSION,
  KNOWN_VERSIONS,
  schemaByVersion,
} from "./schema.js";
import type { ValidationError, ValidationResult } from "../types/index.js";
import { placementErrors } from "./placement.js";
import { builtinEnvironments, orgEnvironments } from "../den-config.js";
import {
  validateLayers,
  type LayeredValidation,
  type SchemaTools,
} from "./validate-layers.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a Zod issue path to a dot-separated string. */
function zodPathToString(path: readonly PropertyKey[]): string {
  return path
    .map((p, i) =>
      typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`,
    )
    .join("");
}

/** The value at `path` in `data` (undefined when it isn't there). */
function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let v: unknown = data;
  for (const k of path) {
    if (v === null || typeof v !== "object") return undefined;
    v = (v as Record<PropertyKey, unknown>)[k];
  }
  return v;
}

/** What a value is, as a message names it: array and null by name. */
function kindOf(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

/**
 * Friendly message for common Zod issue codes. Zod v4 issues carry no
 * `received` (den#145): what was there is read from the input itself.
 */
function zodIssueMessage(issue: z.core.$ZodIssue, input: unknown): string {
  switch (issue.code) {
    case "invalid_type": {
      const got = valueAt(input, issue.path);
      if (got === undefined)
        return `"${String(issue.path.at(-1))}" is required`;
      return `expected ${issue.expected}, received ${kindOf(got)}`;
    }
    case "invalid_value":
      return `invalid value "${String(valueAt(input, issue.path))}" — must be one of: ${issue.values.map(String).join(", ")}`;
    case "invalid_union":
      return "value does not match any valid shape";
    default:
      return issue.message;
  }
}

/** Suggestion text for specific paths / issues. */
function suggestionFor(issue: z.core.$ZodIssue): string | undefined {
  const pathStr = zodPathToString(issue.path);

  // auth arrays in smoke / synthetics
  if (pathStr.includes("auth")) {
    return 'Valid roles are: "admin", "user", "beta"';
  }

  // health with missing url/cmd
  if (pathStr.includes("health")) {
    return 'HTTP checks need "url"; shell checks need "type: shell" and "cmd"; container checks need "type: container" and "project" + "service", or "container_name"';
  }

  return undefined;
}

/** Map Zod issues to ValidationErrors. */
export function issuesToErrors(
  issues: readonly z.core.$ZodIssue[],
  /** What was validated: a message names what it found there. */
  input?: unknown,
): ValidationError[] {
  return issues.map((issue) => ({
    path: zodPathToString(issue.path),
    message: zodIssueMessage(issue, input),
    suggestion: suggestionFor(issue),
  }));
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Validate a .den.yml manifest.
 *
 * @param input - A parsed object or a raw YAML string.
 * @returns A ValidationResult with errors, warnings, and the detected version.
 */
export interface ValidateOptions {
  /** The org's environments; default: the org config's (see orgEnvironments). */
  environments?: readonly string[];
}

function environmentsFor(opts: ValidateOptions): readonly string[] {
  if (opts.environments) return opts.environments;
  try {
    return orgEnvironments();
  } catch {
    // An unreadable org config is reported where it is read; validate the
    // manifest against Den's built-in environment list meanwhile.
    return builtinEnvironments();
  }
}

export function validateManifest(
  input: unknown,
  opts: ValidateOptions = {},
): ValidationResult {
  // 1. Parse YAML string if needed
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = yaml.parse(input);
    } catch (err: unknown) {
      return {
        valid: false,
        version: 1,
        errors: [
          {
            path: "",
            message: `Could not parse YAML: ${(err as Error).message}`,
          },
        ],
        warnings: [],
      };
    }
  }

  // 2. Detect version
  const rawVersion =
    parsed !== null &&
    typeof parsed === "object" &&
    "version" in (parsed as object)
      ? (parsed as Record<string, unknown>).version
      : undefined;

  const detectedVersion = rawVersion === undefined ? 1 : Number(rawVersion);

  const warnings: ValidationError[] = [];

  // 3. Warn on unknown future versions but still validate with the latest schema
  const isKnown = KNOWN_VERSIONS.includes(
    detectedVersion as (typeof KNOWN_VERSIONS)[number],
  );
  if (rawVersion !== undefined && !isKnown) {
    warnings.push({
      path: "version",
      message: `Unknown schema version ${detectedVersion}. Validating against v${CURRENT_SCHEMA_VERSION} (latest known).`,
    });
  }

  // 4. Pick schema — fall back to latest for unknown future versions
  const schema =
    schemaByVersion[detectedVersion] ?? schemaByVersion[CURRENT_SCHEMA_VERSION];

  // 5. Run Zod validation
  const result = schema.safeParse(parsed);

  if (result.success) {
    // Env names in `runs` / `target.env` must be the org's (R13).
    const placement = placementErrors(parsed, environmentsFor(opts));
    if (placement.length > 0)
      return {
        valid: false,
        version: detectedVersion,
        errors: placement,
        warnings,
      };
    return {
      valid: true,
      version: detectedVersion,
      errors: [],
      warnings,
    };
  }

  // 6. Map Zod issues → ValidationError[]
  const errors = issuesToErrors(result.error.issues, parsed);

  return {
    valid: false,
    version: detectedVersion,
    errors,
    warnings,
  };
}

// ── Layers ────────────────────────────────────────────────────────────────────

const schemaTools: SchemaTools = {
  version: CURRENT_SCHEMA_VERSION,
  schema: schemaByVersion[CURRENT_SCHEMA_VERSION],
  validate: (input) => validateManifest(input),
  issuesToErrors: (issues, input) => issuesToErrors(issues, input),
};

/**
 * Validate each manifest layer of the repo at `repoPath` (its own or the
 * held manifest, then manifests/<repo>.override.yml), then the merge.
 * See validate-layers.ts.
 */
export function validateManifestLayers(repoPath: string): LayeredValidation {
  return validateLayers(schemaTools, repoPath);
}
