/**
 * The theme contract, den.theme/v1: a look and feel for the web UI, published
 * in a git repo as `den-theme.json` (see schemas/den.theme.v1.json and the
 * den-themes repo's README).
 *
 * validateThemeDir checks what `<cli> theme validate` and `theme add` check:
 * the JSON Schema, the contrast rules below (both modes), the files the
 * manifest names, and that the id matches the directory when asked.
 */
import * as fs from "fs";
import * as path from "path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { getEngineRoot } from "../paths.js";

export const THEME_SCHEMA_ID = "den.theme/v1";
export const THEME_FILE = "den-theme.json";

export type ThemeMode = "dark" | "light";
export type ColorToken =
  | "bg"
  | "surface"
  | "raised"
  | "sunken"
  | "text"
  | "muted"
  | "faint"
  | "border"
  | "border-strong"
  | "accent"
  | "accent-text"
  | "accent-fill"
  | "on-accent"
  | "ok"
  | "warn"
  | "bad"
  | "remote";

export interface ThemeManifest {
  schema: typeof THEME_SCHEMA_ID;
  id: string;
  name: string;
  version: string;
  license: string;
  description?: string;
  author?: string;
  homepage?: string;
  den?: string;
  default_mode?: ThemeMode;
  type?: { sans?: string; mono?: string; display?: string; ja?: string };
  shape?: {
    radius?: string;
    "radius-button"?: string;
    density?: "compact" | "comfortable";
  };
  mark?: {
    svg?: string;
    svg_dark?: string;
    text?: string;
    shape?: "square" | "rounded" | "circle";
  };
  fonts?: {
    family: string;
    license: string;
    files: { path: string; weight?: string; style?: "normal" | "italic" }[];
  }[];
  modes: Record<
    ThemeMode,
    Record<ColorToken, string> & { shadow?: string; bar?: string }
  >;
}

/**
 * [foreground, background, minimum ratio]: every text token on every ground
 * at 4.5:1 (WCAG 1.4.3), and the non-text UI tokens on every ground at 3:1
 * (1.4.11). faint is text too (captions, labels), so it is held to 4.5.
 */
/** Every token Den draws text in. accent is never text (use accent-text). */
export const TEXT_TOKENS: readonly ColorToken[] = [
  "text",
  "muted",
  "faint",
  "accent-text",
  "ok",
  "warn",
  "bad",
  "remote",
];
/** Every ground text and controls sit on. */
export const GROUNDS: readonly ColorToken[] = [
  "bg",
  "surface",
  "raised",
  "sunken",
];

export const CONTRAST_RULES: readonly [ColorToken, ColorToken, number][] = [
  ...TEXT_TOKENS.flatMap((fg) =>
    GROUNDS.map((bg): [ColorToken, ColorToken, number] => [fg, bg, 4.5]),
  ),
  ["on-accent", "accent-fill", 4.5],
  // Non-text UI: focus rings, selection, control borders (WCAG 1.4.11).
  ...(["accent", "border-strong"] as const).flatMap((fg) =>
    GROUNDS.map((bg): [ColorToken, ColorToken, number] => [fg, bg, 3]),
  ),
];

/** WCAG relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two #rrggbb colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastFailure {
  mode: ThemeMode;
  fg: ColorToken;
  bg: ColorToken;
  ratio: number;
  min: number;
}

export function checkContrast(theme: ThemeManifest): ContrastFailure[] {
  const out: ContrastFailure[] = [];
  for (const mode of ["dark", "light"] as const) {
    const t = theme.modes[mode];
    for (const [fg, bg, min] of CONTRAST_RULES) {
      const ratio = contrastRatio(t[fg], t[bg]);
      // Unrounded, as the den-themes validator: 4.49 fails 4.5.
      if (ratio < min)
        out.push({ mode, fg, bg, ratio: Math.floor(ratio * 100) / 100, min });
    }
  }
  return out;
}

export interface ThemeIssue {
  /** JSON pointer into den-theme.json, or "" for the file itself. */
  at: string;
  message: string;
}

export interface ThemeValidation {
  ok: boolean;
  theme?: ThemeManifest;
  issues: ThemeIssue[];
  contrast: ContrastFailure[];
}

let validator: ReturnType<InstanceType<typeof Ajv2020>["compile"]> | null =
  null;

function schemaValidator() {
  if (validator) return validator;
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(getEngineRoot(), "schemas", "den.theme.v1.json"),
      "utf-8",
    ),
  ) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  validator = ajv.compile(schema);
  return validator;
}

/**
 * Why an SVG mark is unsafe, or null. Den shows it with <img>, which runs
 * nothing, but the file is also opened directly: refuse script, handlers,
 * foreign HTML, entities and anything fetched from elsewhere.
 */
export function unsafeSvg(svg: string): string | null {
  if (/<script/i.test(svg)) return "has a <script>";
  if (/<foreignObject/i.test(svg)) return "has a <foreignObject>";
  if (/<!ENTITY|<!DOCTYPE/i.test(svg)) return "declares entities";
  if (/\son\w+\s*=/i.test(svg)) return "has an event handler";
  if (/(?:xlink:)?href\s*=\s*["'](?!#)/i.test(svg))
    return "references an external resource (href must start with #)";
  if (/url\(\s*["']?(?!#)/i.test(svg))
    return "references an external resource (url() must start with #)";
  return null;
}

/** Every file the manifest references, relative to the theme's directory. */
export function themeFiles(theme: ThemeManifest): string[] {
  return [
    theme.mark?.svg,
    theme.mark?.svg_dark,
    ...(theme.fonts ?? []).flatMap((f) => f.files.map((x) => x.path)),
  ].filter((p): p is string => !!p);
}

const SPDX_MESSAGE =
  "license must be an SPDX expression (e.g. MIT, OFL-1.1, LicenseRef-x); UNLICENSED, NONE and NOASSERTION are refused";
const CSS_MESSAGE =
  "must be a plain CSS value: no ; { } < > or backslash, url(), @import or expression()";

/**
 * Say what a rule means where the schema error would not: a `not` clause
 * reports only "must NOT be valid", and the SPDX pattern is unreadable.
 */
function friendlyMessage(e: {
  instancePath: string;
  keyword: string;
}): string | null {
  const license = /\/license$/.test(e.instancePath);
  if (license && (e.keyword === "not" || e.keyword === "pattern"))
    return SPDX_MESSAGE;
  if (e.keyword === "not") return CSS_MESSAGE;
  return null;
}

/**
 * Validate the theme in `dir`. With `expectId`, the manifest's id must match
 * (a repo of several themes keeps each under themes/<id>/).
 */
export function validateThemeDir(
  dir: string,
  opts: { expectId?: string } = {},
): ThemeValidation {
  const file = path.join(dir, THEME_FILE);
  const fail = (message: string): ThemeValidation => ({
    ok: false,
    issues: [{ at: "", message }],
    contrast: [],
  });
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    return fail(
      fs.existsSync(file)
        ? `${THEME_FILE} is not valid JSON: ${(e as Error).message}`
        : `no ${THEME_FILE} in ${dir}`,
    );
  }
  const validate = schemaValidator();
  if (!validate(raw)) {
    return {
      ok: false,
      issues: (validate.errors ?? []).map((e) => ({
        at: e.instancePath,
        message:
          friendlyMessage(e) ??
          `${e.message ?? "invalid"}${
            e.params && "additionalProperty" in e.params
              ? ` (${String(e.params.additionalProperty)})`
              : ""
          }`,
      })),
      contrast: [],
    };
  }
  const theme = raw as ThemeManifest;
  const issues: ThemeIssue[] = [];
  if (opts.expectId && theme.id !== opts.expectId)
    issues.push({
      at: "/id",
      message: `id "${theme.id}" does not match its directory "${opts.expectId}"`,
    });
  const root = path.resolve(dir);
  for (const rel of themeFiles(theme)) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep))
      issues.push({ at: "", message: `${rel} is outside the theme` });
    else if (!fs.existsSync(abs))
      issues.push({ at: "", message: `${rel} is missing` });
    else if (rel.endsWith(".svg")) {
      const bad = unsafeSvg(fs.readFileSync(abs, "utf-8"));
      if (bad)
        issues.push({
          at: "",
          message: `${rel} ${bad}: a mark is an image only`,
        });
    } else if (rel.endsWith(".woff2")) {
      const head = Buffer.alloc(4);
      const fd = fs.openSync(abs, "r");
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (head.toString("latin1") !== "wOF2")
        issues.push({ at: "", message: `${rel} is not a woff2 file` });
      if (
        !fs
          .readdirSync(path.dirname(abs))
          .some((f) => /^(OFL|LICEN[CS]E|COPYING)(\.(txt|md))?$/i.test(f))
      )
        issues.push({
          at: "",
          message: `${rel}: no OFL.txt or LICENSE beside it`,
        });
    }
  }
  for (const f of theme.fonts ?? [])
    if (!f.license.trim())
      issues.push({ at: "/fonts", message: `${f.family}: no license` });
  const contrast = checkContrast(theme);
  return {
    ok: issues.length === 0 && contrast.length === 0,
    theme,
    issues,
    contrast,
  };
}
