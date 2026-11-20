/**
 * den-ui, issue 302: a phone's on-screen keyboard. While it is up, only
 * what the person reads and the box they type in stay. One attribute says
 * so (`data-kbd-up` on the root), and one property says how tall the
 * visible area is (`--vv-h`, the visual viewport's height: 100dvh doesn't
 * shrink for the iOS keyboard), so a page fits above the keyboard. The
 * kit's top bar, and anything a page marks `data-kbd-hide`, step aside
 * under the attribute (phone.css); nothing reads it but CSS.
 *
 * The rule and its numbers are another app's phone kit, value for value
 * (a touch screen, a text field focused, the visual viewport at least
 * 120px shorter than the window; a tap on a `data-kbd-dismiss` region
 * that isn't a control puts the keyboard down).
 *
 *   initKeyboardUp(win?, { min? })  once, at start; returns its undo
 *   keyboardIsUp({ coarse, typing, innerHeight, visibleHeight, min? })
 *   typesText(el)   a field the on-screen keyboard types into
 *   dismisses(el)   a tap there puts the keyboard down
 *   KEYBOARD_MIN    120: the browser's own bars are under it
 */

/** A field the on-screen keyboard types into. One that says inputmode="none" (a terminal's own hidden input on a phone) never raises it. */
export function typesText(el) {
  if (!el) return false;
  if (el.getAttribute?.("inputmode") === "none") return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(
    el.type,
  );
}

/** The visual viewport this much shorter than the window means a keyboard (the browser's own bars are under 100). */
export const KEYBOARD_MIN = 120;

/** Up: a touch screen, a text field focused, and the visible area at least `min` (KEYBOARD_MIN) shorter than the window. */
export function keyboardIsUp(s) {
  const min = Number.isFinite(s.min) ? s.min : KEYBOARD_MIN;
  return s.coarse && s.typing && s.innerHeight - s.visibleHeight >= min;
}

/** A tap that puts the keyboard down: inside a region marked `data-kbd-dismiss`, never on a control (a link, a button, a field: those take the tap as their own). */
export function dismisses(target) {
  if (!target?.closest?.("[data-kbd-dismiss]")) return false;
  return !target.closest(
    "a, button, input, textarea, select, label, summary, [contenteditable='true'], [role='button'], [role='link']",
  );
}

/** Once, at start: follow the visual viewport and the focus. Returns its undo (tests). */
export function initKeyboardUp(win = window, opts = {}) {
  const vv = win.visualViewport;
  if (!vv) return () => {};
  const doc = win.document;
  const root = doc.documentElement;
  const coarse = win.matchMedia?.("(pointer: coarse)");
  const update = () => {
    const up = keyboardIsUp({
      coarse: !!coarse?.matches,
      typing: typesText(doc.activeElement),
      innerHeight: win.innerHeight,
      visibleHeight: vv.height,
      min: opts.min,
    });
    if (up) {
      root.dataset.kbdUp = "";
      root.style.setProperty("--vv-h", `${Math.round(vv.height)}px`);
    } else if ("kbdUp" in root.dataset) {
      delete root.dataset.kbdUp;
      root.style.removeProperty("--vv-h");
    }
  };
  // Focus moves before the keyboard does, and after a blur the next field
  // may take it: settle on the next frame.
  const soon = () => win.requestAnimationFrame(update);
  // A tap on the reading area while typing: the keyboard goes down and the
  // page's chrome comes back (iOS keeps the focus on a tap outside a
  // field, so the keyboard would stay).
  const tap = (e) => {
    if (!("kbdUp" in root.dataset) || !dismisses(e.target)) return;
    doc.activeElement?.blur?.();
  };
  vv.addEventListener("resize", update);
  doc.addEventListener("focusin", soon);
  doc.addEventListener("focusout", soon);
  doc.addEventListener("pointerdown", tap);
  update();
  return () => {
    vv.removeEventListener("resize", update);
    doc.removeEventListener("focusin", soon);
    doc.removeEventListener("focusout", soon);
    doc.removeEventListener("pointerdown", tap);
  };
}
