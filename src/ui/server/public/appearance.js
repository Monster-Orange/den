/**
 * Appearance: the header's mode (System / Dark / Light) and theme controls,
 * and the active theme's mark at the start of the header.
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
 * then every usable theme. Selected: the org default when you have no
 * choice of your own, else your theme. Pure, for tests.
 */
export function themeOptions(themes, prefsTheme, orgDefault, activeId) {
  const chosen = prefsTheme || null;
  const out = [
    {
      value: "",
      label: `Org default (${orgDefault?.name || "Den"})`,
      selected: !chosen,
    },
  ];
  for (const t of themes || [])
    if (t.ok || t.id === activeId || t.id === chosen)
      out.push({ value: t.id, label: t.name, selected: t.id === chosen });
  return out;
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
    /* The header never pushes the appearance control off-screen: it sits at
       the far right and never shrinks; the nav shrinks and scrolls instead,
       and the health dots give way first. */
    header, .topbar { min-width: 0; }
    header > nav, .topbar > nav {
      min-width: 0; flex: 0 1 auto; flex-wrap: nowrap; overflow-x: auto;
      scrollbar-width: none;
    }
    header > nav::-webkit-scrollbar, .topbar > nav::-webkit-scrollbar { display: none; }
    header > nav a, .topbar > nav a { white-space: nowrap; flex-shrink: 0; }
    header > .health, .topbar > .health { min-width: 0; flex: 0 100 auto; overflow: hidden; }
    header > .health, .topbar > .health { flex-wrap: nowrap; }
    header > .health > *, .topbar > .health > * { flex-shrink: 0; white-space: nowrap; }
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
    .appearance { position: relative; flex-shrink: 0; margin-left: 8px; }
    .appearance-btn {
      font: 13px var(--mono); line-height: 1; color: var(--muted); background: none;
      border: 1px solid var(--border); border-radius: var(--radius-button, 4px);
      padding: 3px 6px; cursor: pointer;
    }
    .appearance-btn:hover, .appearance-btn[aria-expanded="true"] { color: var(--text); border-color: var(--border-strong); }
    .appearance-pop {
      position: absolute; right: 0; top: calc(100% + 6px); z-index: 1500; width: max-content;
      display: grid; grid-template-columns: auto auto; gap: 8px 10px; align-items: center;
      padding: 10px 12px; background: var(--raised); border: 1px solid var(--border-strong);
      border-radius: var(--radius, 8px); box-shadow: var(--shadow);
      font-size: 12px; color: var(--muted); white-space: nowrap;
    }
    .appearance-pop[hidden] { display: none; }
    .appearance-pop select {
      font: 12px var(--sans); color: var(--text); background: var(--surface);
      border: 1px solid var(--border-strong); border-radius: var(--radius-button, 4px);
      padding: 3px 4px; cursor: pointer; min-width: 120px;
    }
    .appearance :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  `;
  document.head.appendChild(s);
}

function option(value, label, selected) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  o.selected = selected;
  return o;
}

function fillThemeSelect(theme) {
  theme.replaceChildren(
    ...themeOptions(st.themes, st.prefsTheme, st.orgDefault, st.active?.id).map(
      (o) => option(o.value, o.label, o.selected),
    ),
  );
}

function render(host) {
  let box = document.getElementById("appearance");
  if (!box) {
    box = document.createElement("span");
    box.id = "appearance";
    box.className = "appearance";
    host.appendChild(box);
  }
  box.replaceChildren();
  // One small button at the header's far right; the two menus open below it.
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "appearance-btn";
  btn.textContent = "◐";
  btn.title = "Appearance: mode and theme";
  btn.setAttribute("aria-label", "Appearance");
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "appearance-pop");
  const pop = document.createElement("div");
  pop.id = "appearance-pop";
  pop.className = "appearance-pop";
  pop.setAttribute("role", "group");
  pop.setAttribute("aria-label", "Appearance");
  pop.hidden = true;
  const toggle = (open) => {
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggle(pop.hidden);
  });
  document.addEventListener("click", (e) => {
    if (!box.contains(e.target)) toggle(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) {
      toggle(false);
      btn.focus();
    }
  });
  // Each select is named by its own label (and aria-label, for readers that
  // do not follow <label for> into a popover).
  const label = (text, control) => {
    const l = document.createElement("label");
    l.textContent = text;
    l.htmlFor = control.id;
    control.setAttribute("aria-label", text);
    return l;
  };
  const mode = document.createElement("select");
  mode.id = "appearance-mode";
  for (const [v, l] of [
    ["system", "System"],
    ["dark", "Dark"],
    ["light", "Light"],
  ])
    mode.appendChild(option(v, l, st.mode === v));
  mode.addEventListener("change", async () => {
    const prev = st.mode;
    st.mode = mode.value;
    applyMode();
    try {
      await save({ mode: st.mode });
    } catch {
      st.mode = prev;
      mode.value = prev;
      applyMode();
    }
  });
  const theme = document.createElement("select");
  theme.id = "appearance-theme";
  fillThemeSelect(theme);
  theme.addEventListener("change", async () => {
    try {
      // "" is the org default: no choice of your own.
      await save({ theme: theme.value || null });
      await loadThemes();
      applyMode();
      reloadThemeCss();
    } catch {
      /* keep what was there */
    }
    fillThemeSelect(theme);
  });
  pop.append(label("Mode", mode), mode, label("Theme", theme), theme);
  box.append(btn, pop);
}

/** The header the control goes in: <header>, or the Tests page's top bar. */
function headerHost() {
  return document.querySelector("header") || document.querySelector(".topbar");
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
  const host = headerHost();
  if (!host) return;
  render(host);
}
