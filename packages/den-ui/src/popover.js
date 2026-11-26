/**
 * The kit's popover: a small non-modal box anchored to what opened it (a
 * button, a link, or a node in an SVG map), for a card or a short set of
 * actions. Framework-free; the product gives it its content and words.
 *
 *   const pop = openPopover(anchor, {
 *     content,      a Node, or an HTML string the product has escaped
 *     label,        its name (aria-label), or
 *     labelledBy,   the id of an element inside it that names it
 *     placement,    "below" (the default) or "above"; it flips when the
 *                   side asked for has no room
 *     onClose,      called once, when it closes for any reason
 *   });
 *   pop.el          the popover's element (div.den-pop.den-popover)
 *   pop.close(refocus)  close it; refocus puts focus back on the anchor
 *   pop.place()     place it again (after its content changed size)
 *
 * It is role="dialog" and never aria-modal: the page behind it stays live,
 * so there is no focus trap (only the kit's modal dialogs trap focus).
 * Focus moves to its first control, or to the box itself. Esc, a press
 * outside it, or Tab out of it closes it; Esc and a press on nothing
 * focusable put focus back on the anchor, and a press on a control leaves
 * focus there. Tab past its last control goes on to what follows the
 * anchor, and Shift+Tab before its first goes back to the anchor, as if it
 * sat right after the anchor. A press on the open anchor closes it, and
 * that press's click never reaches the anchor, so a page that opens it on
 * click doesn't open it again (nor follows a link anchor's href). An
 * anchor that is a button (an HTML button, or anything with role="button",
 * an SVG node too) says aria-haspopup="dialog", and aria-expanded and
 * aria-controls while it is open. Only one is open at a time: opening
 * another closes the first.
 *
 * It is placed with position: fixed beside the anchor's box, kept 8px
 * inside the viewport, and placed again on scroll and resize.
 */

const GAP = 6;
const EDGE = 8;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let current = null;
let seq = 0;
/** The anchor whose press just closed its popover: that press's click is held back. */
let held = null;
let listening = false;

function isButton(el) {
  return (
    el instanceof Element &&
    (el.tagName === "BUTTON" || el.getAttribute("role") === "button")
  );
}

/**
 * Once per page: the held anchor's click is stopped. A new press, a press
 * that is cancelled (a touch that becomes a scroll, so no click follows),
 * or a key forgets it, so the next click or Enter on the anchor goes through.
 */
function listen() {
  if (listening) return;
  listening = true;
  const forget = () => (held = null);
  document.addEventListener("pointerdown", forget, true);
  document.addEventListener("pointercancel", forget, true);
  document.addEventListener("keydown", forget, true);
  document.addEventListener(
    "click",
    (e) => {
      const a = held;
      held = null;
      if (!a || !(e.target instanceof Node) || !a.contains(e.target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
}

/** What Tab can reach, in document order, outside `box`: shown, not inert. */
function tabbables(box) {
  return [...document.querySelectorAll(FOCUSABLE)].filter(
    (n) =>
      !box.contains(n) &&
      n.getAttribute("tabindex") !== "-1" &&
      typeof n.focus === "function" &&
      !n.closest("[inert]") &&
      n.getClientRects().length > 0 &&
      getComputedStyle(n).visibility === "visible",
  );
}

/** Where the box goes: below or above the anchor, inside the viewport. */
export function placeBox(a, w, h, vw, vh, want = "below") {
  const roomBelow = vh - a.bottom - GAP - EDGE;
  const roomAbove = a.top - GAP - EDGE;
  let side = want;
  if (side === "below" && h > roomBelow && roomAbove > roomBelow)
    side = "above";
  else if (side === "above" && h > roomAbove && roomBelow > roomAbove)
    side = "below";
  let top = side === "below" ? a.bottom + GAP : a.top - GAP - h;
  top = Math.max(EDGE, Math.min(top, vh - EDGE - h));
  let left = a.left;
  left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
  return { top: Math.round(top), left: Math.round(left), side };
}

export function openPopover(anchor, o = {}) {
  listen();
  if (current) current.close(false);
  const el = document.createElement("div");
  el.className = "den-pop den-popover";
  el.id = `den-popover-${++seq}`;
  el.setAttribute("role", "dialog");
  el.tabIndex = -1;
  if (o.labelledBy) el.setAttribute("aria-labelledby", o.labelledBy);
  else if (o.label) el.setAttribute("aria-label", o.label);
  if (typeof o.content === "string") el.innerHTML = o.content;
  else if (o.content instanceof Node) el.append(o.content);
  document.body.append(el);

  const button = isButton(anchor);
  if (button) {
    anchor.setAttribute("aria-haspopup", "dialog");
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", el.id);
  }

  const place = () => {
    if (!el.isConnected) return;
    const r = anchor.getBoundingClientRect();
    const p = placeBox(
      r,
      el.offsetWidth,
      el.offsetHeight,
      window.innerWidth,
      window.innerHeight,
      o.placement,
    );
    el.style.top = `${p.top}px`;
    el.style.left = `${p.left}px`;
    el.dataset.side = p.side;
  };

  let open = true;
  const close = (refocus = true) => {
    if (!open) return;
    open = false;
    if (current === pop) current = null;
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("keydown", key, true);
    el.removeEventListener("focusout", out);
    window.removeEventListener("scroll", place, true);
    window.removeEventListener("resize", place);
    el.remove();
    if (button) {
      anchor.setAttribute("aria-expanded", "false");
      anchor.removeAttribute("aria-controls");
    }
    if (refocus && anchor.isConnected && typeof anchor.focus === "function")
      anchor.focus();
    o.onClose?.();
  };

  // A press moves focus itself once its own events are done (to a control,
  // or to nothing, or in WebKit away from a pressed button), so the anchor
  // takes focus back after that when nothing else has it.
  const refocusLater = () =>
    setTimeout(() => {
      const now = document.activeElement;
      if (anchor.isConnected && (!now || now === document.body)) anchor.focus();
    }, 0);
  function down(e) {
    const t = e.target;
    if (!(t instanceof Node) || el.contains(t)) return;
    if (anchor.contains(t)) {
      held = anchor;
      close(true);
      refocusLater();
      return;
    }
    const onControl = t instanceof Element && t.closest(FOCUSABLE);
    close(false);
    if (!onControl) refocusLater();
  }
  function tab(e) {
    const a = document.activeElement;
    if (!el.contains(a)) return;
    const inside = [...el.querySelectorAll(FOCUSABLE)];
    if (e.shiftKey) {
      if (a !== el && a !== inside[0]) return;
      e.preventDefault();
      close(true);
      return;
    }
    if (inside.length && a !== inside[inside.length - 1]) return;
    const after = tabbables(el).find(
      (n) =>
        !anchor.contains(n) &&
        anchor.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    if (!after) return;
    e.preventDefault();
    close(false);
    after.focus();
  }
  function key(e) {
    if (e.defaultPrevented) return;
    if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) return tab(e);
    if (e.key !== "Escape") return;
    const a = document.activeElement;
    if (a !== anchor && !el.contains(a) && a !== document.body) return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  }
  function out(e) {
    const to = e.relatedTarget;
    if (to instanceof Node && el.contains(to)) return;
    close(false);
  }

  const pop = { el, close, place };
  current = pop;
  place();
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("keydown", key, true);
  el.addEventListener("focusout", out);
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  const first = el.querySelector(FOCUSABLE);
  (first instanceof HTMLElement || first instanceof SVGElement
    ? first
    : el
  ).focus();
  return pop;
}
