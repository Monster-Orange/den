/**
 * den-ui shell, in the page: hydrates the markup shell-html.js drew (on
 * the server or in the page). It draws nothing of the frame itself; it
 * binds the rail's keys, the collapse toggle, pins' Delete, and the ☰
 * drawer, and repaints the rail when the product asks.
 *
 *   const shell = hydrateShell(root, opts)
 *     root  the element holding the shell (its .den-top and #den-rail)
 *     opts.lang          the kit's words' language
 *     opts.onCollapse(next)   the toggle was pressed: store it, then call
 *                        shell.setCollapsed(next) (or repaint)
 *     opts.onUnpin(id)   Delete on a pinned row: unpin it (and repaint);
 *                        focus moves to the next pinned row by itself
 *     opts.inert()       the elements made inert behind the open drawer
 *                        (default: the top bar and #den-content)
 *     opts.menuOpen()    true while a product menu is open: Escape is the
 *                        menu's then, not the drawer's
 *
 *   shell.rove()               one tab stop in the rail (current, else first)
 *   shell.paint(html, force)   the rail's new content, focus kept on the
 *                              same entry; false when it was the same
 *                              (force: paint it anyway)
 *   shell.setCollapsed(on)     body.den-rail-collapsed
 *   shell.openDrawer(), closeDrawer(refocus), drawerOpen()
 *   shell.unpin(id)            Delete's path: onUnpin, then focus
 *   syncPinToggles(root, isPinned, lang)   every [data-pin-toggle] in root:
 *                              ★ "Unpin x" pressed, or ☆ "Pin x"
 *
 * The drawer is the rail below 720px: a modal over the page. Focus moves
 * into the rail (the current entry); the top bar and the page are inert
 * behind a scrim; Escape or the scrim closes it and focus goes back to ☰;
 * Tab stays inside. Wider than that, it is a rail again.
 *
 * 0.7.0, the pieces a host puts in the slots (shell-html.js draws them):
 *
 *   hydrateScope(root, { onOpen(key, button) })   the crumbs' menus. A
 *       crumb with the kit's menu (links or HTML) opens it below its ▾:
 *       Enter, Space, ↓ or ↑ open it on an entry; ↑ ↓ Home End move; Esc
 *       or Tab closes it, Esc back on the ▾; a click outside closes it. A
 *       crumb whose menu is the host's (menu: true) calls onOpen.
 *       → { close(), isOpen() }
 *   hydrateSearch(button, { onActivate(via, event), keys? })   a click (or
 *       Enter) and ⌘K / Ctrl-K anywhere call onActivate ("click" or "key")
 *       and fire "den-ui:search" on the field. keys: false, no ⌘K.
 *       → { activate(via), destroy() }
 *   hydrateBell(button, opts)   the bell and its panel (a dialog on
 *       <body>). opts: items (a list, or a function of none) and title,
 *       empty, foot (a function giving HTML), or panel() giving the whole
 *       content (HTML, or bellPanelHtml's options); onOpen, onClose,
 *       onEscape(e) (true: the host took that Esc), id, lang. A click
 *       toggles it; Esc closes it and focus goes back to the bell (in
 *       Safari too); a click outside closes it. Opening focuses its first
 *       link or button.
 *       → { el, open(), close(focus), isOpen(), paint(), setCount(n) }
 *   hydrateAccount(root, { onAction(event) })   the account entry as an
 *       action (no href): a click or Enter calls onAction.
 *   hydrateAppearance(button, { menu(), onPick(kind, value, row), lang })
 *       ◐ ▾ and its menu (a role="menu" on <body>, placed under the
 *       button). menu() gives appearanceMenuHtml's options each time it
 *       opens; a pick calls onPick ("mode", "theme", "language" or "item",
 *       and its value) and closes it. Click, Enter, Space, ↓ or ↑ open it on
 *       the checked entry (else the first); ↑ ↓ Home End move; Esc or Tab
 *       closes it and focus goes back to ◐ ▾; a press outside closes it.
 *       → { open(), close(refocus), isOpen() }
 *   setWaiting(o | null, root?)   the update-waiting pill after the
 *       version chip: { label, action, title?, name?, onClick } shows it
 *       (waitingHtml), null hides it.
 */
import { kitT } from "./strings.js";
import {
  appearanceMenuHtml,
  bellCount,
  bellPanelHtml,
  waitingHtml,
} from "./shell-html.js";
import { focusBack } from "./dialog.js";

const all = (root, sel) =>
  Array.prototype.slice.call(root.querySelectorAll(sel));

/** A pin toggle's look for its id: ★ "Unpin x" pressed, or ☆ "Pin x". */
export function syncPinToggles(root, isPinned, lang) {
  if (!root || !root.querySelectorAll) return;
  for (const b of all(root, "[data-pin-toggle]")) {
    const id = b.getAttribute("data-pin-toggle");
    const on = !!isPinned(id);
    const label = kitT(lang, on ? "kit.pin.unpinX" : "kit.pin.pinX", { s: id });
    b.textContent = on ? "★" : "☆";
    b.setAttribute("aria-pressed", on ? "true" : "false");
    b.setAttribute("aria-label", label);
    b.title = label;
  }
}

export function hydrateShell(root, opts = {}) {
  const lang = () =>
    typeof opts.lang === "function" ? opts.lang() : opts.lang;
  const nav = root.querySelector(".den-rail");
  const railBox = root.querySelector(".den-rail-box");
  const menu = root.querySelector(".den-menu-btn");
  let scrim = null;

  function rove() {
    if (!nav) return;
    const links = all(nav, ".den-ni");
    let stop = null;
    for (const a of links)
      if (a.getAttribute("aria-current") === "page") stop = a;
    if (!stop) stop = links[0];
    for (const a of links) a.tabIndex = a === stop ? 0 : -1;
  }

  let lastHtml = null;
  function paint(html, force) {
    if (!nav || (!force && html === lastHtml)) return false;
    // Keep keyboard focus on the same entry across a repaint.
    const active = document.activeElement;
    const keep =
      active && nav.contains(active) && active.dataset
        ? active.dataset.nav
        : null;
    lastHtml = html;
    nav.innerHTML = html;
    rove();
    if (keep) {
      const again = nav.querySelector('[data-nav="' + keep + '"]');
      if (again) {
        again.tabIndex = 0;
        again.focus();
      }
    }
    return true;
  }

  function setCollapsed(on) {
    if (document.body)
      document.body.classList.toggle("den-rail-collapsed", !!on);
  }

  /**
   * Delete on a pinned row: unpin it, and keep focus in the rail: the next
   * pinned row, else the previous one, else the first entry.
   */
  function unpin(pinId) {
    const pins = all(nav, ".den-ni[data-pin]");
    const at = pins.findIndex((p) => p.dataset.pin === pinId);
    const to = at < 0 ? null : pins[at + 1] || pins[at - 1] || null;
    const toNav = to ? to.dataset.nav : null;
    if (opts.onUnpin) opts.onUnpin(pinId);
    const dest =
      (toNav && nav.querySelector('[data-nav="' + toNav + '"]')) ||
      nav.querySelector(".den-ni");
    if (!dest) return;
    for (const a of all(nav, ".den-ni")) a.tabIndex = a === dest ? 0 : -1;
    dest.focus();
  }

  function drawerOpen() {
    return document.body.classList.contains("den-rail-open");
  }
  function inertEls() {
    if (opts.inert) return opts.inert();
    return [
      root.querySelector(".den-top"),
      document.getElementById("den-content"),
    ];
  }
  function setInert(on) {
    for (const el of inertEls()) {
      if (!el) continue;
      if (on) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
  }
  function openDrawer() {
    document.body.classList.add("den-rail-open");
    if (menu) menu.setAttribute("aria-expanded", "true");
    railBox.setAttribute("role", "dialog");
    railBox.setAttribute("aria-modal", "true");
    railBox.setAttribute("aria-label", kitT(lang(), "kit.pages"));
    if (!scrim) {
      scrim = document.createElement("div");
      scrim.className = "den-scrim";
      scrim.addEventListener("click", () => closeDrawer(true));
    }
    document.body.appendChild(scrim);
    setInert(true);
    const stop =
      nav.querySelector('.den-ni[aria-current="page"]') ||
      nav.querySelector('.den-ni[tabindex="0"]') ||
      nav.querySelector(".den-ni");
    if (stop) stop.focus();
  }
  function closeDrawer(refocus) {
    if (!drawerOpen()) return;
    document.body.classList.remove("den-rail-open");
    if (menu) menu.setAttribute("aria-expanded", "false");
    railBox.removeAttribute("role");
    railBox.removeAttribute("aria-modal");
    railBox.removeAttribute("aria-label");
    if (scrim) scrim.remove();
    setInert(false);
    if (refocus && menu) menu.focus();
  }

  if (nav) {
    // ↑/↓, Home and End move along the rail; Tab still leaves it (except
    // in the narrow drawer, a modal: Tab stays inside).
    nav.addEventListener("keydown", (e) => {
      if (e.key === "Tab" && drawerOpen()) {
        e.preventDefault();
        return;
      }
      const links = all(nav, ".den-ni");
      const i = links.indexOf(document.activeElement);
      if (i < 0) return;
      const pinId =
        links[i].dataset && links[i].dataset.pin ? links[i].dataset.pin : null;
      if (pinId && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        unpin(pinId);
        return;
      }
      const next =
        e.key === "ArrowDown"
          ? (i + 1) % links.length
          : e.key === "ArrowUp"
            ? (i - 1 + links.length) % links.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? links.length - 1
                : -1;
      if (next < 0) return;
      e.preventDefault();
      links[i].tabIndex = -1;
      links[next].tabIndex = 0;
      links[next].focus();
    });
    nav.addEventListener("click", (e) => {
      const c =
        e.target && e.target.closest
          ? e.target.closest('[data-act="collapse"]')
          : null;
      if (!c) return;
      const next = !document.body.classList.contains("den-rail-collapsed");
      if (opts.onCollapse) opts.onCollapse(next);
      else setCollapsed(next);
    });
  }
  if (menu)
    menu.addEventListener("click", () => {
      if (drawerOpen()) closeDrawer(true);
      else openDrawer();
    });
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" &&
      drawerOpen() &&
      !(opts.menuOpen && opts.menuOpen())
    ) {
      e.preventDefault();
      closeDrawer(true);
    }
  });
  window.addEventListener("resize", () => {
    if (drawerOpen() && window.innerWidth > 720) closeDrawer(false);
  });

  rove();
  return {
    nav,
    rove,
    paint,
    setCollapsed,
    unpin,
    openDrawer,
    closeDrawer,
    drawerOpen,
    syncPinToggles: (r, isPinned) => syncPinToggles(r, isPinned, lang()),
  };
}

// ── 0.7.0: the scope crumbs, the search, the bell, the account ──────────

const ITEMS = '[role="menuitem"], a[href], button:not([disabled])';

/** The scope crumbs' menus (see the top). */
export function hydrateScope(root, opts = {}) {
  let open = null; // { btn, menu }
  const menuOf = (btn) => {
    const id = btn.getAttribute("aria-controls");
    return id ? document.getElementById(id) : null;
  };
  const items = (menu) => all(menu, ITEMS);
  function close(refocus) {
    if (!open) return;
    const { btn, menu } = open;
    open = null;
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (refocus) focusBack(btn);
  }
  function show(btn, at) {
    const menu = menuOf(btn);
    if (!menu) return;
    if (open && open.btn !== btn) close(false);
    // Below its ▾: the menu sits in the scope group, which places it.
    const group = btn.closest(".den-scope");
    const x = group
      ? btn.getBoundingClientRect().left - group.getBoundingClientRect().left
      : 0;
    menu.style.setProperty("--den-menu-x", Math.round(x) + "px");
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    open = { btn, menu };
    const list = items(menu);
    if (at === "first" && list[0]) list[0].focus();
    else if (at === "last" && list.length) list[list.length - 1].focus();
  }
  root.addEventListener("click", (e) => {
    const btn =
      e.target && e.target.closest ? e.target.closest(".den-scope-btn") : null;
    if (!btn || !root.contains(btn)) return;
    if (!menuOf(btn)) {
      if (opts.onOpen) opts.onOpen(btn.dataset.scope, btn);
      return;
    }
    if (open && open.btn === btn) return close(false);
    // A keyboard's Enter or Space (detail 0) starts on the first entry.
    show(btn, e.detail === 0 ? "first" : null);
  });
  root.addEventListener("keydown", (e) => {
    const t = e.target;
    const btn = t && t.closest ? t.closest(".den-scope-btn") : null;
    if (btn && menuOf(btn) && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      show(btn, e.key === "ArrowDown" ? "first" : "last");
      return;
    }
    if (!open || !open.menu.contains(t)) return;
    const list = items(open.menu);
    const i = list.indexOf(t);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === "Tab") close(false);
    if (next < 0 || !list.length) return;
    e.preventDefault();
    list[next].focus();
  });
  // Esc on the ▾ itself, with its menu open.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open && !e.defaultPrevented) {
      e.preventDefault();
      close(true);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!open) return;
    if (open.menu.contains(e.target) || open.btn.contains(e.target)) return;
    close(false);
  });
  return { close: () => close(false), isOpen: () => !!open };
}

/** The search field: a click and ⌘K / Ctrl-K activate it (see the top). */
export function hydrateSearch(btn, opts = {}) {
  if (!btn) return { activate() {}, destroy() {} };
  function activate(via, e) {
    btn.dispatchEvent(
      new CustomEvent("den-ui:search", { bubbles: true, detail: { via } }),
    );
    if (opts.onActivate) opts.onActivate(via, e);
  }
  const onClick = (e) => activate("click", e);
  const onKey = (e) => {
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      (e.key === "k" || e.key === "K" || e.code === "KeyK")
    ) {
      e.preventDefault();
      activate("key", e);
    }
  };
  btn.addEventListener("click", onClick);
  if (opts.keys !== false) document.addEventListener("keydown", onKey);
  return {
    activate: (via) => activate(via || "call"),
    destroy() {
      btn.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    },
  };
}

/** The bell and its panel (see the top). */
export function hydrateBell(btn, opts = {}) {
  const lang = () =>
    typeof opts.lang === "function" ? opts.lang() : opts.lang;
  const val = (v) => (typeof v === "function" ? v() : v);
  const pop = document.createElement("div");
  pop.className = "den-bell-pop";
  pop.id = opts.id || "den-bell-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-labelledby", opts.titleId || "den-bell-h");
  pop.tabIndex = -1;
  pop.hidden = true;
  document.body.appendChild(pop);
  btn.setAttribute("aria-controls", pop.id);
  const word = btn.getAttribute("title") || kitT(lang(), "kit.bell");

  function paint() {
    const own = opts.panel ? opts.panel() : null;
    pop.innerHTML =
      typeof own === "string"
        ? own
        : bellPanelHtml({
            lang: lang(),
            title: opts.title,
            titleId: opts.titleId,
            items: val(opts.items) || [],
            empty: opts.empty,
            foot: val(opts.foot) || "",
            ...(own || {}),
          });
  }
  const isOpen = () => !pop.hidden;
  function open() {
    if (isOpen()) return;
    paint();
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    if (opts.onOpen) opts.onOpen();
    const first = pop.querySelector("a[href], button:not([disabled])");
    (first || pop).focus();
  }
  function close(focus = true) {
    if (!isOpen()) return;
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (opts.onClose) opts.onClose();
    if (focus) focusBack(btn);
  }
  function setCount(n) {
    const c = Number(n) || 0;
    const badge = btn.querySelector(".den-bell-n");
    if (badge) {
      badge.hidden = c <= 0;
      badge.textContent = c <= 0 ? "0" : bellCount(c);
    }
    btn.setAttribute(
      "aria-label",
      c > 0 ? kitT(lang(), "kit.bell.n", { n: c }) : word,
    );
  }
  btn.addEventListener("click", () => (isOpen() ? close() : open()));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isOpen()) return;
    if (opts.onEscape && opts.onEscape(e) === true) return;
    e.preventDefault();
    close(true);
  });
  document.addEventListener("pointerdown", (e) => {
    if (isOpen() && !pop.contains(e.target) && !btn.contains(e.target))
      close(false);
  });
  return { el: pop, open, close, isOpen, paint, setCount };
}

/** The account entry as an action (see the top). */
export function hydrateAccount(root, opts = {}) {
  root.addEventListener("click", (e) => {
    const a =
      e.target && e.target.closest
        ? e.target.closest('.den-acct[data-act="account"]')
        : null;
    if (!a || !root.contains(a)) return;
    if (opts.onAction) opts.onAction(e);
  });
}

const TOP_MARGIN = 8;

/** ◐ ▾ and its menu (see the top). */
export function hydrateAppearance(btn, opts = {}) {
  const lang = () =>
    typeof opts.lang === "function" ? opts.lang() : opts.lang;
  let pop = null;
  const rows = () => (pop ? all(pop, ".den-mi") : []);
  const isOpen = () => !!pop;
  function close(refocus) {
    if (!pop) return;
    pop.remove();
    pop = null;
    btn.setAttribute("aria-expanded", "false");
    btn.removeAttribute("aria-controls");
    if (refocus) focusBack(btn);
  }
  // Under the button, kept in the window (as a host's own menus are).
  function place() {
    const r = btn.getBoundingClientRect();
    const gap = 6;
    const w = pop.offsetWidth;
    let h = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = vh - r.bottom - gap - TOP_MARGIN;
    const above = r.top - gap - TOP_MARGIN;
    const up = h > below && above > below;
    const room = Math.max(80, up ? above : below);
    if (h > room) {
      pop.style.setProperty("max-height", room + "px");
      h = room;
    }
    const top = up ? r.top - gap - h : r.bottom + gap;
    const left = Math.max(TOP_MARGIN, Math.min(r.left, vw - w - TOP_MARGIN));
    pop.style.setProperty("top", Math.max(TOP_MARGIN, top) + "px");
    pop.style.setProperty("left", left + "px");
  }
  function open(at) {
    if (pop) return;
    const model = (opts.menu ? opts.menu() : null) || {};
    pop = document.createElement("div");
    pop.className = "den-pop den-um";
    pop.tabIndex = -1;
    pop.id = (btn.id || "appearance-btn") + "-menu";
    pop.setAttribute("role", "menu");
    pop.setAttribute(
      "aria-label",
      btn.getAttribute("aria-label") || kitT(lang(), "kit.appearance"),
    );
    pop.innerHTML = appearanceMenuHtml({ lang: lang(), ...model });
    document.body.appendChild(pop);
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("aria-controls", pop.id);
    place();
    pop.addEventListener("click", (e) => {
      const row =
        e.target && e.target.closest ? e.target.closest(".den-mi") : null;
      if (!row) return;
      const kind = row.dataset.kind;
      const value = row.dataset.value;
      if (row.tagName !== "A") e.preventDefault();
      close(true);
      if (opts.onPick) opts.onPick(kind, value == null ? null : value, row);
    });
    pop.addEventListener("keydown", (e) => {
      const list = rows();
      const i = list.indexOf(document.activeElement);
      const next =
        e.key === "ArrowDown"
          ? (i + 1) % list.length
          : e.key === "ArrowUp"
            ? (i - 1 + list.length) % list.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? list.length - 1
                : -1;
      if (next >= 0 && list.length) {
        e.preventDefault();
        list[next].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      } else if (e.key === "Tab") close(true);
      else if (e.key === " " && list[i] && list[i].tagName === "A") {
        e.preventDefault();
        list[i].click();
      }
    });
    const list = rows();
    const first =
      at === "last"
        ? list[list.length - 1]
        : pop.querySelector('.den-mi[aria-checked="true"]') || list[0];
    if (first) first.focus();
    else pop.focus();
  }
  btn.addEventListener("click", () => (pop ? close(false) : open()));
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!pop) open(e.key === "ArrowUp" ? "last" : null);
  });
  document.addEventListener("mousedown", (e) => {
    if (!pop) return;
    if (pop.contains(e.target) || btn.contains(e.target)) return;
    close(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop && !e.defaultPrevented) {
      e.preventDefault();
      close(true);
    }
  });
  window.addEventListener("resize", () => close(false));
  return { open: () => open(), close: (r) => close(!!r), isOpen };
}

/** The update-waiting pill after the version chip (see the top). */
export function setWaiting(o, root = document) {
  const find = (id) =>
    root.getElementById
      ? root.getElementById(id)
      : root.querySelector("#" + id);
  const id = (o && o.id) || "stale-pill";
  let pill = find(id);
  if (!o) {
    if (pill) pill.style.display = "none";
    return null;
  }
  if (!pill) {
    const chip = find("version-pill");
    if (!chip || !chip.parentNode) return null;
    const box = document.createElement("div");
    box.innerHTML = waitingHtml(o);
    pill = box.firstChild;
    chip.parentNode.insertBefore(pill, chip.nextSibling);
    pill.addEventListener("click", (e) => {
      if (pill._onClick) pill._onClick(e);
    });
  }
  pill._onClick = o.onClick || null;
  pill.style.display = "";
  return pill;
}
