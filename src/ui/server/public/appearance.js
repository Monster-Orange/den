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
    /* The top bar never pushes the appearance control off-screen: it sits
       at the far right and never shrinks; the health dots give way first
       (the pages are in the shell's rail, shell.js). */
    header, .topbar { min-width: 0; }
    /* The health row takes the header's free space (never its content's
       width, so laying it out can't resize it); nav and ◐ keep theirs. */
    header > .health, .topbar > .health { min-width: 0; flex: 1 1 0; overflow: hidden; }
    /* A page's own spacer would split that free space with the row. */
    header:has(> .health) > .h-spacer, header:has(> .health) > .spacer,
    .topbar:has(> .health) > .h-spacer, .topbar:has(> .health) > .spacer {
      flex: 0 0 0 !important; min-width: 0;
    }
    /* The row never squeezes the brand, the version badge or the pills
       beside it: only the row (and the scrolling nav) gives way. */
    header:has(> .health) > :not(.health):not(nav):not(.h-spacer):not(.spacer),
    .topbar:has(> .health) > :not(.health):not(nav):not(.h-spacer):not(.spacer) {
      flex-shrink: 0; min-width: max-content;
    }
    header > .health, .topbar > .health { flex-wrap: nowrap; }
    header > .health > *, .topbar > .health > * { flex-shrink: 0; white-space: nowrap; }
    /* ⟳ is a control and is never clipped: when even the compact chip
       doesn't fit, the chip's text gives way, not the button after it. */
    header > .health > .health-more, .topbar > .health > .health-more {
      flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    }
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
    .appearance-notice {
      grid-column: 1 / -1; margin: 0; max-width: 260px; white-space: normal;
      color: var(--text); font-size: 11.5px; line-height: 1.35;
    }
    .appearance-notice[hidden] { display: none; }
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
  const opts = themeOptions(st.themes, st.prefsTheme, st.orgDefault);
  theme.replaceChildren(
    ...opts.map((o) => option(o.value, o.label, o.selected)),
  );
  // A stored choice that isn't usable: select nothing, and say why.
  if (!opts.some((o) => o.selected)) theme.selectedIndex = -1;
  const notice = document.getElementById("appearance-theme-notice");
  if (notice) {
    const text = themeNotice(st.themes, st.prefsTheme, st.active);
    notice.textContent = text || "";
    notice.hidden = !text;
  }
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
  // Says when your stored theme isn't in use, and why (themeNotice).
  const notice = document.createElement("p");
  notice.id = "appearance-theme-notice";
  notice.className = "appearance-notice";
  notice.setAttribute("role", "status");
  theme.setAttribute("aria-describedby", notice.id);
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
  pop.append(label("Mode", mode), mode, label("Theme", theme), theme, notice);
  box.append(btn, pop);
  fillThemeSelect(theme);
}

/** The bar the control goes in: the shell's top bar (shell.js). */
function headerHost() {
  return (
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
  const host = headerHost();
  if (!host) return;
  render(host);
}
