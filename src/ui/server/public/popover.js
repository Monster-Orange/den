/**
 * D50: how every Den pop-over goes away, in one place. A press outside it
 * (pointerdown, so a terminal or a canvas that eats the click still
 * counts) or Esc closes it, and focus goes back to the button that opened
 * it. A press inside never closes it, nor one in another layer over it:
 * its confirm, a menu it opened, a dialog (each is its own). A press on
 * the opener is left to the opener, which toggles it.
 *
 * For a modal <dialog> (the helpers list), a press on its backdrop is
 * outside: the backdrop's events land on the dialog itself, so the press's
 * point says which. Esc is the dialog's own (it closes the top one only).
 *
 *   const release = dismissable(el, { opener, close, ignore });
 *   close(refocus): close it; refocus says whether to put focus back on
 *   the opener (false when the press landed on something that takes focus
 *   itself). release(): stop listening (call it when it closes by itself).
 *
 * A touch closes it once the tap is over: a phone sends its mousedown
 * after the finger lifts, and that mousedown would take focus back off the
 * opener (Lair, 0.4.32-dev.1).
 */

/** What counts as another layer: its own press, its own Esc. */
export const LAYER =
  '.den-pop, [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], dialog[open]';

const FOCUSABLE =
  'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';

function inBox(el, e) {
  const r = el.getBoundingClientRect();
  return (
    e.clientX >= r.left &&
    e.clientX <= r.right &&
    e.clientY >= r.top &&
    e.clientY <= r.bottom
  );
}

/** Whether a press at `e` on `t` is inside pop-over `el`. */
export function pressInside(el, t, e) {
  if (el.tagName === "DIALOG" && t === el) return inBox(el, e);
  return el.contains(t);
}

/** How long a touch may last before it closes the pop-over anyway. */
export const TAP_WAIT_MS = 700;

/**
 * Run `fn` once the press `e` is over: right after a mouse's own
 * mousedown; after a touch's click (its mousedown comes just before), or
 * TAP_WAIT_MS when there is none (the finger moved away).
 */
function afterPress(e, fn) {
  if (e.pointerType !== "touch" && e.pointerType !== "pen")
    return void setTimeout(fn, 0);
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    document.removeEventListener("click", go, true);
    clearTimeout(t);
    setTimeout(fn, 0);
  };
  const t = setTimeout(go, TAP_WAIT_MS);
  document.addEventListener("click", go, true);
}

/**
 * Put focus on the first of `els` that takes it (one that is gone, hidden
 * or inert, such as a pin in a closed drawer, doesn't). True when one did.
 */
export function focusBack(...els) {
  for (const x of els) {
    if (!x?.isConnected || typeof x.focus !== "function") continue;
    x.focus();
    if (document.activeElement === x) return true;
  }
  return false;
}

export function dismissable(el, { opener, close, ignore } = {}) {
  const op = () => (typeof opener === "function" ? opener() : opener);
  let on = true;
  const release = () => {
    if (!on) return;
    on = false;
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("keydown", key, true);
  };
  function down(e) {
    if (!el.isConnected) return release();
    const t = e.target;
    if (!(t instanceof Node) || pressInside(el, t, e)) return;
    if (op()?.contains?.(t)) return;
    if (ignore?.(t)) return;
    const layer = t instanceof Element ? t.closest(LAYER) : null;
    if (layer && layer !== el && !layer.contains(el)) return;
    release();
    // On something that takes focus: focus goes there, so close now.
    if (t instanceof Element && t.closest(FOCUSABLE)) return close(false);
    // Else after the press's own mousedown, which moves focus to the body:
    // then focus goes back to the opener.
    afterPress(e, () => close(true));
  }
  function key(e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!el.isConnected) return release();
    if (el.tagName === "DIALOG") return;
    // A menu or confirm over it has the keyboard: Esc is its.
    const a = document.activeElement;
    const layer = a instanceof Element ? a.closest(LAYER) : null;
    if (layer && !el.contains(a)) return;
    e.preventDefault();
    e.stopPropagation();
    release();
    close(true);
  }
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("keydown", key, true);
  return release;
}
