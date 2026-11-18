/**
 * FB (den#81), Ward's rule: the Report button is visible in every pop-up,
 * never only in a menu. Rather than each dialog, drawer and popover
 * remembering to add it, this puts it in every one that shows: in its
 * footer when it has one (first, so it sits on the left), else in a footer
 * of its own at the end. A pop-up that repaints itself (a dialog whose
 * contents change by state, a panel that refreshes) gets it back.
 *
 * Kept apart from the form (the kit's report.js) and from how the button
 * looks: it is given the button's HTML and whether reports are off, so the
 * form and the button can move to the shared UI package as they are.
 *
 *   startReportInjector({ button: () => html, off: () => bool })
 *
 * The test (tests/unit/server/report-everywhere.browser.test.ts) holds
 * every pop-up to this.
 */

/** What a pop-up is: the layers the person sees over a page. */
export const LAYERS =
  'dialog[open], [role="dialog"], [role="alertdialog"], .den-drawer';

/**
 * The shell's menus (the user menu ◐ ▾, the scope menus, the kit's menus
 * on <body>): pop-ups too (issue 81). Each gets Report as a menu item of
 * its own at its foot, kept in view when the menu scrolls.
 */
export const MENUS = '.den-pop[role="menu"]';

/**
 * The rail as a drawer below 720 px: the top bar is inert behind it, so
 * the drawer gets Report of its own at the rail's foot (issue 81). Its box
 * is display: contents; the rail (the nav) is what shows.
 */
export const DRAWER = '.den-rail-box[role="dialog"]';

/**
 * Pop-ups that carry Report another way, or that aren't pop-ups of their
 * own. Each says why.
 */
export const SKIP = [
  // The form itself.
  ".fb-dlg",
  // The working pop-up has its own Report (busy.js, data-bz="report").
  ".bz-dlg",
  // The rail: as a drawer, it gets Report at its foot (addToDrawer).
  ".den-rail",
  ".den-rail-box",
  // An ask drawn inside the bell's panel: the panel has the button.
  ".den-bell-ask",
].join(", ");

/** A pop-up's own button row, when it has one (the first that matches). */
export const FOOTERS = [
  ".cl-footer",
  ".den-svp-foot",
  ".btns",
  ".rd-acts",
  ".sa-fresh-acts",
  ".wsd-acts",
  "[data-den-foot]",
];

function popoverOpen(el) {
  try {
    return el.matches(":popover-open");
  } catch {
    return false; // a browser without popovers
  }
}

function shown(el) {
  if (el.hidden || el.closest("[hidden]")) return false;
  // A dialog element shown as a popover (showPopover) shows with open unset.
  if (el.tagName === "DIALOG" && !el.open && !popoverOpen(el)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Whether `el` belongs to `layer` and not to a layer inside it. */
function own(layer, el) {
  return el.closest(LAYERS) === layer;
}

/** Put the button in `layer`, if it shows and doesn't have one. */
export function addTo(layer, html) {
  if (!html || layer.matches(SKIP) || layer.closest(SKIP)) return false;
  if (!shown(layer)) return false;
  const has = [...layer.querySelectorAll("[data-den-report]")].some((b) =>
    own(layer, b),
  );
  if (has) return false;
  for (const sel of FOOTERS) {
    const foot = [...layer.querySelectorAll(sel)].find((f) => own(layer, f));
    if (foot) {
      foot.insertAdjacentHTML("afterbegin", html);
      foot.firstElementChild?.classList.add("den-rb-in");
      return true;
    }
  }
  const foot = document.createElement("div");
  foot.className = "den-rb-foot";
  foot.innerHTML = html;
  layer.append(foot);
  return true;
}

/** A menu showing with no Report of its own gets one at its foot. */
export function addToMenu(menu, html) {
  if (!html || !shown(menu)) return false;
  if (menu.querySelector("[data-den-report]")) return false;
  const foot = document.createElement("div");
  foot.className = "den-rb-foot den-rb-menu";
  foot.setAttribute("role", "none");
  foot.innerHTML = html;
  foot.querySelector("[data-den-report]")?.setAttribute("role", "menuitem");
  menu.append(foot);
  return true;
}

/**
 * The open drawer's rail gets Report at its foot, again after the rail
 * repaints. It shows only while the drawer is open (CSS below).
 */
export function addToDrawer(box, html) {
  const rail = box.querySelector(".den-rail");
  if (!html || !rail) return false;
  if (rail.querySelector(":scope > .den-rb-drawer")) return false;
  const foot = document.createElement("div");
  foot.className = "den-rb-foot den-rb-drawer";
  foot.innerHTML = html;
  rail.append(foot);
  return true;
}

const CSS = `
.den-rb-menu { position: sticky; bottom: -6px; margin: 6px -6px -6px;
  padding: 6px 8px; background: var(--raised); border-radius: 0 0 10px 10px; }
.den-rb-drawer { position: sticky; bottom: -10px; margin: auto -8px -10px;
  background: var(--surface); }
body:not(.den-rail-open) .den-rb-drawer { display: none; }
`;
function addStyle() {
  if (document.getElementById("den-rb-inject-css")) return;
  const st = document.createElement("style");
  st.id = "den-rb-inject-css";
  st.textContent = CSS;
  document.head.append(st);
}

/** Every pop-up showing now gets the button; how many were given one. */
export function sweep(html, root = document) {
  let n = 0;
  for (const layer of root.querySelectorAll(LAYERS))
    if (addTo(layer, html)) n++;
  for (const menu of root.querySelectorAll(MENUS))
    if (addToMenu(menu, html)) n++;
  for (const box of root.querySelectorAll(DRAWER))
    if (addToDrawer(box, html)) n++;
  return n;
}

let started = false;

/**
 * Watch the page cheaply (a page with terminals changes all the time): the
 * body's own children (pop-ups are added there), and the attributes that
 * open one (open, hidden, popover), not every change in the page. Each
 * pop-up that showed is then watched on its own, so a repaint inside it
 * gets the button back. Within a frame. Off (feedback.enabled: false):
 * nothing is added, and the page hides those there (den-report-off).
 */
export function startReportInjector({ button, off }) {
  if (started) return;
  started = true;
  const watched = new WeakSet();
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  };
  const inner = new MutationObserver(queue);
  function run() {
    queued = false;
    if (off()) return;
    addStyle();
    sweep(button());
    // The drawer is watched too: the rail repaints and wipes its foot.
    for (const layer of document.querySelectorAll(
      `${LAYERS}, ${MENUS}, ${DRAWER}`,
    )) {
      if (watched.has(layer)) continue;
      if (layer.matches(SKIP) && !layer.matches(DRAWER)) continue;
      watched.add(layer);
      inner.observe(layer, { childList: true, subtree: true });
    }
  }
  const ANY = `${LAYERS}, ${MENUS}`;
  const isLayer = (n) =>
    n.nodeType === 1 && (n.matches(ANY) || !!n.querySelector(ANY));
  new MutationObserver((records) => {
    for (const r of records) {
      if (
        r.type === "attributes" ? r.target.matches(`${ANY}, ${DRAWER}`) : false
      )
        return queue();
      if (r.target.tagName === "DIALOG") return queue();
      for (const n of r.addedNodes) if (isLayer(n)) return queue();
    }
  }).observe(document.documentElement, {
    attributes: true,
    subtree: true,
    // role: the rail's box is a dialog only while it is the drawer.
    attributeFilter: ["open", "hidden", "popover", "role"],
  });
  new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes) if (isLayer(n)) return queue();
  }).observe(document.body, { childList: true });
  // A popover opened with showPopover() changes no attribute: its toggle
  // event (it doesn't bubble; capture sees it) says so.
  document.addEventListener("toggle", queue, true);
  queue();
}
