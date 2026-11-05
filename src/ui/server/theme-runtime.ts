/**
 * The theme runtime: which theme the web UI draws with, and that theme as CSS.
 *
 * Themes come from three places (see src/ui/cli/theme-command.ts):
 *   built-in  <engineRoot>/themes/den/          Den's own, always present
 *   locked    <distRoot>/plugins/<id>/ + lock   vendored by `theme add`
 *   local     <distRoot>/plugins/<id>/, no lock the distribution's own
 *
 * The active theme is the user's choice (user.yml `appearance.theme`), else
 * the distribution's (org config `theme:`), else den. A choice that is not
 * installed or fails validation falls through to the next, ending at den,
 * with one warning in the server log per bad choice. Only a validated
 * manifest is ever rendered: its values passed the schema's CSS-value rule
 * (no ; { } < > \ url() @import), so writing them into custom properties
 * cannot break out of the declaration.
 */
import * as fs from "fs";
import * as path from "path";
import {
  installedThemeIds,
  readLock,
  themeDirFor,
  validationSummary,
} from "../cli/theme-command.js";
import {
  themeFiles,
  validateThemeDir,
  type ColorToken,
  type ThemeManifest,
  type ThemeMode,
} from "../../shared/theme/contract.js";

export const BUILTIN_THEME = "den";

export type ThemeOrigin = "built-in" | "locked" | "local";

export interface ThemeRoots {
  distRoot: string;
  engineRoot: string;
}

export interface InstalledTheme {
  id: string;
  name: string;
  version: string;
  source: ThemeOrigin;
  /** Validates under this Den: only then is it rendered or served. */
  ok: boolean;
  /** Why it is not ok. */
  problem?: string;
  dir: string;
  theme?: ThemeManifest;
}

export const COLOR_TOKENS: readonly ColorToken[] = [
  "bg",
  "surface",
  "raised",
  "sunken",
  "text",
  "muted",
  "faint",
  "border",
  "border-strong",
  "accent",
  "accent-text",
  "accent-fill",
  "on-accent",
  "ok",
  "warn",
  "bad",
  "remote",
];

export function builtinThemeDir(engineRoot: string): string {
  return path.join(engineRoot, "themes", BUILTIN_THEME);
}

function inspect(
  id: string,
  dir: string,
  source: ThemeOrigin,
  expectId?: string,
): InstalledTheme {
  const v = validateThemeDir(dir, expectId ? { expectId } : {});
  return {
    id,
    name: v.theme?.name ?? id,
    version: v.theme?.version ?? "?",
    source,
    ok: v.ok,
    ...(v.ok ? {} : { problem: validationSummary(v) }),
    dir,
    ...(v.theme ? { theme: v.theme } : {}),
  };
}

/** Every theme this distribution can use: den first, then plugins/<id>/ sorted. */
export function listThemes(roots: ThemeRoots): InstalledTheme[] {
  let lock: ReturnType<typeof readLock> = {};
  try {
    lock = readLock(roots.distRoot);
  } catch {
    /* an unreadable lock: every theme is then local; `theme list` reports it */
  }
  const out = [
    inspect(BUILTIN_THEME, builtinThemeDir(roots.engineRoot), "built-in"),
  ];
  for (const id of installedThemeIds(roots.distRoot)) {
    if (id === BUILTIN_THEME) continue; // the built-in one is never shadowed
    out.push(
      inspect(
        id,
        themeDirFor(roots.distRoot, id),
        lock[id]?.kinds?.includes("theme") ? "locked" : "local",
        id,
      ),
    );
  }
  return out;
}

/** One theme by id, or null when no such theme is installed. */
export function findTheme(
  roots: ThemeRoots,
  id: string,
): InstalledTheme | null {
  if (id === BUILTIN_THEME)
    return inspect(id, builtinThemeDir(roots.engineRoot), "built-in");
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) return null;
  if (!installedThemeIds(roots.distRoot).includes(id)) return null;
  let locked = false;
  try {
    locked = !!readLock(roots.distRoot)[id]?.kinds?.includes("theme");
  } catch {
    /* see listThemes */
  }
  return inspect(
    id,
    themeDirFor(roots.distRoot, id),
    locked ? "locked" : "local",
    id,
  );
}

export interface ThemeChoice {
  /** user.yml `appearance.theme`. */
  user?: string | null;
  /** The org config's `theme:`. */
  distribution?: string | null;
}

export interface ActiveTheme {
  id: string;
  theme: ThemeManifest;
  dir: string;
  source: ThemeOrigin;
  /** Which choice won. */
  chosenBy: "user" | "distribution" | "default";
}

const warned = new Set<string>();

/** Forget which warnings were logged (tests). */
export function resetThemeWarnings(): void {
  warned.clear();
}

/**
 * The theme to draw with. Never throws: a bad choice is warned about once
 * and skipped. Null only if Den's own theme is unusable (a broken install).
 */
export function resolveActiveTheme(
  roots: ThemeRoots,
  choice: ThemeChoice,
  warn: (line: string) => void = (l) => console.warn(l),
): ActiveTheme | null {
  const candidates: [string, ActiveTheme["chosenBy"], string][] = [];
  if (choice.user) candidates.push([choice.user, "user", "your appearance"]);
  if (choice.distribution)
    candidates.push([
      choice.distribution,
      "distribution",
      "the distribution's `theme:`",
    ]);
  candidates.push([BUILTIN_THEME, "default", "the default"]);
  for (const [id, chosenBy, label] of candidates) {
    let t: InstalledTheme | null = null;
    try {
      t = findTheme(roots, String(id));
    } catch (e) {
      t = null;
      warnOnce(
        warn,
        `${id}:error`,
        () =>
          `theme "${id}" (${label}) could not be read: ${(e as Error).message}`,
      );
    }
    if (t?.ok && t.theme)
      return {
        id: t.id,
        theme: t.theme,
        dir: t.dir,
        source: t.source,
        chosenBy,
      };
    if (id === BUILTIN_THEME && chosenBy === "default") {
      warnOnce(
        warn,
        "den:broken",
        () =>
          `the built-in theme is not valid (${t?.problem ?? "missing"}); the UI has no theme`,
      );
      return null;
    }
    warnOnce(warn, `${id}:${t ? "invalid" : "missing"}`, () =>
      t
        ? `theme "${id}" (${label}) is not valid under this Den: ${t.problem}; using the next choice`
        : `theme "${id}" (${label}) is not installed; using the next choice`,
    );
  }
  return null;
}

function warnOnce(
  warn: (line: string) => void,
  key: string,
  line: () => string,
): void {
  if (warned.has(key)) return;
  warned.add(key);
  warn(`[theme] ${line()}`);
}

/** URL of a file in a theme, as /theme/<id>/<file> serves it. */
export function themeAssetUrl(id: string, rel: string): string {
  return `/theme/${id}/${rel.split("/").map(encodeURIComponent).join("/")}`;
}

const DEFAULT_TYPE = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  ja: '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", Meiryo, sans-serif',
};

/**
 * The theme as CSS: @font-face for its fonts, type and shape on :root, and
 * one block of color tokens per mode, selected by <html data-mode>. The
 * theme's default mode also applies when data-mode is unset.
 */
export function renderThemeCss(id: string, theme: ThemeManifest): string {
  const lines: string[] = [
    `/* ${theme.name} ${theme.version} (${id}, den.theme/v1). Generated by Den from den-theme.json. */`,
  ];
  for (const f of theme.fonts ?? [])
    for (const file of f.files) {
      const [lo, hi] = (file.weight ?? "400").split(" ");
      lines.push(
        `@font-face { font-family: "${f.family}"; src: url("${themeAssetUrl(id, file.path)}") format("woff2"); font-weight: ${hi ? `${lo} ${hi}` : lo}; font-style: ${file.style ?? "normal"}; font-display: swap; }`,
      );
    }
  const type = theme.type ?? {};
  const shape = theme.shape ?? {};
  const sans = type.sans ?? DEFAULT_TYPE.sans;
  lines.push(
    ":root {",
    `  --sans: ${sans};`,
    `  --mono: ${type.mono ?? DEFAULT_TYPE.mono};`,
    `  --display: ${type.display ?? sans};`,
    `  --ja: ${type.ja ?? DEFAULT_TYPE.ja};`,
    `  --radius: ${shape.radius ?? "8px"};`,
    `  --radius-button: ${shape["radius-button"] ?? "6px"};`,
    `  --density: ${shape.density === "compact" ? "0.85" : "1"};`,
    "}",
  );
  const def: ThemeMode = theme.default_mode ?? "dark";
  for (const mode of [def, def === "dark" ? "light" : "dark"] as ThemeMode[]) {
    const c = theme.modes[mode];
    const sel =
      mode === def
        ? `:root,\n:root[data-mode="${mode}"]`
        : `:root[data-mode="${mode}"]`;
    lines.push(`${sel} {`, `  color-scheme: ${mode};`);
    for (const t of COLOR_TOKENS) lines.push(`  --${t}: ${c[t]};`);
    lines.push(
      `  --shadow: ${c.shadow ?? (mode === "dark" ? "0 12px 30px rgb(0 0 0 / 0.5)" : "0 8px 24px rgb(0 0 0 / 0.14)")};`,
      `  --bar: ${c.bar ?? "none"};`,
      "}",
    );
  }
  return `${lines.join("\n")}\n`;
}

const ASSET_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/**
 * The file /theme/<id>/<rel> may serve, or null: only a file the validated
 * manifest names (its mark, its fonts), only .svg or .woff2, only inside
 * the theme's directory. `rel` is the decoded remainder of the URL path.
 */
export function themeAsset(
  roots: ThemeRoots,
  id: string,
  rel: string,
): { file: string; type: string } | null {
  const type = ASSET_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return null;
  const t = findTheme(roots, id);
  if (!t?.ok || !t.theme) return null;
  if (!themeFiles(t.theme).includes(rel)) return null;
  const root = path.resolve(t.dir);
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep)) return null;
  try {
    // Resolve links too: the real file must still be inside the theme.
    const real = fs.realpathSync(file);
    const realRoot = fs.realpathSync(root);
    if (!real.startsWith(realRoot + path.sep) || !fs.statSync(real).isFile())
      return null;
    return { file: real, type };
  } catch {
    return null;
  }
}
