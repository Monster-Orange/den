/**
 * Validate a repo's manifest layer by layer: the base (repo or held), the
 * override, then the merged result. Each layer's errors name its file.
 *
 * The override is partial, so it is not checked against the whole schema
 * (it need not repeat `name`, say). Instead each value it sets is checked
 * against the schema at that path, and every key it names must exist in the
 * base (see overrideKeyErrors).
 *
 * The schema and the single-file validator come in as `SchemaTools`, so this
 * file stays under the typecheck gate: schema.ts and validate-manifest.ts are
 * still baseline-excluded (zod v4 drift), and importing them here would pull
 * them back into the checked program. validate-manifest.ts wires them in and
 * exports validateManifestLayers(repoPath).
 */

import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import type { ValidationError, ValidationResult } from "../types/index.js";
import {
  isPlainMap,
  mergeOverride,
  overrideKeyErrors,
  type ManifestMap,
} from "./merge-override.js";
import {
  heldManifestPath,
  locateManifest,
  orphanOverrideMessage,
  overrideSuffix,
  parseManifestText,
  type ManifestLayer,
} from "./read-manifest.js";
import { product } from "../product.js";

/** What layered validation needs from the schema module. */
export interface SchemaTools {
  /** The current schema version and its schema. */
  version: number;
  schema: z.ZodType;
  /** Validate one whole manifest (validateManifest). */
  validate: (input: unknown) => ValidationResult;
  /** Map Zod issues to ValidationErrors, as validateManifest does. */
  issuesToErrors: (
    issues: z.core.$ZodIssue[],
    /** What was validated, at the issues' paths (their messages read it). */
    input?: unknown,
  ) => ValidationError[];
}

export interface LayerValidation {
  layer: ManifestLayer | "merged";
  /** The layer's file; null for the merged result. */
  file: string | null;
  result: ValidationResult;
}

export interface LayeredValidation {
  valid: boolean;
  /**
   * Base first, then override, then merged (only when there is an override
   * and both layers pass on their own). Empty when no manifest file exists.
   */
  layers: LayerValidation[];
  /**
   * The layers that applied, base first, as loadManifest's `layers` says
   * (e.g. ["held", "override"]); empty when no usable manifest results.
   */
  applied?: ManifestLayer[];
}

/**
 * How a layer file is read (issue 583): the default reads it as is; a
 * caller may check where the file really is first, and throw to refuse it.
 */
export type ReadLayerFile = (file: string, layer: ManifestLayer) => string;

export interface ValidateLayersOptions {
  read?: ReadLayerFile;
}

const readAsIs: ReadLayerFile = (file) => fs.readFileSync(file, "utf-8");

/** Strip optional/nullable/default wrappers to the schema underneath. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable)
      s = s.unwrap() as z.ZodType;
    else if (s instanceof z.ZodDefault) s = s.def.innerType as z.ZodType;
    else return s;
  }
}

/**
 * Schema errors in `value`, an override's value at `at`, merging into
 * `base` (the base's value there). Maps are walked key by key where the
 * schema is an object or a record; anything else is checked whole (a map
 * merged onto its base first, so a partial union member still passes).
 */
function overrideSchemaErrors(
  tools: SchemaTools,
  schema: z.ZodType,
  value: unknown,
  base: unknown,
  at: string[],
): ValidationError[] {
  if (value === null) return []; // a delete: overrideKeyErrors checks the key
  const node = unwrap(schema);
  const baseAt = (key: string): unknown =>
    isPlainMap(base) ? base[key] : undefined;
  if (isPlainMap(value) && node instanceof z.ZodObject) {
    const shape = node.shape as Record<string, z.ZodType>;
    return Object.entries(value).flatMap(([key, v]) =>
      key in shape
        ? overrideSchemaErrors(tools, shape[key], v, baseAt(key), [...at, key])
        : [],
    );
  }
  if (isPlainMap(value) && node instanceof z.ZodRecord) {
    const inner = node.valueType as z.ZodType;
    return Object.entries(value).flatMap(([key, v]) =>
      overrideSchemaErrors(tools, inner, v, baseAt(key), [...at, key]),
    );
  }
  const candidate =
    isPlainMap(value) && isPlainMap(base) ? mergeOverride(base, value) : value;
  const result = node.safeParse(candidate);
  return result.success
    ? []
    : tools.issuesToErrors(
        result.error.issues.map((i) => ({ ...i, path: [...at, ...i.path] })),
        // The candidate, where those paths find it.
        at.reduceRight<unknown>((inner, k) => ({ [k]: inner }), candidate),
      );
}

/** Validate an override against the schema and against its base's keys. */
export function validateOverride(
  tools: SchemaTools,
  override: unknown,
  base: ManifestMap,
): ValidationResult {
  const { version } = tools;
  if (!isPlainMap(override))
    return {
      valid: false,
      version,
      errors: [{ path: "", message: "an override must be a map" }],
      warnings: [],
    };
  const errors = [
    ...overrideKeyErrors(base, override),
    ...overrideSchemaErrors(tools, tools.schema, override, base, []),
  ];
  return { valid: errors.length === 0, version, errors, warnings: [] };
}

function withFile(result: ValidationResult, file: string): ValidationResult {
  const tag = (e: ValidationError): ValidationError => ({ ...e, file });
  return {
    ...result,
    errors: result.errors.map(tag),
    warnings: result.warnings.map(tag),
  };
}

function failure(
  version: number,
  file: string,
  message: string,
): ValidationResult {
  return {
    valid: false,
    version,
    errors: [{ path: "", message, file }],
    warnings: [],
  };
}

/** Read and parse a layer file, or the reason it cannot be used. */
function readLayer(
  file: string,
  layer: ManifestLayer,
  read: ReadLayerFile,
): { value: unknown } | { error: string } {
  try {
    const raw = read(file, layer);
    // A non-map (scalar, list, empty file) is passed on as is, so the
    // validator reports it the way it reports any other bad manifest.
    let value: unknown;
    try {
      value = parseManifestText(file, raw);
    } catch (e) {
      return { error: `could not parse: ${(e as Error).message}` };
    }
    return { value: value ?? (raw.trim() ? raw : null) };
  } catch (e) {
    return { error: `could not read: ${(e as Error).message}` };
  }
}

/**
 * A warning for a held manifest the repo's own manifest has made redundant:
 * the repo's file always wins, so the held one is never read.
 */
function redundantHeldWarning(
  heldFile: string,
  overrideFile: string | null,
): ValidationError {
  const yml = product().manifestYml;
  const name = path.basename(heldFile);
  const key = name.endsWith(yml) ? name.slice(0, -yml.length) : name;
  const asOverride = path.join(
    path.dirname(heldFile),
    `${key}${overrideSuffix()}`,
  );
  return {
    path: "",
    file: heldFile,
    message: `${heldFile} is not used: the repo now carries its own manifest, which always wins`,
    suggestion: overrideFile
      ? `delete it; ${overrideFile} already layers onto the repo's manifest`
      : `delete it, or turn it into an override (${asOverride}) that keeps only what this distribution changes`,
  };
}

/** Validate every manifest layer of `repoPath`, then the merged result. */
export function validateLayers(
  tools: SchemaTools,
  repoPath: string,
  opts: ValidateLayersOptions = {},
): LayeredValidation {
  const read = opts.read ?? readAsIs;
  // Located by name only: every file is read below, through `read`.
  const { baseFile, baseLayer, overrideFile } = locateManifest(repoPath);
  const layers: LayerValidation[] = [];

  if (!baseFile || !baseLayer) {
    if (overrideFile)
      layers.push({
        layer: "override",
        file: overrideFile,
        result: failure(tools.version, overrideFile, orphanOverrideMessage()),
      });
    return { valid: false, layers, applied: [] };
  }

  const base = readLayer(baseFile, baseLayer, read);
  let baseResult =
    "error" in base
      ? failure(tools.version, baseFile, base.error)
      : withFile(tools.validate(base.value), baseFile);
  const redundantHeld =
    baseLayer === "repo" ? heldManifestPath(repoPath) : null;
  if (redundantHeld)
    baseResult = {
      ...baseResult,
      warnings: [
        ...baseResult.warnings,
        redundantHeldWarning(redundantHeld, overrideFile),
      ],
    };
  layers.push({ layer: baseLayer, file: baseFile, result: baseResult });

  let overrideRead: ReturnType<typeof readLayer> | null = null;
  if (overrideFile) {
    const override = readLayer(overrideFile, "override", read);
    overrideRead = override;
    const baseMap = "value" in base && isPlainMap(base.value) ? base.value : {};
    const overrideResult =
      "error" in override
        ? failure(tools.version, overrideFile, override.error)
        : withFile(
            validateOverride(tools, override.value, baseMap),
            overrideFile,
          );
    layers.push({
      layer: "override",
      file: overrideFile,
      result: overrideResult,
    });
    // The merged result is checked once both layers pass on their own, so a
    // layer's error is reported once, against its own file.
    if (
      baseResult.valid &&
      overrideResult.valid &&
      "value" in override &&
      isPlainMap(override.value)
    )
      layers.push({
        layer: "merged",
        file: null,
        result: tools.validate(mergeOverride(baseMap, override.value)),
      });
  }

  return {
    valid: layers.every((l) => l.result.valid),
    layers,
    applied: appliedLayers(baseLayer, base, overrideFile, overrideRead),
  };
}

/** loadManifest's `layers`: both files read as maps, else none. */
function appliedLayers(
  baseLayer: "repo" | "held",
  base: { value: unknown } | { error: string },
  overrideFile: string | null,
  override: { value: unknown } | { error: string } | null,
): ManifestLayer[] {
  if (!("value" in base) || !isPlainMap(base.value)) return [];
  if (!overrideFile) return [baseLayer];
  return override && "value" in override && isPlainMap(override.value)
    ? [baseLayer, "override"]
    : [];
}
