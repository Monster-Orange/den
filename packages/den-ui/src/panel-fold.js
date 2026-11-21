/**
 * The panel fold toggle (issue 548) and the folded panel's edge strip
 * (issue 549). A page with a side panel (comments, details, a list) lets a
 * person fold it away to read the main column clean, and bring it back.
 * The host keeps the state (shown or folded, remembered or not) and lays
 * the page out; the kit draws the two controls, owns their words (en, es,
 * ja) and their keys and focus. Pure builders run in Node too:
 *
 *   foldToggleHtml({ pressed, controls, lang })
 *     <button class="den-fold" aria-pressed>: an icon, then "Panel".
 *     pressed (default true) = the panel shows. controls: the panel's id.
 *   edgeStripHtml({ count, what, controls, lang })
 *     <div class="den-strip" role="complementary" aria-label="Panel,
 *     hidden">, 40px wide, for where the folded panel was: a "Show panel"
 *     icon button, then the count under it (none at 0; 99+ past 99). The
 *     count is seen as a number and heard as the kit's badge words:
 *     what is "open" (default), "waiting", "down" or "running".
 *
 * In the page, the same elements come alive:
 *
 *   const fold = hydrateFoldToggle(button, { onToggle: (next) => … });
 *     A press (click, Enter, Space) moves aria-pressed and calls
 *     onToggle(next): true = show the panel. fold.set(pressed) moves it
 *     with no call (the host's own change, a kept layout); fold.pressed();
 *     fold.destroy().
 *   const strip = hydrateEdgeStrip(div, { onShow: () => …, lang });
 *     Show panel calls onShow(). The host shows the panel and hides the
 *     strip. When focus is still in the strip after that (or fell to the
 *     body), it goes to the fold toggle for the same panel, else to the
 *     panel when it can take focus. A focus the host moved itself is
 *     kept. strip.setCount(n, what?); strip.destroy().
 *
 * Host words are never used: a label, title or aria-label passed to a
 * builder is ignored. The look is panel-fold.css: link it after
 * tokens.css. The host shows or hides each with the `hidden` attribute.
 */
import { icon } from "./icons.js";
import { esc, kitT } from "./strings.js";

/** The counts a strip may say, worded as the kit's badges are. */
const WHAT = ["open", "waiting", "down", "running"];

const langOf = (lang) => lang || "en";

/** The fold toggle's markup (see the top of this file). */
export function foldToggleHtml(o = {}) {
  const lang = langOf(o.lang);
  const pressed = o.pressed !== false;
  const controls = o.controls ? ` aria-controls="${esc(o.controls)}"` : "";
  return (
    `<button type="button" class="den-fold" aria-pressed="${pressed}"` +
    `${controls} data-den-fold>${icon("panel")}` +
    `<span class="den-fold-word">${esc(kitT(lang, "kit.fold.panel"))}</span>` +
    "</button>"
  );
}

/** The count under Show panel: the number seen, the words heard. */
function countHtml(n, what, lang) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (!count) return "";
  const kind = WHAT.includes(what) ? what : "open";
  const seen = count > 99 ? "99+" : String(count);
  const heard = kitT(lang, `kit.badge.${kind}`, { n: count });
  return (
    `<span class="den-strip-n" data-den-strip-n>` +
    `<span aria-hidden="true">${esc(seen)}</span>` +
    `<span class="den-strip-sr">${esc(heard)}</span></span>`
  );
}

/** The edge strip's markup (see the top of this file). */
export function edgeStripHtml(o = {}) {
  const lang = langOf(o.lang);
  const show = esc(kitT(lang, "kit.fold.show"));
  const controls = o.controls ? ` aria-controls="${esc(o.controls)}"` : "";
  return (
    `<div class="den-strip" role="complementary"` +
    ` aria-label="${esc(kitT(lang, "kit.fold.hidden"))}" data-den-strip>` +
    `<button type="button" class="den-strip-show" aria-label="${show}"` +
    ` title="${show}"${controls} data-den-strip-show>${icon("panelShow")}` +
    `</button>${countHtml(o.count, o.what, lang)}</div>`
  );
}

/** The fold toggle in the page (see the top of this file). */
export function hydrateFoldToggle(btn, opts = {}) {
  const read = () => btn?.getAttribute("aria-pressed") === "true";
  const set = (on) => btn?.setAttribute("aria-pressed", String(Boolean(on)));
  // A <button>: Enter and Space are clicks.
  const onClick = () => {
    const next = !read();
    set(next);
    opts.onToggle?.(next);
  };
  btn?.addEventListener("click", onClick);
  return {
    set,
    pressed: read,
    destroy() {
      btn?.removeEventListener("click", onClick);
    },
  };
}

/** Can a person see it (laid out, not hidden by an ancestor)? */
const shown = (el) =>
  Boolean(el && el.isConnected && el.getClientRects().length > 0);

/** The edge strip in the page (see the top of this file). */
export function hydrateEdgeStrip(strip, opts = {}) {
  const btn = strip?.querySelector("[data-den-strip-show]");
  const lang = () =>
    opts.lang ||
    strip?.closest("[lang]")?.getAttribute("lang")?.slice(0, 2) ||
    "en";

  /** Where focus goes when the host left it in a strip now out of sight. */
  function returnFocus() {
    const a = document.activeElement;
    const lost = !a || a === document.body || (strip.contains(a) && !shown(a));
    if (!lost) return;
    const id = btn?.getAttribute("aria-controls");
    const toggle = id
      ? document.querySelector(
          `[data-den-fold][aria-controls="${CSS.escape(id)}"]`,
        )
      : null;
    if (shown(toggle)) return toggle.focus({ preventScroll: true });
    const panel = id ? document.getElementById(id) : null;
    if (shown(panel) && panel.tabIndex >= 0)
      panel.focus({ preventScroll: true });
  }

  const onClick = () => {
    opts.onShow?.();
    returnFocus();
  };
  btn?.addEventListener("click", onClick);

  return {
    setCount(n, what) {
      if (!strip) return;
      strip.querySelector("[data-den-strip-n]")?.remove();
      const html = countHtml(n, what, lang());
      if (html) strip.insertAdjacentHTML("beforeend", html);
    },
    destroy() {
      btn?.removeEventListener("click", onClick);
    },
  };
}
