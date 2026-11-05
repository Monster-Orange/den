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
import semver from "semver";
import { engineVersion, getEngineRoot } from "../paths.js";

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
    png?: string;
    png_dark?: string;
    webp?: string;
    webp_dark?: string;
    text?: string;
    shape?: "square" | "rounded" | "circle";
  };
  /** The browser-tab icon (.png, .svg or .ico); else the mark's file. */
  favicon?: string;
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

/** The image kinds a mark can be drawn from: one per mark. */
export const MARK_IMAGE_KINDS = ["svg", "png", "webp"] as const;
export type MarkImageKind = (typeof MARK_IMAGE_KINDS)[number];

/** The image kinds a mark names (svg, png, webp; a dark variant counts). */
export function markImageKinds(
  mark: ThemeManifest["mark"] | undefined,
): MarkImageKind[] {
  const m = mark ?? {};
  return MARK_IMAGE_KINDS.filter((k) => m[k] || m[`${k}_dark`]);
}

/**
 * The mark's image file for a mode: the dark variant in dark mode when the
 * mark has one, else the base file; null for a text mark (or none).
 */
export function markImage(
  mark: ThemeManifest["mark"] | undefined,
  mode: ThemeMode,
): { kind: MarkImageKind; file: string } | null {
  const m = mark ?? {};
  for (const kind of MARK_IMAGE_KINDS) {
    const base = m[kind];
    if (!base) continue;
    const dark = m[`${kind}_dark`];
    return { kind, file: mode === "dark" && dark ? dark : base };
  }
  return null;
}

/** The largest raster mark or favicon file, in bytes. */
export const IMAGE_MAX_BYTES = 64 * 1024;
/** A raster mark's smallest side: 2× the top bar's 22px mark. */
export const RASTER_MIN_PX = 44;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/**
 * A PNG's or a WebP's size in pixels, from its own header (PNG IHDR; WebP
 * VP8, VP8L or VP8X), or null when `buf` is not that format.
 */
export function rasterSize(
  buf: Buffer,
  format: "png" | "webp",
): { width: number; height: number } | null {
  if (format === "png") {
    if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE))
      return null;
    if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (
    buf.length < 30 ||
    buf.toString("latin1", 0, 4) !== "RIFF" ||
    buf.toString("latin1", 8, 12) !== "WEBP"
  )
    return null;
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X")
    return {
      width: buf.readUIntLE(24, 3) + 1,
      height: buf.readUIntLE(27, 3) + 1,
    };
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) return null;
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

/** Whether `buf` starts as an .ico file does (00 00 01 00). */
function isIco(buf: Buffer): boolean {
  return (
    buf.length >= 6 &&
    buf[0] === 0 &&
    buf[1] === 0 &&
    buf[2] === 1 &&
    buf[3] === 0
  );
}

/**
 * What is wrong with a raster mark or favicon file, as messages (empty when
 * nothing): its first bytes must be its extension's format, it is at most
 * 64 KB, and a raster mark is at least 44×44 px.
 */
export function imageFileIssues(
  rel: string,
  buf: Buffer,
  opts: { minPx?: number } = {},
): string[] {
  const ext = path.extname(rel).toLowerCase();
  const out: string[] = [];
  if (buf.length > IMAGE_MAX_BYTES)
    out.push(
      `${rel} is ${Math.ceil(buf.length / 1024)} KB: a mark or favicon file is at most ${IMAGE_MAX_BYTES / 1024} KB`,
    );
  if (ext === ".ico") {
    if (!isIco(buf))
      out.push(`${rel} is not an ICO file (it does not start 00 00 01 00)`);
    return out;
  }
  const format = ext === ".png" ? "png" : ext === ".webp" ? "webp" : null;
  if (!format) return out;
  const size = rasterSize(buf, format);
  if (!size) {
    out.push(
      format === "png"
        ? `${rel} is not a PNG file (it does not start with the PNG signature 89 50 4E 47 0D 0A 1A 0A)`
        : `${rel} is not a WebP file (it does not start RIFF….WEBP with a VP8, VP8L or VP8X header)`,
    );
    return out;
  }
  const min = opts.minPx ?? 0;
  if (size.width < min || size.height < min)
    out.push(
      `${rel} is ${size.width}×${size.height} px: a raster mark is at least ${min}×${min} px (2× the 22px bar mark)`,
    );
  return out;
}

/** Every file the manifest references, relative to the theme's directory. */
export function themeFiles(theme: ThemeManifest): string[] {
  return [
    theme.mark?.svg,
    theme.mark?.svg_dark,
    theme.mark?.png,
    theme.mark?.png_dark,
    theme.mark?.webp,
    theme.mark?.webp_dark,
    theme.favicon,
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
export function friendlyMessage(e: {
  instancePath: string;
  keyword: string;
}): string | null {
  const license = /\/license$/.test(e.instancePath);
  if (license && (e.keyword === "not" || e.keyword === "pattern"))
    return SPDX_MESSAGE;
  if (e.keyword === "not") return CSS_MESSAGE;
  return null;
}

type SchemaError = {
  instancePath: string;
  keyword: string;
  message?: string;
  params?: Record<string, unknown>;
};

/**
 * Schema errors as issues, with the friendly messages above. `extra` says
 * what another schema's own rules mean (den.plugin/v1's capabilities); the
 * plugin schema shares the SPDX rule, so it shares this too.
 */
export function schemaIssues(
  errors: SchemaError[] | null | undefined,
  extra: (e: SchemaError) => string | null = () => null,
): ThemeIssue[] {
  return (errors ?? []).map((e) => ({
    at: e.instancePath,
    message:
      extra(e) ??
      friendlyMessage(e) ??
      `${e.message ?? "invalid"}${
        e.params && "additionalProperty" in e.params
          ? ` (${String(e.params.additionalProperty)})`
          : ""
      }`,
  }));
}

/**
 * Why a manifest's `den` range excludes the running Den, or null. A range
 * that is not valid semver is an error too. Prereleases count: 0.3.0-dev.7
 * satisfies ">=0.3.0-0 <0.4.0" but not ">=0.3.0", which gets a hint
 * (PL-SPEC d4: validate fails, load skips).
 */
export function denRangeIssue(
  range: string | undefined,
  version: string | undefined = engineVersion(),
): string | null {
  if (range === undefined) return null;
  if (!semver.validRange(range))
    return `den range "${range}" is not a semver range`;
  if (!version) return null;
  if (semver.satisfies(version, range, { includePrerelease: true }))
    return null;
  // A prerelease Den that misses only for being a prerelease (>=0.3.0 on
  // 0.3.0-dev.9): say how to write the range, from its own lower bound.
  const release = semver.prerelease(version)
    ? `${semver.major(version)}.${semver.minor(version)}.${semver.patch(version)}`
    : null;
  const hint =
    release && semver.satisfies(release, range)
      ? ` (prerelease builds need a -0 range, e.g. >=${semver.minVersion(range)?.version ?? release}-0)`
      : "";
  return `needs Den ${range}; this is ${version}${hint}`;
}

/**
 * Validate the theme in `dir`. With `expectId`, the manifest's id must match
 * (a repo of several themes keeps each under themes/<id>/).
 */
export function validateThemeDir(
  dir: string,
  opts: { expectId?: string; denVersion?: string } = {},
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
      issues: schemaIssues(validate.errors),
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
  const kinds = markImageKinds(theme.mark);
  if (kinds.length > 1)
    issues.push({
      at: "/mark",
      message: `mark gives ${kinds.join(" and ")}: a mark is one image (svg, png or webp), or text`,
    });
  for (const k of ["png", "webp"] as const)
    if (theme.mark?.[`${k}_dark`] && !theme.mark[k])
      issues.push({
        at: `/mark/${k}_dark`,
        message: `mark.${k}_dark needs mark.${k} (the base file, for light mode)`,
      });
  const rasterMarks = new Set(
    [
      theme.mark?.png,
      theme.mark?.png_dark,
      theme.mark?.webp,
      theme.mark?.webp_dark,
    ].filter(Boolean),
  );
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
      if (rel === theme.favicon && fs.statSync(abs).size > IMAGE_MAX_BYTES)
        issues.push(
          ...imageFileIssues(rel, fs.readFileSync(abs)).map((message) => ({
            at: "",
            message,
          })),
        );
    } else if (/\.(png|webp|ico)$/.test(rel)) {
      // A raster mark or favicon: its format by its first bytes, its size,
      // and (a mark) its pixels, read from its own header.
      for (const message of imageFileIssues(rel, fs.readFileSync(abs), {
        minPx: rasterMarks.has(rel) ? RASTER_MIN_PX : 0,
      }))
        issues.push({ at: "", message });
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
  const range = denRangeIssue(theme.den, opts.denVersion);
  if (range) issues.push({ at: "/den", message: range });
  const contrast = checkContrast(theme);
  return {
    ok: issues.length === 0 && contrast.length === 0,
    theme,
    issues,
    contrast,
  };
}
