/**
 * Appearance: the header's mode (System / Dark / Light) and theme controls.
 *
 * A choice is saved to /api/settings (`appearance`, user.yml) and applied
 * without a reload: data-mode on <html>, and /theme.css swapped for a fresh
 * copy (the server renders the theme the settings now name). Nothing else
 * changes: no edge, no services, no restart. Each page's inline pre-paint
 * script sets the first data-mode the same way effectiveMode does.
 */

/** The mode to draw in: yours, else the system's, else the theme's, else dark. */
export function effectiveMode(mode, system, defaultMode) {
  if (mode === "dark" || mode === "light") return mode;
  if (system === "dark" || system === "light") return system;
  return defaultMode === "light" ? "light" : "dark";
}

const st = { mode: "system", defaultMode: "dark", themes: [], active: null };

function systemMode() {
  const q = (s) =>
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia(`(prefers-color-scheme: ${s})`).matches;
  return q("light") ? "light" : q("dark") ? "dark" : null;
}

function applyMode() {
  document.documentElement.dataset.mode = effectiveMode(
    st.mode,
    systemMode(),
    st.defaultMode,
  );
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
    .appearance { position: relative; flex-shrink: 0; margin-left: 8px; }
    .appearance-btn {
      font: 13px var(--mono); line-height: 1; color: var(--muted); background: none;
      border: 1px solid var(--border); border-radius: var(--radius-button, 4px);
      padding: 3px 6px; cursor: pointer;
    }
    .appearance-btn:hover, .appearance-btn[aria-expanded="true"] { color: var(--text); border-color: var(--border-strong); }
    .appearance-pop {
      position: absolute; right: 0; top: calc(100% + 6px); z-index: 1500;
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

function render(host) {
  let box = document.getElementById("appearance");
  if (!box) {
    box = document.createElement("span");
    box.id = "appearance";
    box.className = "appearance";
    host.appendChild(box);
  }
  box.replaceChildren();
  // One small button in the header (it is full at 1024px); the two menus
  // open below it.
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "appearance-btn";
  btn.textContent = "◐";
  btn.title = "Appearance: mode and theme";
  btn.setAttribute("aria-label", "Appearance");
  btn.setAttribute("aria-haspopup", "true");
  btn.setAttribute("aria-expanded", "false");
  const pop = document.createElement("div");
  pop.className = "appearance-pop";
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
  const label = (text, control) => {
    const l = document.createElement("label");
    l.textContent = text;
    l.htmlFor = control.id;
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
  for (const t of st.themes)
    if (t.ok || t.id === st.active?.id)
      theme.appendChild(option(t.id, t.name, t.id === st.active?.id));
  theme.addEventListener("change", async () => {
    try {
      await save({ theme: theme.value });
      await loadThemes();
      applyMode();
      reloadThemeCss();
    } catch {
      theme.value = st.active?.id ?? "den";
    }
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
  applyMode();
  const host = headerHost();
  if (!host) return;
  injectStyles();
  render(host);
}
