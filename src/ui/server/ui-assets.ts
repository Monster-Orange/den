/**
 * Static assets the graph needs beyond the pages themselves:
 *   - the UI's own modules in public/ (UI_MODULES: the graph, the appearance
 *     controls, the version label, the top bar's chips and overlays),
 *     served like header.js;
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
  "/changelog-view.js",
  "/health-fit.js",
  "/health-rollup.js",
  "/shell.js",
  "/settings-registry.js",
  "/settings-page.js",
  "/topbar.js",
  "/edge-page.js",
  "/error-page.js",
  "/agents-section.js",
  "/agents-page.js",
  // The Start agent form's choices, shared by both (AG-10.0).
  "/agent-start.js",
  // AG-10.4-10.7: the persona picker, editor and Settings › Personas.
  "/persona-ui.js",
  "/persona-ui.css",
  // AG-4b: the panes' keys and links (Shift+Enter, ⌃⇧1-3, paths).
  "/term-input.js",
  // SEC-2a: Pair a device's QR code (a tiny encoder of Den's own).
  "/qr.js",
  // The UI's catalogs other than English (R19; en is in shell.js).
  "/i18n/ja.js",
  "/i18n/es.js",
  // 0.4.17: one org and workspace rule for Environments and Releases.
  "/view-scope.js",
];

/** URL path → file inside node_modules. */
export const VENDOR_ASSETS: Readonly<Record<string, string>> = {
  "/vendor/elk.bundled.js": "elkjs/lib/elk.bundled.js",
  // The Agents tab's terminal panes (AG-4a-term): xterm.js and its fit
  // addon, ES modules, MIT.
  "/vendor/xterm.mjs": "@xterm/xterm/lib/xterm.mjs",
  "/vendor/xterm.css": "@xterm/xterm/css/xterm.css",
  "/vendor/addon-fit.mjs": "@xterm/addon-fit/lib/addon-fit.mjs",
  // AG-4b: plain URLs in a pane are links (⌘- or Ctrl-click opens them).
  "/vendor/addon-web-links.mjs":
    "@xterm/addon-web-links/lib/addon-web-links.mjs",
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
    "Content-Type": file.endsWith(".css")
      ? "text/css"
      : "application/javascript",
    "Cache-Control": "public, max-age=86400",
  });
  res.end(fs.readFileSync(file));
  return true;
}
