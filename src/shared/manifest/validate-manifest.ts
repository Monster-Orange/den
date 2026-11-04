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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a Zod issue path to a dot-separated string. */
function zodPathToString(path: (string | number)[]): string {
  return path
    .map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`))
    .join("");
}

/** Friendly message for common Zod issue codes. */
function zodIssueMessage(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined")
        return `"${issue.path.at(-1)}" is required`;
      return `expected ${issue.expected}, received ${issue.received}`;
    case z.ZodIssueCode.invalid_enum_value:
      return `invalid value "${issue.received}" — must be one of: ${issue.options.join(", ")}`;
    case z.ZodIssueCode.invalid_union:
      return "value does not match any valid shape";
    default:
      return issue.message;
  }
}

/** Suggestion text for specific paths / issues. */
function suggestionFor(issue: z.ZodIssue): string | undefined {
  const pathStr = zodPathToString(issue.path);

  // auth arrays in smoke / synthetics
  if (pathStr.includes("auth")) {
    return 'Valid roles are: "admin", "user", "beta"';
  }

  // health with missing url/cmd
  if (pathStr.includes("health")) {
    return 'HTTP checks need "url"; shell checks need "type: shell" and "cmd"';
  }

  return undefined;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Validate a .den.yml manifest.
 *
 * @param input - A parsed object or a raw YAML string.
 * @returns A ValidationResult with errors, warnings, and the detected version.
 */
export function validateManifest(input: unknown): ValidationResult {
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
    return {
      valid: true,
      version: detectedVersion,
      errors: [],
      warnings,
    };
  }

  // 6. Map Zod issues → ValidationError[]
  const errors: ValidationError[] = result.error.issues.map((issue) => ({
    path: zodPathToString(issue.path),
    message: zodIssueMessage(issue),
    suggestion: suggestionFor(issue),
  }));

  return {
    valid: false,
    version: detectedVersion,
    errors,
    warnings,
  };
}
