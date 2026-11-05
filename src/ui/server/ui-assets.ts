/**
 * Static assets the graph needs beyond the pages themselves:
 *   - the UI's own modules in public/ (UI_MODULES: the graph, the appearance
 *     controls, the version label), served like header.js;
 *   - browser libraries the UI loads, served by Den's own server from
 * node_modules (never a CDN), so the UI works offline. Each is a pinned
 * dependency in package.json. npm hoists Den's dependencies into a
 * distribution's node_modules, so the lookup walks up from the engine root,
 * like engineBin does.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { getEngineRoot } from "../../shared/paths.js";
import { serveFile } from "./http-helpers.js";

/** The graph's modules in public/, each served at /<name>. */
export const UI_MODULES: readonly string[] = [
  "/graph.js",
  "/graph-model.js",
  "/panel.js",
  "/graph.css",
  "/appearance.js",
  "/version-label.js",
];

/** URL path → file inside node_modules. */
export const VENDOR_ASSETS: Readonly<Record<string, string>> = {
  "/vendor/elk.bundled.js": "elkjs/lib/elk.bundled.js",
};

/** The installed file for a vendored URL path, or null. */
export function vendorAssetFile(
  pathname: string,
  engineRoot: string = getEngineRoot(),
): string | null {
  const rel = Object.hasOwn(VENDOR_ASSETS, pathname)
    ? VENDOR_ASSETS[pathname]
    : undefined;
  if (!rel) return null;
  let dir = path.resolve(engineRoot);
  for (;;) {
    const candidate = path.join(dir, "node_modules", rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Serves a UI module or vendored asset; false when `pathname` is neither. */
export function serveUiAsset(
  res: http.ServerResponse,
  pathname: string,
  publicDir: string,
): boolean {
  if (UI_MODULES.includes(pathname)) {
    serveFile(res, path.join(publicDir, pathname.slice(1)));
    return true;
  }
  if (!pathname.startsWith("/vendor/")) return false;
  const file = vendorAssetFile(pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return true;
  }
  // Pinned versions: the bytes only change with Den itself. Not run through
  // the product-token fill the UI's own scripts get.
  res.writeHead(200, {
    "Content-Type": "application/javascript",
    "Cache-Control": "public, max-age=86400",
  });
  res.end(fs.readFileSync(file));
  return true;
}
