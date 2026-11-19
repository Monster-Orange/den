/**
 * The bulk bar (issue 553): what a list says while rows are selected.
 * "{n} selected", Clear, then the host's actions with their counts
 * ("Pause 3"), sticky at the bottom of the list. Framework-free and
 * data-only: the host passes the count, its actions and callbacks; the
 * kit draws the markup and owns its words (kit.bulk.* in strings.js).
 *
 *   bulkBarHtml({ count, actions, lang }) → string   (pure; hidden at 0)
 *   const bar = mountBulkBar(el, {
 *     count: 3,
 *     actions: [{ id, label, count?, disabled? }],
 *     onAction: (id, button) => …,  an action pressed; a host that opens a
 *                                   dialog passes `button` as its opener
 *                                   (askConfirm({ …, opener: button })),
 *                                   so focus comes back to it
 *     onClear: () => …,             Clear pressed: the host unselects its
 *                                   rows; the bar hides at once
 *     returnFocus: el | () => el,   where focus goes when the bar hides
 *                                   with focus in it (a Select all, say)
 *     lang: "en" | () => "en",      default: <html lang>
 *   })
 *   bar.update({ count?, actions? })   bar.destroy()
 *
 * An action's label is the host's own word (its data); the kit adds the
 * count in the language's form ("Pause 3", ja "一時停止（3）"). A disabled
 * action is a disabled button and never reaches the host.
 *
 * `el` becomes the bar: <div class="den-bulk" role="region"
 * aria-label="3 selected">, hidden at 0. A visually hidden polite live
 * region beside it says the count when it changes, and "Selection
 * cleared" after Clear.
 *
 * Its look is bulk-bar.css (link it after tokens.css): sticky, 12px over
 * the bottom of the scrolling list (and over the safe area). Under 720px
 * each action takes the bar's width; there, and on a touch screen, every
 * button is 44px tall.
 */
import { esc, kitT } from "./strings.js";

const selectedWords = (count, lang) =>
  kitT(lang, "kit.bulk.selected", { n: count });

function actionsHtml(actions, lang) {
  return (actions || [])
    .map((a) => {
      const words =
        typeof a.count === "number"
          ? kitT(lang, "kit.bulk.action", { label: a.label, n: a.count })
          : a.label;
      return (
        `<button type="button" class="den-bulk-act" data-action="${esc(a.id)}"` +
        `${a.disabled ? " disabled" : ""}>${esc(words)}</button>`
      );
    })
    .join("");
}

function innerHtml(count, actions, lang) {
  return (
    `<span class="den-bulk-count">${esc(selectedWords(count, lang))}</span>` +
    `<button type="button" class="den-bulk-clear">${esc(kitT(lang, "kit.bulk.clear"))}</button>` +
    `<span class="den-bulk-actions">${actionsHtml(actions, lang)}</span>`
  );
}

/** The bar as markup (see the top of this file). Pure: runs in Node. */
export function bulkBarHtml({ count = 0, actions = [], lang = "en" } = {}) {
  const n = Math.max(0, Number(count) || 0);
  return (
    `<div class="den-bulk" role="region" aria-label="${esc(selectedWords(n, lang))}"${n ? "" : " hidden"}>` +
    innerHtml(n, actions, lang) +
    `</div>`
  );
}

/** The bulk bar in `el` (see the top of this file). */
export function mountBulkBar(el, opts = {}) {
  let count = Math.max(0, Number(opts.count) || 0);
  let actions = opts.actions || [];
  const lang = () => {
    const l = typeof opts.lang === "function" ? opts.lang() : opts.lang;
    return l || document.documentElement.lang?.slice(0, 2) || "en";
  };
  el.classList.add("den-bulk");
  el.setAttribute("role", "region");
  const live = document.createElement("span");
  live.className = "den-bulk-live";
  live.setAttribute("aria-live", "polite");
  el.after(live);

  function paint(say) {
    const l = lang();
    const had = el.contains(document.activeElement);
    const focusAct = had ? document.activeElement.dataset?.action : null;
    const focusClear = had
      ? document.activeElement.classList.contains("den-bulk-clear")
      : false;
    el.setAttribute("aria-label", selectedWords(count, l));
    el.innerHTML = innerHtml(count, actions, l);
    el.hidden = count === 0;
    if (say) live.textContent = say;
    if (!had) return;
    if (count === 0) {
      const to =
        typeof opts.returnFocus === "function"
          ? opts.returnFocus()
          : opts.returnFocus;
      to?.focus?.({ preventScroll: true });
      return;
    }
    // A redraw keeps focus on the same control.
    const again = focusAct
      ? el.querySelector(`.den-bulk-act[data-action="${CSS.escape(focusAct)}"]`)
      : focusClear
        ? el.querySelector(".den-bulk-clear")
        : null;
    if (again && !again.disabled) again.focus({ preventScroll: true });
  }

  const onClick = (e) => {
    const b = e.target.closest?.("button");
    if (!b || !el.contains(b) || b.disabled) return;
    if (b.classList.contains("den-bulk-clear")) {
      count = 0;
      paint(kitT(lang(), "kit.bulk.cleared"));
      opts.onClear?.();
      return;
    }
    if (b.classList.contains("den-bulk-act"))
      opts.onAction?.(b.dataset.action, b);
  };
  el.addEventListener("click", onClick);
  paint(count ? selectedWords(count, lang()) : "");

  return {
    update(data = {}) {
      const was = count;
      if (data.count != null) count = Math.max(0, Number(data.count) || 0);
      if (data.actions) actions = data.actions;
      paint(count !== was && count > 0 ? selectedWords(count, lang()) : "");
    },
    destroy() {
      el.removeEventListener("click", onClick);
      live.remove();
    },
  };
}
