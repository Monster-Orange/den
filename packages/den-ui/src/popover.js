/**
 * The kit's pop-over (DS component #4): a small non-modal panel that opens
 * from one trigger and belongs to it, for a card, a short menu or a set of
 * filters. Framework-free; the product gives it its content and words.
 *
 *   const pop = openPopover(anchor, {
 *     content, footer   Nodes, or HTML strings the product has escaped
 *     title             the phone sheet's heading (default: the trigger's text)
 *     label, labelledBy its name, when nothing inside names it
 *     menu              true: ↑ ↓ Home End move, choosing an item closes it
 *     placement, align  "below" or "above"; "end" (default) or "start"
 *     onClose           called once, when it closes for any reason
 *   });
 *
 * Wider than 600px it sits 4px from the trigger, its end edge on the
 * trigger's, flipping and shifting to stay 16px inside the window; its body
 * scrolls and its footer stays. At 600px or less it is a bottom sheet over a
 * scrim. Esc, a press outside, Tab out or the trigger again close it; focus
 * goes back to the trigger. One is open at a time.
 */
import { dialogWord } from "./dialog.js";

const GAP = 4;
const EDGE = 16;
const PHONE = "(max-width: 600px)";
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const ITEM = '[role^="menuitem"]:not([aria-disabled="true"])';

let current = null;
let seq = 0;
let held = null;
let listening = false;

function isButton(el) {
  return (
    el instanceof Element &&
    (el.tagName === "BUTTON" || el.getAttribute("role") === "button")
  );
}

function listen() {
  if (listening) return;
  listening = true;
  document.addEventListener("pointerdown", () => (held = null), true);
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

function tabbables(box) {
  return [...document.querySelectorAll(FOCUSABLE)].filter(
    (n) =>
      !box.contains(n) &&
      n.getAttribute("tabindex") !== "-1" &&
      typeof n.focus === "function" &&
      n.getClientRects().length > 0,
  );
}

function fill(node, what) {
  if (typeof what === "string") node.innerHTML = what;
  else if (what instanceof Node) node.append(what);
}

/** Where a w×h box goes beside anchor box `a`: side, top, left and the
    height it may use. `align` "end" lines its right edge on the anchor's. */
export function placeBox(a, w, h, vw, vh, want = "below", align = "start") {
  const roomBelow = vh - a.bottom - GAP - EDGE;
  const roomAbove = a.top - GAP - EDGE;
  let side = want;
  if (side === "below" && h > roomBelow && roomAbove > roomBelow)
    side = "above";
  else if (side === "above" && h > roomAbove && roomBelow > roomAbove)
    side = "below";
  const room = Math.max(0, side === "below" ? roomBelow : roomAbove);
  const tall = Math.min(h, room);
  let top = side === "below" ? a.bottom + GAP : a.top - GAP - tall;
  top = Math.max(EDGE, Math.min(top, vh - EDGE - tall));
  const right = a.right ?? a.left + w;
  const fits = (x) => x >= EDGE && x + w <= vw - EDGE;
  const tries = align === "end" ? [right - w, a.left] : [a.left, right - w];
  let left = tries.find(fits) ?? tries[0];
  left = Math.max(EDGE, Math.min(left, vw - EDGE - w));
  return {
    top: Math.round(top),
    left: Math.round(left),
    side,
    maxHeight: Math.floor(room),
  };
}

export function openPopover(anchor, o = {}) {
  listen();
  if (current) current.close(false);
  const phone = globalThis.matchMedia?.(PHONE).matches ?? false;
  const el = document.createElement("div");
  el.className = "den-pop den-popover";
  el.id = `den-popover-${++seq}`;
  el.tabIndex = -1;
  const head = document.createElement("div");
  head.className = "den-popover-head";
  const title = document.createElement("h2");
  title.className = "den-popover-t";
  title.id = `${el.id}-t`;
  title.textContent = (o.title ?? anchor.textContent ?? "")
    .replace(/[▾▴]/g, "")
    .trim();
  const shut = document.createElement("button");
  shut.type = "button";
  shut.className = "den-btn ghost sm den-popover-x";
  shut.textContent = dialogWord("close");
  head.append(title, shut);
  const body = document.createElement("div");
  body.className = "den-popover-body";
  fill(body, o.content);
  el.append(head, body);
  if (o.footer != null) {
    const foot = document.createElement("div");
    foot.className = "den-popover-foot";
    fill(foot, o.footer);
    el.append(foot);
  }
  const named = (n) => {
    if (o.labelledBy) n.setAttribute("aria-labelledby", o.labelledBy);
    else if (o.label) n.setAttribute("aria-label", o.label);
    else if (phone && title.textContent)
      n.setAttribute("aria-labelledby", title.id);
  };
  if (o.menu) {
    body.setAttribute("role", "menu");
    named(body);
    for (const n of body.querySelectorAll("a[href], button"))
      if (!n.hasAttribute("role")) n.setAttribute("role", "menuitem");
  } else {
    el.setAttribute("role", "dialog");
    named(el);
  }
  let scrim = null;
  if (phone) {
    el.dataset.sheet = "";
    scrim = document.createElement("div");
    scrim.className = "den-popover-scrim";
    document.body.append(scrim);
  }
  document.body.append(el);
  const top = (n) => {
    if (typeof n.showPopover !== "function") return;
    n.popover = "manual";
    n.showPopover();
  };
  if (scrim) top(scrim);
  top(el);

  const button = isButton(anchor);
  if (button) {
    anchor.setAttribute("aria-haspopup", o.menu ? "menu" : "dialog");
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", el.id);
  }
  const rtl = () => globalThis.getComputedStyle(anchor).direction === "rtl";

  const place = () => {
    if (!el.isConnected || phone) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw)
      return close(false);
    el.style.setProperty("--den-pop-min", `${Math.ceil(r.width)}px`);
    el.style.maxHeight = "none";
    const align = (o.align ?? "end") === "end" ? !rtl() : rtl();
    const p = placeBox(
      r,
      el.offsetWidth,
      el.offsetHeight,
      vw,
      vh,
      o.placement,
      align ? "end" : "start",
    );
    el.style.maxHeight = `${p.maxHeight}px`;
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
    scrim?.remove();
    if (button) {
      anchor.setAttribute("aria-expanded", "false");
      anchor.removeAttribute("aria-controls");
    }
    if (refocus && anchor.isConnected && typeof anchor.focus === "function")
      anchor.focus();
    o.onClose?.();
  };

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
    const inside = [...el.querySelectorAll(FOCUSABLE)].filter(
      (n) => n.getClientRects().length > 0,
    );
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
  function step(e) {
    const items = [...body.querySelectorAll(ITEM)];
    const at = items.indexOf(document.activeElement);
    if (!items.length || at < 0) return false;
    const to = {
      ArrowDown: (at + 1) % items.length,
      ArrowUp: (at - 1 + items.length) % items.length,
      Home: 0,
      End: items.length - 1,
    }[e.key];
    if (to == null) return false;
    e.preventDefault();
    items[to].focus();
    return true;
  }
  function key(e) {
    if (e.defaultPrevented) return;
    if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) return tab(e);
    if (o.menu && step(e)) return;
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
  el.addEventListener("click", (e) => {
    if (shut.contains(e.target)) return close(true);
    if (o.menu && e.target.closest?.(ITEM)) setTimeout(() => close(true), 0);
  });

  const pop = { el, close, place };
  current = pop;
  place();
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("keydown", key, true);
  el.addEventListener("focusout", out);
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);
  const chosen = o.menu
    ? (body.querySelector(
        `${ITEM}:is([aria-checked="true"], [aria-current]:not([aria-current="false"]), [aria-selected="true"])`,
      ) ?? body.querySelector(ITEM))
    : [...el.querySelectorAll(FOCUSABLE)].find(
        (n) => n !== shut && n.getClientRects().length > 0,
      );
  (chosen instanceof HTMLElement || chosen instanceof SVGElement
    ? chosen
    : el
  ).focus();
  return pop;
}
