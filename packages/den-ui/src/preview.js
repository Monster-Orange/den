/**
 * den-ui: a preview of a page or a component (issue 789), drawn in a
 * sandboxed frame at a chosen width and theme. Framework-free.
 *
 *   previewHtml({ html, theme, mode, kitBase, origin, title }) → string
 *     the frame's whole document (its srcdoc): the kit's tokens.css and
 *     base.css, the theme's stylesheet (themes/<theme>.css, e.g. "sketch";
 *     none: the kit's own look), html in the body, and preview-frame.js,
 *     which lets the host switch the theme and mode with no reload.
 *
 *   mountPreview(el, { html, width, height, theme, mode, kitBase, title, fit })
 *     → { frame, setWidth(w), setTheme(theme, mode), destroy() }
 *     The frame is `sandbox="allow-scripts"`: an opaque origin, so the
 *     previewed page's scripts run but can't reach the host page's DOM,
 *     cookies or storage, submit forms, open pop-ups or navigate the top.
 *     width is the page's own width (390, 768 or 1440 are Hub's frames;
 *     any 240-2560 works). fit (default true) scales it down to the
 *     element's width, never up, as Hub's mock pages do; the page scrolls
 *     inside its frame at `height` (default 800).
 *
 * kitBase is where the kit is served: "/kit/" in Den (the default),
 * "/static/den-ui/" in Hub. The theme and kitBase are checked (a slug; a
 * path), never put in the page unchecked.
 */

export const PREVIEW_SANDBOX = "allow-scripts";
export const PREVIEW_WIDTHS = Object.freeze([390, 768, 1440]);

const THEME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODES = new Set(["light", "dark"]);

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** A theme slug, or null (the kit's own look). Anything else throws. */
export function previewTheme(theme) {
  if (theme == null || theme === "") return null;
  if (typeof theme !== "string" || !THEME_RE.test(theme))
    throw new TypeError(`preview: not a theme name: ${String(theme)}`);
  return theme;
}

function modeOf(mode) {
  if (mode == null) return "light";
  if (!MODES.has(mode))
    throw new TypeError(`preview: mode is light or dark, not ${mode}`);
  return mode;
}

function baseOf(kitBase) {
  const b = kitBase ?? "/kit/";
  // A same-site path: never "//host/" (another site) and never "..".
  if (
    typeof b !== "string" ||
    !/^\/[\w./-]*\/$/.test(b) ||
    b.includes("..") ||
    b.includes("//")
  )
    throw new TypeError(`preview: kitBase is a path like /kit/, not ${b}`);
  return b;
}

/** The host's origin (scheme://host[:port]), for the frame's CSP. */
function originOf(origin) {
  if (origin == null) {
    const here = typeof location === "object" ? location.origin : "";
    return /^https?:\/\/[^/\s]+$/.test(here) ? here : null;
  }
  if (
    typeof origin !== "string" ||
    !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(origin)
  )
    throw new TypeError(`preview: origin is like https://host, not ${origin}`);
  return origin;
}

/**
 * The frame's CSP: only the kit's own files (at origin + kitBase) load, and
 * nothing calls out (connect-src, form-action). Not escaped: origin and
 * kitBase are checked to URL characters, with no quote. The page's own inline
 * scripts and styles still run. Path-only sources aren't valid CSP and
 * 'self' never matches an opaque origin, so the host's origin is named.
 */
function cspOf(origin, base) {
  const kit = origin ? `${origin}${base}` : "'none'";
  return [
    "default-src 'none'",
    `style-src ${kit} 'unsafe-inline'`,
    `script-src ${kit} 'unsafe-inline'`,
    `img-src data: ${origin ? kit : ""}`.trim(),
    `font-src ${kit}`,
    "connect-src 'none'",
    "form-action 'none'",
  ].join("; ");
}

function widthOf(width) {
  const w = Number(width ?? 1440);
  if (!Number.isFinite(w) || w < 240 || w > 2560)
    throw new RangeError(`preview: width is 240 to 2560, not ${width}`);
  return Math.round(w);
}

/** The frame's whole document (see the top of this file). */
export function previewHtml(opts = {}) {
  const base = baseOf(opts.kitBase);
  const theme = previewTheme(opts.theme);
  const mode = modeOf(opts.mode);
  const origin = originOf(opts.origin);
  const themeLink = theme
    ? `<link rel="stylesheet" id="den-pv-theme" href="${esc(`${base}themes/${theme}.css`)}">`
    : `<link rel="stylesheet" id="den-pv-theme" disabled>`;
  return (
    `<!doctype html><html lang="${esc(opts.lang ?? "en")}" data-mode="${mode}">` +
    `<head><meta http-equiv="Content-Security-Policy" content="${cspOf(origin, base)}">` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(opts.title ?? "Preview")}</title>` +
    `<link rel="stylesheet" href="${esc(`${base}tokens.css`)}">` +
    `<link rel="stylesheet" href="${esc(`${base}base.css`)}">` +
    themeLink +
    `<script src="${esc(`${base}preview-frame.js`)}" data-base="${esc(base)}"></script>` +
    `</head><body>${opts.html ?? ""}</body></html>`
  );
}

/** Draw a preview into `el` (see the top of this file). */
export function mountPreview(el, opts = {}) {
  const s = {
    html: opts.html ?? "",
    width: widthOf(opts.width),
    height: Math.max(120, Math.round(Number(opts.height ?? 800)) || 800),
    theme: previewTheme(opts.theme),
    mode: modeOf(opts.mode),
    kitBase: baseOf(opts.kitBase),
    origin: originOf(opts.origin),
    title: opts.title ?? "Preview",
    lang: opts.lang ?? "en",
    fit: opts.fit !== false,
  };
  const box = document.createElement("div");
  box.className = "den-pv";
  box.dataset.denPreview = "";
  Object.assign(box.style, { overflow: "hidden", position: "relative" });
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", PREVIEW_SANDBOX);
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", s.title);
  Object.assign(frame.style, {
    border: "0",
    display: "block",
    transformOrigin: "0 0",
  });
  let loaded = false;
  frame.addEventListener("load", () => {
    loaded = true;
  });
  frame.srcdoc = previewHtml(s);
  box.append(frame);
  el.append(box);

  const fit = () => {
    const avail = el.clientWidth || s.width;
    const k = s.fit ? Math.min(1, avail / s.width) : 1;
    frame.style.width = `${s.width}px`;
    frame.style.height = `${s.height}px`;
    frame.style.transform = k === 1 ? "" : `scale(${k})`;
    box.style.width = `${Math.round(s.width * k)}px`;
    box.style.height = `${Math.round(s.height * k)}px`;
    box.dataset.width = String(s.width);
    box.dataset.scale = String(Math.round(k * 1000) / 1000);
  };
  fit();
  const ro =
    typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
  ro?.observe(el);

  return {
    frame,
    /** The page's own width; the frame is scaled to fit again. */
    setWidth(width) {
      s.width = widthOf(width);
      fit();
    },
    /** Another theme (or null) and mode, with no reload. */
    setTheme(theme, mode) {
      s.theme = previewTheme(theme);
      if (mode !== undefined) s.mode = modeOf(mode);
      box.dataset.theme = s.theme ?? "";
      if (!loaded) {
        frame.srcdoc = previewHtml(s);
        return;
      }
      // An opaque origin has no name to send to: "*" is the only target.
      // The message is a theme slug and a mode, nothing private.
      frame.contentWindow?.postMessage(
        { denPreview: { theme: s.theme, mode: s.mode } },
        "*",
      );
    },
    destroy() {
      ro?.disconnect();
      box.remove();
    },
  };
}
