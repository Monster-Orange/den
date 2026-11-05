/**
 * Theme routes (GET only):
 *
 *   /theme.css            the active theme as CSS custom properties, both
 *                         modes (see theme-runtime.ts renderThemeCss)
 *   /theme/<id>/<file>    a file the theme's validated manifest names (its
 *                         mark .svg, its .woff2 fonts), nothing else
 *   /theme-favicon/<id>?mode=light|dark&v=<version>-<hash>
 *                         theme <id>'s browser-tab icon in that mode (its
 *                         `favicon`, else its mark's file, the dark variant
 *                         in dark mode, else Den's own icon); `v` only makes
 *                         the URL change with the file. /theme-favicon with
 *                         no id is the active theme's, never cached.
 *   /api/themes           the installed themes, the active one (with its
 *                         favicon URLs per mode) and the org default (what
 *                         appearance.theme null draws)
 *
 * Collaborators are injectable for tests.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { send404, sendJson } from "./http-helpers.js";
import type { AppearancePrefs } from "./appearance-prefs.js";
import type { ThemeManifest, ThemeMode } from "../../shared/theme/contract.js";
import {
  faviconFile,
  findTheme,
  listThemes,
  renderThemeCss,
  resolveActiveTheme,
  themeAsset,
  themeAssetUrl,
  type ActiveTheme,
  type ThemeRoots,
} from "./theme-runtime.js";

export interface ThemeRouteDeps {
  roots: () => ThemeRoots;
  /** The user's appearance prefs (user.yml). */
  prefs: () => AppearancePrefs;
  /** The org config's `theme:`. */
  distributionTheme: () => string | null | undefined;
  warn: (line: string) => void;
  /** Den's own tab icon (public/favicon.ico), for a theme with a text mark. */
  denFavicon?: string;
}

function denFaviconPath(deps: ThemeRouteDeps): string {
  return (
    deps.denFavicon ??
    path.join(
      deps.roots().engineRoot,
      "src",
      "ui",
      "server",
      "public",
      "favicon.ico",
    )
  );
}

/**
 * The file and type theme `id` shows in the browser tab in `mode`: a file
 * its manifest names (themeAsset's rule), else Den's own icon.
 */
function faviconAsset(
  deps: ThemeRouteDeps,
  id: string,
  theme: ThemeManifest,
  mode: ThemeMode,
): { file: string; type: string } | null {
  const rel = faviconFile(theme, mode);
  if (rel) return themeAsset(deps.roots(), id, rel);
  const file = denFaviconPath(deps);
  return fs.existsSync(file) ? { file, type: "image/x-icon" } : null;
}

/** /theme-favicon/<id>?mode=<mode>&v=<version>-<content hash>. */
function faviconUrl(
  deps: ThemeRouteDeps,
  a: ActiveTheme,
  mode: ThemeMode,
): string | null {
  const asset = faviconAsset(deps, a.id, a.theme, mode);
  if (!asset) return null;
  const hash = createHash("sha256")
    .update(fs.readFileSync(asset.file))
    .digest("hex")
    .slice(0, 10);
  return `/theme-favicon/${a.id}?mode=${mode}&v=${encodeURIComponent(`${a.theme.version}-${hash}`)}`;
}

/** The active theme for these deps (the user's, the distribution's, den). */
export function activeTheme(deps: ThemeRouteDeps): ActiveTheme | null {
  let prefs: AppearancePrefs = { theme: null, mode: "system" };
  let dist: string | null | undefined = null;
  try {
    prefs = deps.prefs();
  } catch (e) {
    deps.warn(`[theme] user config unreadable: ${(e as Error).message}`);
  }
  try {
    dist = deps.distributionTheme();
  } catch (e) {
    deps.warn(`[theme] org config unreadable: ${(e as Error).message}`);
  }
  return resolveActiveTheme(
    deps.roots(),
    { user: prefs.theme, distribution: typeof dist === "string" ? dist : null },
    deps.warn,
  );
}

/**
 * The org default: the theme drawn when you have chosen none (the org
 * config's `brand.theme` if it is installed and valid, else den).
 */
export function orgDefaultTheme(deps: ThemeRouteDeps): ActiveTheme | null {
  let dist: string | null | undefined = null;
  try {
    dist = deps.distributionTheme();
  } catch {
    /* warned by activeTheme */
  }
  return resolveActiveTheme(
    deps.roots(),
    { user: null, distribution: typeof dist === "string" ? dist : null },
    deps.warn,
  );
}

function markOf(a: ActiveTheme) {
  const m = a.theme.mark ?? {};
  return {
    svg: m.svg ? themeAssetUrl(a.id, m.svg) : null,
    svg_dark: m.svg_dark ? themeAssetUrl(a.id, m.svg_dark) : null,
    png: m.png ? themeAssetUrl(a.id, m.png) : null,
    png_dark: m.png_dark ? themeAssetUrl(a.id, m.png_dark) : null,
    webp: m.webp ? themeAssetUrl(a.id, m.webp) : null,
    webp_dark: m.webp_dark ? themeAssetUrl(a.id, m.webp_dark) : null,
    text: m.text ?? null,
    shape: m.shape ?? null,
  };
}

/** Handles the routes above; false when `pathname` is not one of them. */
export function handleThemeRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  deps: ThemeRouteDeps,
): boolean {
  const isAsset = pathname.startsWith("/theme/");
  const isFavicon =
    pathname === "/theme-favicon" || pathname.startsWith("/theme-favicon/");
  if (
    pathname !== "/theme.css" &&
    pathname !== "/api/themes" &&
    !isAsset &&
    !isFavicon
  )
    return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET" });
    res.end("read-only");
    return true;
  }

  if (isFavicon) {
    const id = pathname.slice("/theme-favicon/".length);
    const q = new URL(req.url ?? "/", "http://localhost").searchParams;
    const mode: ThemeMode = q.get("mode") === "dark" ? "dark" : "light";
    let t: { id: string; theme: ThemeManifest } | null = null;
    if (pathname === "/theme-favicon") t = activeTheme(deps);
    else {
      const found = /^[a-z][a-z0-9-]{1,39}$/.test(id)
        ? findTheme(deps.roots(), id)
        : null;
      if (found?.ok && found.theme) t = { id: found.id, theme: found.theme };
    }
    const asset = t && faviconAsset(deps, t.id, t.theme, mode);
    if (!asset) {
      send404(res);
      return true;
    }
    const headers: Record<string, string> = {
      "Content-Type": asset.type,
      "X-Content-Type-Options": "nosniff",
      // The versioned URL names the file; the bare one follows your choice.
      "Cache-Control": pathname === "/theme-favicon" ? "no-store" : "no-cache",
    };
    if (asset.type === "image/svg+xml")
      headers["Content-Security-Policy"] =
        "default-src 'none'; style-src 'unsafe-inline'";
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : fs.readFileSync(asset.file));
    return true;
  }

  if (pathname === "/theme.css") {
    const a = activeTheme(deps);
    res.writeHead(200, {
      "Content-Type": "text/css; charset=utf-8",
      // The theme follows the user's choice: never serve yesterday's.
      "Cache-Control": "no-store",
    });
    res.end(a ? renderThemeCss(a.id, a.theme) : "/* no valid theme */\n");
    return true;
  }

  if (pathname === "/api/themes") {
    const a = activeTheme(deps);
    let prefs: AppearancePrefs = { theme: null, mode: "system" };
    try {
      prefs = deps.prefs();
    } catch {
      /* warned by activeTheme */
    }
    const org = orgDefaultTheme(deps);
    sendJson(res, {
      // What "Org default" in the Theme menu means: appearance.theme null.
      org_default: org ? { id: org.id, name: org.theme.name } : null,
      active: a
        ? {
            id: a.id,
            name: a.theme.name,
            version: a.theme.version,
            source: a.source,
            chosen_by: a.chosenBy,
            default_mode: a.theme.default_mode ?? "dark",
            mark: markOf(a),
            // The tab icon per mode: the shell sets the one for the mode
            // it draws in (appearance.js).
            favicon: {
              light: faviconUrl(deps, a, "light"),
              dark: faviconUrl(deps, a, "dark"),
            },
          }
        : null,
      prefs,
      themes: listThemes(deps.roots()).map((t) => ({
        id: t.id,
        name: t.name,
        version: t.version,
        source: t.source,
        ok: t.ok,
        ...(t.problem ? { problem: t.problem } : {}),
      })),
    });
    return true;
  }

  // /theme/<id>/<file…>. Each segment is decoded and must be a plain name:
  // an encoded slash, dot segment or NUL never reaches the lookup, which in
  // turn only matches the exact paths the manifest names.
  const [id, ...segs] = pathname.slice("/theme/".length).split("/");
  let rel: string;
  try {
    const parts = segs.map((s) => decodeURIComponent(s));
    if (
      !id ||
      parts.length === 0 ||
      parts.some((p) => !p || p === "." || p === ".." || /[\\/\0]/.test(p))
    ) {
      send404(res);
      return true;
    }
    rel = parts.join("/");
  } catch {
    send404(res);
    return true;
  }
  const asset = themeAsset(deps.roots(), id, rel);
  if (!asset) {
    send404(res);
    return true;
  }
  const headers: Record<string, string> = {
    "Content-Type": asset.type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-cache",
  };
  // Opened directly, an SVG is a document: let it run nothing, fetch nothing.
  if (asset.type === "image/svg+xml")
    headers["Content-Security-Policy"] =
      "default-src 'none'; style-src 'unsafe-inline'";
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : fs.readFileSync(asset.file));
  return true;
}
