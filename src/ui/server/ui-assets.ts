/**
 * Static assets the graph needs beyond the pages themselves:
 *   - the UI's own modules in public/ (UI_MODULES: the graph, the appearance
 *     controls, the version label, the top bar's chips and overlays),
 *     served like header.js;
 *   - browser libraries the UI loads, served by Den's own server from
 * node_modules (never a CDN), so the UI works offline. Each is a pinned
 * dependency in package.json. npm hoists Den's dependencies into a
 * distribution's node_modules, so the lookup walks up from the engine root,
 * like engineBin does;
 *   - den-ui, the UI kit (packages/den-ui), at /kit/<file>.
 */
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { getEngineRoot } from "../../shared/paths.js";
import { serveFile, stampServed } from "./http-helpers.js";

/** The graph's modules in public/, each served at /<name>. */
export const UI_MODULES: readonly string[] = [
  "/graph.js",
  "/graph-model.js",
  "/panel.js",
  "/graph.css",
  "/appearance.js",
  "/health-fit.js",
  "/health-rollup.js",
  "/shell.js",
  "/settings-registry.js",
  "/settings-page.js",
  "/topbar.js",
  // NT-3: the bell in the top bar.
  "/bell.js",
  // Issue 172: alerts outside the bell (desktop notifications).
  "/alerts.js",
  // Issue 172 S2: the service worker that shows push alerts.
  "/den-sw.js",
  "/edge-page.js",
  // Issue 209: the Verify page.
  "/verify-page.js",
  "/error-page.js",
  "/agents-section.js",
  "/agents-page.js",
  // D32: an agent's helpers, and the shared read-only transcript view.
  "/agent-helpers.js",
  // Issue 96: where a move in a project's order goes.
  "/agent-order.js",
  "/transcript-view.js",
  // The Start agent form's choices, shared by both (AG-10.0).
  "/agent-start.js",
  // AG-10.4-10.7: the persona picker, editor and Settings › Personas.
  "/persona-ui.js",
  "/persona-ui.css",
  // AG-4b: the panes' keys and links (Shift+Enter, ⌃⇧1-3, paths).
  "/term-input.js",
  // AG-DROP: a file dropped, pasted or attached onto an agent's terminal.
  "/term-drop.js",
  // Issue 103: a composer for one agent (deep links, the embedded pane).
  "/agent-composer.js",
  "/embed-page.js",
  "/embed-connect.js",
  // SEC-2a: Pair a device's QR code (a tiny encoder of Den's own).
  "/qr.js",
  // The UI's catalogs other than English (R19; en is in shell.js).
  "/i18n/ja.js",
  "/i18n/es.js",
  // 0.4.17: one org and workspace rule for Environments and Releases.
  "/view-scope.js",
  // ON-6: the server agent's page.
  "/server-agent-page.js",
  // 0.4.18: the service panel (rail pins, Graph ⋯, Services names).
  "/svc-panel.js",
  // D30: the shared searchable picker (Settings › Agents › Rotation).
  "/combobox.js",
  // 0.4.18: where a service's live log comes from (Logs page and panel).
  "/log-source.js",
  // D50: how every pop-over closes (a press outside, Esc).
  "/popover.js",
  // Issue 144: the Agents page's gate chip (heavy test runs take turns).
  "/gate-chip.js",
  // 0.4.46: one terminal pane connection, reconnecting on its own.
  "/pane-reconnect.js",
  "/term-pane.js",
  // D64: Restart Den from the browser, in place.
  "/restart-den.js",
  // UK-2: Den's actions on the kit's working pop-up (/kit/busy.js).
  "/busy-den.js",
  // issue 133: Den's words and Report on the kit's dialogs (/kit/dialog.js).
  "/dialog-den.js",
  // FB (den#81): Report an issue: the kit's form on Den's adapter, and
  // My reports (issue 95: the form, its screenshot, What's new and the
  // version chip are the kit's now, /kit/).
  "/report-den.js",
  // Issue 95: Den's adapter for the kit's client entry (/kit/kit.js).
  "/den-kit.js",
  // FB (den#81): the Report button in every pop-up's footer.
  "/report-inject.js",
  "/ws-delete-agents.js",
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
  // FB (den#81): Report an issue's screenshot. html-to-image, MIT, the
  // same version and bytes as Hub's copy (one copy for both in UK-3).
  "/vendor/html-to-image.js": "html-to-image/dist/html-to-image.js",
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

/**
 * den-ui (UK-1): the kit's files Den serves at /kit/<file>, from the
 * package inside Den's own install (packages/den-ui/src). Only these.
 */
export const KIT_FILES: readonly string[] = [
  "fonts.css",
  "tokens.css",
  "base.css",
  "busy.js",
  "busy-words.js",
  // den-ui 0.6.1: the working pop-up's look, linked (no injected <style>).
  "busy.css",
  "dialog.js",
  // den-ui 0.6.2: the dialogs' look, linked (no injected <style>).
  "dialog.css",
  // issue 206: date-times in the person's own zone.
  "time.js",
  // The shared update pill: a new version of Den, Reload.
  "update-pill.js",
  "update-pill.css",
  // Issue 95 (UI kit slice 1): the global shell (top bar, rail, pins,
  // collapse, ☰ drawer), the version chip, What's new, the Report form
  // and the kit's words, and the client entry (window.DenUI).
  "strings.js",
  "icons.js",
  "shell-html.js",
  "shell-client.js",
  "shell.css",
  "version.js",
  "whatsnew.js",
  "whatsnew.css",
  "report.js",
  "report.css",
  "report-shot.js",
  "kit.js",
  "fonts/rubik-latin-400-normal.woff2",
  "fonts/rubik-latin-ext-400-normal.woff2",
  "fonts/rubik-latin-500-normal.woff2",
  "fonts/rubik-latin-ext-500-normal.woff2",
  "fonts/space-mono-latin-400-normal.woff2",
  "fonts/space-mono-latin-ext-400-normal.woff2",
  // den-ui 0.7.0: the default theme's mark, for a host's brand
  // (markHtml({ src: "/kit/marks/den.svg", label })).
  "marks/den.svg",
];

/** The kit's file for a /kit/ path, or null. */
export function kitAssetFile(
  pathname: string,
  engineRoot: string = getEngineRoot(),
): string | null {
  if (!pathname.startsWith("/kit/")) return null;
  const rel = pathname.slice("/kit/".length);
  if (!KIT_FILES.includes(rel)) return null;
  const file = path.join(engineRoot, "packages", "den-ui", "src", rel);
  return fs.existsSync(file) ? file : null;
}

/**
 * Issue 95: the kit's shell for Den's classic shell.js. shell.js runs where
 * it stands (a classic script: the frame is in the DOM before the page's
 * own scripts look for it), so it can't import an ES module. Den serves the
 * kit's own files, unchanged but for their import and export words, as one
 * classic script that sets window.DenUIShell; shell.js draws the frame
 * with it. One markup source: the kit's shell-html.js.
 */
export const KIT_SHELL_SCRIPT = "/den-ui-shell.js";
const KIT_SHELL_PARTS = [
  "strings.js",
  "icons.js",
  "shell-html.js",
  "shell-client.js",
];
/**
 * den-ui 0.7.0: shell-client.js imports focusBack from dialog.js. dialog.js
 * has names of its own (esc, open) that would clash in one scope, so it
 * goes first in a scope of its own, giving only what shell-client needs.
 */
const KIT_SHELL_SCOPED: ReadonlyArray<{ file: string; names: string[] }> = [
  { file: "dialog.js", names: ["openerOf", "focusBack"] },
];
const KIT_SHELL_NAMES = [
  "shellHtml",
  "topBarHtml",
  "markHtml",
  "railHtml",
  "railGroupHtml",
  "navItemHtml",
  "versionChipHtml",
  "reportButtonHtml",
  "hydrateShell",
  "syncPinToggles",
  "icon",
  "esc",
  "kitT",
  "addStrings",
  "setProduct",
  // den-ui 0.7.0: the scope crumbs, the search, the bell, the account
  // entry, Settings, ◐ ▾ and the update-waiting pill.
  "scopeHtml",
  "scopeCrumbHtml",
  "searchHtml",
  "bellButtonHtml",
  "bellPanelHtml",
  "bellCount",
  "accountHtml",
  "accountMenuHtml",
  "menuHasFilter",
  "menuFilterParts",
  "settingsHtml",
  "appearanceButtonHtml",
  "appearanceMenuHtml",
  "waitingHtml",
  "hydrateScope",
  "hydrateSearch",
  "hydrateBell",
  "hydrateAccount",
  "attachMenuFilter",
  "hydrateAppearance",
  "setWaiting",
];

/**
 * A module's block comments left out: only a comment on lines of its own
 * (nothing before its opening, nothing after its close).
 */
export function stripBlockComments(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // A comment opening a line, closing on a line with nothing after it.
    if (/^\s*\/\*/.test(lines[i]!)) {
      let j = i;
      let close = lines[j]!.indexOf("*/", lines[j]!.indexOf("/*") + 2);
      while (close < 0 && j + 1 < lines.length) {
        j++;
        close = lines[j]!.indexOf("*/");
      }
      if (close >= 0 && lines[j]!.slice(close + 2).trim() === "") {
        i = j;
        continue;
      }
    }
    out.push(lines[i]!);
  }
  return out.join("\n");
}

/** The kit's names /den-ui-shell.js gives window.DenUIShell. */
export const KIT_SHELL_EXPORTS: readonly string[] = KIT_SHELL_NAMES;

/** The classic script of the kit's shell (KIT_SHELL_SCRIPT), or null. */
export function kitShellScript(
  engineRoot: string = getEngineRoot(),
): string | null {
  const dir = path.join(engineRoot, "packages", "den-ui", "src");
  const parts: string[] = [];
  for (const { file: f, names } of KIT_SHELL_SCOPED) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) return null;
    parts.push(
      `// ── den-ui ${f} (its own scope) ──\n` +
        `const { ${names.join(", ")} } = (function () {\n` +
        // Its comments stay in the kit: they name files (dialog.css) a
        // page links itself, which this script never loads.
        stripBlockComments(fs.readFileSync(file, "utf-8"))
          .replace(/^import\s+[^;]+;\s*$/gm, "")
          .replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, "") +
        `\nreturn { ${names.join(", ")} };\n})();`,
    );
  }
  for (const f of KIT_SHELL_PARTS) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) return null;
    parts.push(
      `// ── den-ui ${f} ──\n` +
        fs
          .readFileSync(file, "utf-8")
          // Its own imports are the parts above it; re-exports go.
          .replace(/^(import|export)\s*\{[^}]*\}\s*from\s*"[^"]+";\s*$/gm, "")
          .replace(/^import\s+[^;]+;\s*$/gm, "")
          .replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, ""),
    );
  }
  return (
    "(function () {\n" +
    parts.join("\n") +
    `\nwindow.DenUIShell = { ${KIT_SHELL_NAMES.join(", ")} };\n})();\n`
  );
}

/** The kit's stylesheets every page with the shell links, in this order. */
export const KIT_PAGE_CSS: readonly string[] = [
  "/kit/shell.css",
  "/kit/whatsnew.css",
  "/kit/report.css",
  // den-ui 0.6.1: the working pop-up's look, on the page from the start
  // (busy.js links it itself on a page without it).
  "/kit/busy.css",
  // den-ui 0.6.2: the ask-and-tell dialogs' look, likewise.
  "/kit/dialog.css",
];

/**
 * A page with the shell (its `<script src="/shell.js">`): the kit's
 * stylesheets at the end of its <head>, so they come after the page's own
 * styles, as the shell's did, and the kit's shell script just before
 * shell.js. A page without the shell comes back unchanged.
 */
export function kitPage(html: string): string {
  const shell = '<script src="/shell.js"></script>';
  if (!html.includes(shell)) return html;
  const links = KIT_PAGE_CSS.map(
    (href) => `<link rel="stylesheet" href="${href}" />`,
  ).join("");
  return html
    .replace("</head>", () => `${links}</head>`)
    .replace(
      shell,
      () => `<script src="${KIT_SHELL_SCRIPT}"></script>${shell}`,
    );
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
  if (pathname === KIT_SHELL_SCRIPT) {
    const js = kitShellScript();
    if (!js) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(js);
    return true;
  }
  if (pathname.startsWith("/kit/")) {
    const kit = kitAssetFile(pathname);
    if (!kit) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return true;
    }
    // The bytes change only with Den itself.
    const bytes = kit.endsWith(".woff2") || kit.endsWith(".svg");
    res.writeHead(200, {
      "Content-Type": kit.endsWith(".css")
        ? "text/css; charset=utf-8"
        : kit.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : kit.endsWith(".svg")
            ? "image/svg+xml"
            : "font/woff2",
      "Cache-Control": bytes ? "public, max-age=86400" : "no-cache",
    });
    // Issue 231: its own imports carry Den's version, as Den's scripts do.
    res.end(
      bytes
        ? fs.readFileSync(kit)
        : stampServed(kit, fs.readFileSync(kit, "utf-8")),
    );
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
