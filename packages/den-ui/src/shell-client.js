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
 */
import { kitT } from "./strings.js";

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
