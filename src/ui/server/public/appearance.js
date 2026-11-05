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

/** The mode to draw in: yours, else the system's, else the theme's, else dark. */
export function effectiveMode(mode, system, defaultMode) {
  if (mode === "dark" || mode === "light") return mode;
  if (system === "dark" || system === "light") return system;
  return defaultMode === "light" ? "light" : "dark";
}

/**
 * What the header's mark is, for the active theme's `mark` (from
 * /api/themes) in a mode: its SVG (the dark variant in dark mode, if it has
 * one), else text Den draws in the mark's shape, else the theme name's
 * first letter. Pure, for tests.
 */
export function markView(mark, mode, themeName) {
  const m = mark || {};
  if (m.svg)
    return {
      kind: "svg",
      src: mode === "dark" && m.svg_dark ? m.svg_dark : m.svg,
    };
  const text = (m.text || (themeName || "").trim().charAt(0) || "·").slice(
    0,
    3,
  );
  const shape = ["square", "rounded", "circle"].includes(m.shape)
    ? m.shape
    : "rounded";
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
  const usable = (themes || []).filter((t) => t.ok);
  const chosen = usable.some((t) => t.id === prefsTheme) ? prefsTheme : null;
  return [
    {
      value: "",
      label: `Org default (${orgDefault?.name || "Den"})`,
      selected: !prefsTheme,
    },
    ...usable.map((t) => ({
      value: t.id,
      label:
        t.id === chosen && t.id === orgDefault?.id
          ? `${t.name} (pinned)`
          : t.name,
      selected: t.id === chosen,
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
  const t = (themes || []).find((x) => x.id === prefsTheme);
  if (t?.ok) return null;
  const inUse = active?.name || active?.id || "Den";
  if (!t)
    return `Your theme ${prefsTheme} isn't installed, so ${inUse} is in use`;
  const first = String(t.problem || "")
    .split("; ")[0]
    .trim();
  return `Your theme ${prefsTheme} isn't valid${first ? ` (${first})` : ""}, so ${inUse} is in use`;
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

function applyMode() {
  document.documentElement.dataset.mode = currentMode();
  renderMark();
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
  if (v.kind === "svg") {
    const img = document.createElement("img");
    img.src = v.src;
    img.alt = "";
    img.width = 18;
    img.height = 18;
    host.className = "den-mark den-mark-svg";
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
  return {
    label: "Appearance",
    items: [
      { heading: "Appearance" },
      ...MODES.map(([v, l]) => ({
        label: l,
        checked: st.mode === v,
        onSelect: () => setMode(v),
      })),
      { hr: true },
      { heading: "Theme" },
      ...opts.map((o) => ({
        label: o.label,
        checked: o.selected,
        onSelect: () => (o.selected ? null : setTheme(o.value)),
      })),
      ...(notice ? [{ note: notice }] : []),
      // Language (R19) comes in dev.23: its slot, hidden until then.
      { slot: "lang", hidden: true },
      { hr: true },
      { label: "All settings", href: settings },
    ],
  };
}

const MODES = [
  ["system", "System"],
  ["dark", "Dark"],
  ["light", "Light"],
];

/**
 * The palette's Appearance and Theme rows (R17), registered with the
 * shell's COMMANDS (again after each change: the theme list can change).
 */
function registerCommands() {
  const sh = window.denShell;
  if (!sh?.registerCommand) return;
  for (const [v, l] of MODES)
    sh.registerCommand({
      id: `appearance-${v}`,
      label: `Appearance: ${l}`,
      keywords: ["mode", "appearance", "theme", v],
      kind: "action",
      run: () => setMode(v),
    });
  for (const c of sh.commands?.() ?? [])
    if (c.id.startsWith("theme-")) sh.unregisterCommand(c.id);
  for (const o of themeOptions(st.themes, st.prefsTheme, st.orgDefault))
    sh.registerCommand({
      id: `theme-${o.value || "org-default"}`,
      label: `Theme: ${o.label}`,
      keywords: ["theme", "brand", "colors", o.value],
      kind: "action",
      run: () => setTheme(o.value),
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
  btn.title = "Appearance and theme";
  btn.setAttribute("aria-label", "Appearance");
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
