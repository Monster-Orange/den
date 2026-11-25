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
 * focusable put focus back on the anchor. An anchor that is a button says
 * aria-expanded and aria-controls while it is open. Only one is open at a
 * time: opening another closes the first.
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

function isButton(el) {
  return (
    el instanceof HTMLElement &&
    (el.tagName === "BUTTON" || el.getAttribute("role") === "button")
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

  function down(e) {
    const t = e.target;
    if (!(t instanceof Node) || el.contains(t)) return;
    if (anchor.contains(t)) return;
    close(!(t instanceof Element && t.closest(FOCUSABLE)));
  }
  function key(e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
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
