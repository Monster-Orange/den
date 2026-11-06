/**
 * Appearance: the user menu (R10, ◐ ▾ at the end of the top bar: a .pop
 * menu with Appearance (System / Dark / Light), Theme (the installed
 * themes), a hidden Language slot (dev.23) and All settings), the same
 * choices as ⌘K palette commands (R17), and the active theme's mark at the
 * start of the header.
 *
 * A choice is saved to /api/settings (`appearance`, user.yml) and applied
 * without a reload: data-mode on <html>, /theme.css swapped for a fresh
 * copy (the server renders the theme the settings now name), and the mark
 * redrawn. Nothing else changes: no edge, no services, no restart. Each
 * page's inline pre-paint script sets the first data-mode the same way
 * effectiveMode does.
 *
 * The Theme menu's first entry is "Org default (<name>)": no choice of your
 * own (appearance.theme null), so you follow the org config's brand.theme.
 * Picking the theme that is the org default stores null too (the server
 * does that), so you keep following it.
 *
 * The Settings page (R21) drives the same prefs through setAppearance; any
 * change, from either, fires `den:appearance` on window and both repaint.
 */

/**
 * The en strings of this module's pure exports, for where there is no
 * shell (a unit test). In a page every lookup is the shell's t (R19), whose
 * en is the same text (i18n.test.ts holds them equal).
 */
export const EN_FALLBACK = {
  "um.label": "Appearance",
  "um.title": "Appearance and theme",
  "um.appearance": "Appearance",
  "um.system": "System",
  "um.dark": "Dark",
  "um.light": "Light",
  "um.theme": "Theme",
  "um.language": "Language",
  "um.all": "All settings",
  "cmd.appearance": "Appearance: {mode}",
  "cmd.theme": "Theme: {name}",
  "cmd.language": "Language: {name}",
  "theme.orgDefault": "Org default ({name})",
  "theme.pinned": "{name} (pinned)",
  "theme.notInstalled": "Your theme {id} isn't installed, so {inUse} is in use",
  "theme.invalid": "Your theme {id} isn't valid ({why}), so {inUse} is in use",
  "theme.invalidBare": "Your theme {id} isn't valid, so {inUse} is in use",
};
function t(key, vars) {
  const sh = typeof window !== "undefined" ? window.denShell : null;
  if (sh?.t) return sh.t(key, vars);
  return String(EN_FALLBACK[key] ?? key).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}

/** The mode to draw in: yours, else the system's, else the theme's, else dark. */
export function effectiveMode(mode, system, defaultMode) {
  if (mode === "dark" || mode === "light") return mode;
  if (system === "dark" || system === "light") return system;
  return defaultMode === "light" ? "light" : "dark";
}

/**
 * What the header's mark is, for the active theme's `mark` (from
 * /api/themes) in a mode: its SVG (the dark variant in dark mode, if it has
 * one), else its PNG or WebP the same way (a raster, drawn in the mark's
 * shape), else text Den draws in the mark's shape, else the theme name's
 * first letter. Pure, for tests.
 */
export function markView(mark, mode, themeName) {
  const m = mark || {};
  const shape = ["square", "rounded", "circle"].includes(m.shape)
    ? m.shape
    : "rounded";
  if (m.svg)
    return {
      kind: "svg",
      src: mode === "dark" && m.svg_dark ? m.svg_dark : m.svg,
    };
  for (const k of ["png", "webp"])
    if (m[k])
      return {
        kind: "raster",
        src: mode === "dark" && m[`${k}_dark`] ? m[`${k}_dark`] : m[k],
        shape,
      };
  const text = (m.text || (themeName || "").trim().charAt(0) || "·").slice(
    0,
    3,
  );
  return { kind: "text", text, shape };
}

/**
 * The Theme menu: "Org default (<name>)" first (value "", stored as null),
 * then every theme that passes validate. Selected: the org default when you
 * have no choice of your own, else your theme, even when it is the org's
 * theme: picking it by name pins it, and it reads "<name> (pinned)" so the
 * menu tells a pin from following the org. A stored choice that is no
 * longer usable is never offered, and nothing is selected: themeNotice says
 * what happened instead, so it never reads as "Org default". Pure, for tests.
 */
export function themeOptions(themes, prefsTheme, orgDefault) {
  const usable = (themes || []).filter((th) => th.ok);
  const chosen = usable.some((th) => th.id === prefsTheme) ? prefsTheme : null;
  return [
    {
      value: "",
      label: t("theme.orgDefault", { name: orgDefault?.name || "Den" }),
      selected: !prefsTheme,
    },
    ...usable.map((th) => ({
      value: th.id,
      label:
        th.id === chosen && th.id === orgDefault?.id
          ? t("theme.pinned", { name: th.name })
          : th.name,
      selected: th.id === chosen,
    })),
  ];
}

/**
 * One line for the menu when your stored theme isn't usable: "Your theme
 * <id> isn't valid (<first problem>), so <name> is in use", from
 * /api/themes' ok:false entry; null when your choice is fine or you have
 * none. Pure, for tests.
 */
export function themeNotice(themes, prefsTheme, active) {
  if (!prefsTheme) return null;
  const th = (themes || []).find((x) => x.id === prefsTheme);
  if (th?.ok) return null;
  const inUse = active?.name || active?.id || "Den";
  if (!th) return t("theme.notInstalled", { id: prefsTheme, inUse });
  // The validator's problem is output: it is quoted, not translated.
  const first = String(th.problem || "")
    .split("; ")[0]
    .trim();
  return first
    ? t("theme.invalid", { id: prefsTheme, why: first, inUse })
    : t("theme.invalidBare", { id: prefsTheme, inUse });
}

const st = {
  mode: "system",
  defaultMode: "dark",
  themes: [],
  active: null,
  prefsTheme: null,
  orgDefault: null,
};

function systemMode() {
  const q = (s) =>
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia(`(prefers-color-scheme: ${s})`).matches;
  return q("light") ? "light" : q("dark") ? "dark" : null;
}

function currentMode() {
  return effectiveMode(st.mode, systemMode(), st.defaultMode);
}

/**
 * The browser-tab icon for the active theme in a mode: the URL the server
 * gave for that mode (it carries the theme, its version, the mode and a
 * hash of the file, so every switch is a new URL), else null. Pure, for
 * tests.
 */
export function faviconHref(active, mode) {
  const f = active?.favicon;
  if (!f) return null;
  return (mode === "dark" ? f.dark : f.light) || f.light || null;
}

function applyMode() {
  document.documentElement.dataset.mode = currentMode();
  renderMark();
  const href = faviconHref(st.active, currentMode());
  if (href) window.denShell?.setFavicon?.(href);
}

/** Draw the active theme's mark into #den-mark (each page has one). */
function renderMark() {
  const host = document.getElementById("den-mark");
  if (!host || !st.active) return;
  const v = markView(st.active.mark, currentMode(), st.active.name);
  const key = JSON.stringify(v);
  if (host.dataset.mark === key) return;
  host.dataset.mark = key;
  host.title = st.active.name || "";
  if (v.kind === "svg" || v.kind === "raster") {
    const img = document.createElement("img");
    img.src = v.src;
    img.alt = "";
    img.width = 18;
    img.height = 18;
    // A raster is a rectangle: the mark's shape clips it.
    host.className =
      v.kind === "svg"
        ? "den-mark den-mark-svg"
        : `den-mark den-mark-raster den-mark-${v.shape}`;
    host.replaceChildren(img);
  } else {
    host.className = `den-mark den-mark-text den-mark-${v.shape}`;
    host.dataset.len = String(v.text.length);
    host.textContent = v.text;
  }
}

/** Load /theme.css again; drop the old sheet once the new one has loaded. */
function reloadThemeCss() {
  const old = document.getElementById("theme-css");
  const next = document.createElement("link");
  next.rel = "stylesheet";
  next.href = `/theme.css?t=${Date.now()}`;
  const done = () => {
    old?.remove();
    next.id = "theme-css";
    // The new tokens are in: swatches and the like re-read them.
    changed("css");
  };
  next.onload = done;
  next.onerror = done;
  if (old) old.after(next);
  else document.head.appendChild(next);
}

async function loadThemes() {
  const r = await fetch("/api/themes");
  if (!r.ok) throw new Error(`/api/themes: ${r.status}`);
  const data = await r.json();
  st.themes = data.themes || [];
  st.active = data.active || null;
  st.orgDefault = data.org_default || null;
  st.prefsTheme = data.prefs?.theme || null;
  st.mode = data.prefs?.mode || "system";
  st.defaultMode = data.active?.default_mode || "dark";
  return data;
}

/** A copy of what this module knows: themes, your prefs, the org default. */
export function appearanceState() {
  return {
    mode: st.mode,
    defaultMode: st.defaultMode,
    themes: st.themes.slice(),
    active: st.active,
    prefsTheme: st.prefsTheme,
    orgDefault: st.orgDefault,
    effectiveMode: currentMode(),
  };
}

function changed(what) {
  try {
    window.dispatchEvent(
      new CustomEvent("den:appearance", { detail: { what } }),
    );
  } catch {
    /* no CustomEvent */
  }
}

/** Load the themes and prefs if nothing has yet (the Settings page). */
export async function ensureAppearance() {
  if (!st.themes.length) await loadThemes();
  return appearanceState();
}

/**
 * Change mode and/or theme ({ mode?, theme? }; theme "" or null is the org
 * default), as the ◐ menu does: save to /api/settings `appearance`, apply
 * without a reload, repaint the menu, fire `den:appearance`. Throws when
 * the server refuses (nothing changes then).
 */
export async function setAppearance(patch) {
  const prev = st.mode;
  if (patch.mode !== undefined) {
    st.mode = patch.mode;
    applyMode();
  }
  try {
    await save(patch);
  } catch (err) {
    st.mode = prev;
    applyMode();
    syncMenu();
    changed("prefs");
    throw err;
  }
  if (patch.theme !== undefined) {
    await loadThemes();
    applyMode();
    reloadThemeCss();
  }
  syncMenu();
  changed("prefs");
}

/**
 * Repaint after a change elsewhere: the user menu is drawn from the state
 * each time it opens, so only the palette's Theme rows need redoing.
 */
function syncMenu() {
  registerCommands();
}

async function save(patch) {
  // R26c: the shell's one client path (its error names the server's
  // message and request id); a page without the shell, a plain fetch.
  const api = typeof window !== "undefined" ? window.denShell?.api : null;
  if (api) {
    await api("POST", "/api/settings", { appearance: patch });
    return;
  }
  const r = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appearance: patch }),
  });
  if (!r.ok) throw new Error(await r.text());
}

function injectStyles() {
  if (document.getElementById("appearance-styles")) return;
  const s = document.createElement("style");
  s.id = "appearance-styles";
  s.textContent = `
    .den-mark {
      display: inline-flex; align-items: center; justify-content: center;
      width: 18px; height: 18px; flex-shrink: 0; overflow: hidden;
    }
    .den-mark img { display: block; width: 18px; height: 18px; }
    /* Scaled, never cropped: non-square art keeps its edges. */
    .den-mark-raster img { object-fit: contain; }
    .den-mark-text {
      font: 700 11px/1 var(--display); letter-spacing: -0.02em;
      background: var(--accent-fill); color: var(--on-accent);
    }
    .den-mark-text[data-len="2"] { font-size: 9px; }
    .den-mark-text[data-len="3"] { font-size: 7px; }
    .den-mark-square { border-radius: 2px; }
    .den-mark-rounded { border-radius: 5px; }
    .den-mark-circle { border-radius: 50%; }
  `;
  document.head.appendChild(s);
}

/** Switch the mode: drawn at once, then saved (reverted if the save fails). */
export async function setMode(mode) {
  const prev = st.mode;
  st.mode = mode;
  applyMode();
  registerCommands();
  try {
    await save({ mode });
  } catch {
    st.mode = prev;
    applyMode();
    registerCommands();
  }
  changed("prefs");
}

/** Switch the theme ("" or null: follow the org default), live. */
export async function setTheme(value) {
  try {
    await save({ theme: value || null });
    await loadThemes();
    applyMode();
    reloadThemeCss();
  } catch {
    /* keep what was there */
  }
  registerCommands();
  changed("prefs");
}

/** The user menu's model (shell.js openMenu's items). */
export function userMenu() {
  const opts = themeOptions(st.themes, st.prefsTheme, st.orgDefault);
  const notice = themeNotice(st.themes, st.prefsTheme, st.active);
  // "All settings": the Settings page, at Appearance (R10, R21).
  const settings = "/settings#appearance";
  const sh = window.denShell;
  const here = sh?.lang?.() ?? "en";
  return {
    label: t("um.label"),
    items: [
      { heading: t("um.appearance") },
      ...MODES.map(([v, key]) => ({
        label: t(key),
        checked: st.mode === v,
        onSelect: () => setMode(v),
      })),
      { hr: true },
      { heading: t("um.theme") },
      ...opts.map((o) => ({
        label: o.label,
        checked: o.selected,
        onSelect: () => (o.selected ? null : setTheme(o.value)),
      })),
      ...(notice ? [{ note: notice }] : []),
      // Language (R19, 0.3.0-dev.39): each named in itself; a pick saves
      // the pref and reloads the page in it.
      ...(sh?.languages
        ? [
            { hr: true },
            { heading: t("um.language") },
            ...sh.languages().map((l) => ({
              label: l.name,
              checked: l.id === here,
              onSelect: () => (l.id === here ? null : sh.setLanguage(l.id)),
            })),
          ]
        : []),
      { hr: true },
      { label: t("um.all"), href: settings },
    ],
  };
}

const MODES = [
  ["system", "um.system"],
  ["dark", "um.dark"],
  ["light", "um.light"],
];

/**
 * The palette's Appearance and Theme rows (R17), registered with the
 * shell's COMMANDS (again after each change: the theme list can change).
 */
function registerCommands() {
  const sh = window.denShell;
  if (!sh?.registerCommand) return;
  for (const [v, key] of MODES)
    sh.registerCommand({
      id: `appearance-${v}`,
      label: t("cmd.appearance", { mode: t(key) }),
      keywords: ["mode", "appearance", "theme", v],
      kind: "action",
      run: () => setMode(v),
    });
  for (const c of sh.commands?.() ?? [])
    if (c.id.startsWith("theme-") || c.id.startsWith("language-"))
      sh.unregisterCommand(c.id);
  for (const o of themeOptions(st.themes, st.prefsTheme, st.orgDefault))
    sh.registerCommand({
      id: `theme-${o.value || "org-default"}`,
      label: t("cmd.theme", { name: o.label }),
      keywords: ["theme", "brand", "colors", o.value],
      kind: "action",
      run: () => setTheme(o.value),
    });
  // Language (R19, R17): after Appearance and Theme, so the palette's first
  // rows stay as they were.
  for (const l of sh.languages?.() ?? [])
    sh.registerCommand({
      id: `language-${l.id}`,
      label: t("cmd.language", { name: l.name }),
      keywords: ["language", "lang", "locale", l.id, l.name],
      kind: "action",
      run: () => sh.setLanguage(l.id),
    });
}

function render(host) {
  let btn = document.getElementById("appearance-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "appearance-btn";
    btn.type = "button";
    host.appendChild(btn);
  }
  // The prototype's user menu (R10): ◐ ▾, an .ib with a .pop menu. Its
  // name is "Appearance"; the glyphs are hidden from readers.
  btn.className = "den-ib appearance-btn";
  const glyph = document.createElement("span");
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "◐ ▾";
  btn.replaceChildren(glyph);
  btn.title = t("um.title");
  btn.setAttribute("aria-label", t("um.label"));
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  if (btn.dataset.wired) return;
  btn.dataset.wired = "1";
  btn.addEventListener("click", () =>
    window.denShell?.openMenu?.(btn, userMenu()),
  );
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (btn.getAttribute("aria-expanded") !== "true")
      window.denShell?.openMenu?.(btn, userMenu());
  });
}

/** The bar the control goes in: the shell's user-menu slot (shell.js). */
function headerHost() {
  return (
    document.getElementById("den-user") ||
    document.querySelector(".den-top") ||
    document.querySelector("header") ||
    document.querySelector(".topbar")
  );
}

let inited = false;
/** Put the controls in the page header and follow the system's mode. */
export async function initAppearance() {
  if (inited || typeof document === "undefined") return;
  inited = true;
  // A refusal page (SEC-1b): /api/themes answers the refusal; the page
  // keeps its first paint.
  if (window.denShell?.apiOff?.() === true) return;
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  mq?.addEventListener?.("change", () => {
    if (st.mode === "system") applyMode();
  });
  try {
    await loadThemes();
  } catch {
    return; // no control without the server; the page keeps its first paint
  }
  injectStyles();
  applyMode();
  registerCommands();
  const host = headerHost();
  if (!host) return;
  render(host);
}
