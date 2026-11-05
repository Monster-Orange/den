/**
 * Theme routes (GET only):
 *
 *   /theme.css            the active theme as CSS custom properties, both
 *                         modes (see theme-runtime.ts renderThemeCss)
 *   /theme/<id>/<file>    a file the theme's validated manifest names (its
 *                         mark .svg, its .woff2 fonts), nothing else
 *   /api/themes           the installed themes and the active one
 *
 * Collaborators are injectable for tests.
 */
import * as fs from "fs";
import * as http from "http";
import { send404, sendJson } from "./http-helpers.js";
import type { AppearancePrefs } from "./appearance-prefs.js";
import {
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

function markOf(a: ActiveTheme) {
  const m = a.theme.mark ?? {};
  return {
    svg: m.svg ? themeAssetUrl(a.id, m.svg) : null,
    svg_dark: m.svg_dark ? themeAssetUrl(a.id, m.svg_dark) : null,
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
  if (pathname !== "/theme.css" && pathname !== "/api/themes" && !isAsset)
    return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET" });
    res.end("read-only");
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
    sendJson(res, {
      active: a
        ? {
            id: a.id,
            name: a.theme.name,
            version: a.theme.version,
            source: a.source,
            chosen_by: a.chosenBy,
            default_mode: a.theme.default_mode ?? "dark",
            mark: markOf(a),
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
