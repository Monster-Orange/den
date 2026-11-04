/**
 * *.journey.yml loader.
 *
 * Reads a journey spec YAML file, validates it against journeySpecSchema,
 * and returns a typed JourneySpec — or throws a JourneySpecError carrying
 * the offending file path and manifest-style mapped validation errors
 * (error mapping modeled on src/shared/manifest/validate-manifest.ts).
 * Discovery relies on this throwing loudly: an invalid spec file must
 * never be silently skipped.
 */

import * as fs from "fs";
import * as yaml from "yaml";
import { z } from "zod";
import { journeySpecSchema } from "./schema.js";
import type { JourneySpec } from "./schema.js";
import type { ValidationError } from "../../../shared/types/index.js";

// ── Error type ────────────────────────────────────────────────────────────────

export class JourneySpecError extends Error {
  readonly errors: ValidationError[];
  readonly filePath?: string;

  constructor(errors: ValidationError[], filePath?: string) {
    const location = filePath ? ` at ${filePath}` : "";
    const detail = errors
      .map((e) => (e.path ? `  - ${e.path}: ${e.message}` : `  - ${e.message}`))
      .join("\n");
    super(`Invalid journey spec${location}:\n${detail}`);
    this.name = "JourneySpecError";
    this.errors = errors;
    this.filePath = filePath;
  }
}

// ── Zod issue → ValidationError mapping ──────────────────────────────────────

/** Convert a Zod issue path to a dot-separated string (arrays as [n]). */
function zodPathToString(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((p, i) =>
      typeof p === "number" ? `[${p}]` : i === 0 ? String(p) : `.${String(p)}`,
    )
    .join("");
}

/** Friendly message for common Zod issue codes. */
function zodIssueMessage(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      if (issue.message.endsWith("received undefined")) {
        return `"${String(issue.path.at(-1))}" is required`;
      }
      return issue.message;
    case "invalid_value":
      return `invalid value — must be one of: ${issue.values
        .map((v) => String(v))
        .join(", ")}`;
    case "unrecognized_keys":
      return `unrecognized key(s): ${issue.keys.join(", ")}`;
    default:
      return issue.message;
  }
}

/**
 * Flatten Zod issues into ValidationErrors, recursing into union branches
 * so assertion problems surface as pointed per-field errors rather than a
 * generic "invalid union" message.
 */
function collectIssues(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  out: ValidationError[],
): void {
  for (const issue of issues) {
    if (issue.code === "invalid_union") {
      const nested = issue.errors.flat();
      if (nested.length > 0) {
        collectIssues(nested, out);
        continue;
      }
    }
    out.push({
      path: zodPathToString(issue.path),
      message: zodIssueMessage(issue),
    });
  }
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Parse and validate a journey spec from a raw YAML string or an
 * already-parsed object.
 *
 * @throws JourneySpecError on YAML parse failure or schema violation.
 */
export function parseJourneySpec(
  input: unknown,
  filePath?: string,
): JourneySpec {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = yaml.parse(input);
    } catch (err: unknown) {
      throw new JourneySpecError(
        [
          {
            path: "",
            message: `Could not parse YAML: ${(err as Error).message}`,
          },
        ],
        filePath,
      );
    }
  }

  const result = journeySpecSchema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }

  const errors: ValidationError[] = [];
  collectIssues(result.error.issues, errors);
  throw new JourneySpecError(errors, filePath);
}

/**
 * Load a *.journey.yml file from disk and validate it.
 *
 * @throws JourneySpecError when the file is unreadable, malformed YAML,
 *   or violates the journey spec schema.
 */
export function loadJourneySpec(filePath: string): JourneySpec {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    throw new JourneySpecError(
      [
        {
          path: "",
          message: `Could not read journey spec file: ${(err as Error).message}`,
        },
      ],
      filePath,
    );
  }
  return parseJourneySpec(content, filePath);
}
