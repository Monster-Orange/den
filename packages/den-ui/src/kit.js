/**
 * den-ui in the page: one entry for the kit's components, also set as
 * window.DenUI. Every call to the product's server goes through the
 * adapter the product gives; the kit names no URL of its own.
 *
 *   import DenUI from "/kit/kit.js";   // or window.DenUI after it loads
 *   DenUI.configure({
 *     lang: "en",                      // or () => lang
 *     product: { name: "Acme" },       // {product} in the kit's words
 *     adapter: {
 *       changelog: () => Promise<entries>,          What's new
 *       applyUpdate: () => Promise<unknown>,        the update pill's Reload
 *       fileReport: (payload) => Promise<{ number, url } | { error }>,
 *       request: (id) => Promise<{ state, result?, error? }>,  Check again
 *       ...the Report form's fuller calls (report.js)
 *     },
 *     report: { busy, mine, page, screenshot, library },  Report's options
 *     reportOff: false,                // hides every Report button
 *   });
 *
 *   DenUI.hydrate(root, opts)   binds the shell shell-html.js drew (on the
 *                               server, or by mount); see shell-client.js.
 *                               The version chip opens What's new; any
 *                               [data-den-report] and ⌘⇧F open Report.
 *   DenUI.mount(root, model)    draws shellHtml(model) into root, then
 *                               hydrates it (a page with no server render)
 *   DenUI.shellHtml(model)      the markup (shell-html.js)
 *   DenUI.scopeHtml, searchHtml, bellButtonHtml, bellPanelHtml,
 *   accountHtml (0.7.0)         the scope crumbs, the search with ⌘K
 *                               inside, the bell and its panel, and the
 *                               rail's account entry; hydrate wires them
 *   DenUI.settingsHtml, appearanceButtonHtml, appearanceMenuHtml,
 *   waitingHtml (0.7.0)         the rail's Settings, ◐ ▾ and its menu
 *                               (hydrate's opts.appearance: { menu,
 *                               onPick }), the update-waiting pill
 *                               (DenUI.version.waiting(o | null))
 *   DenUI.version.set(label), .unread(on), .label(running, changelog)
 *   DenUI.whatsNew.open(), .close(), .load(), .setEntries(list)
 *   DenUI.update.set({ version, message, reloadLabel, dismissLabel,
 *                cancelLabel, askFirst?, onDismiss? }), .hide()
 *   DenUI.report.open({ prefill, opener }), .button({ inFoot })
 *                               focus goes back to opener (else the
 *                               control that opened it) on close
 *   DenUI.busy.run(action, run, opts)   the working pop-up (busy.js)
 *   DenUI.strings(lang, table)  the product's own words, or its versions
 *                               of the kit's; DenUI.t(key, vars)
 */
import { addStrings, kitT, setProduct } from "./strings.js";
import {
  accountHtml,
  appearanceButtonHtml,
  appearanceMenuHtml,
  bellButtonHtml,
  bellPanelHtml,
  esc,
  icon,
  navItemHtml,
  railHtml,
  reportButtonHtml,
  reportPrefillOf,
  scopeCrumbHtml,
  scopeHtml,
  searchHtml,
  settingsHtml,
  shellHtml,
  topBarHtml,
  versionChipHtml,
  waitingHtml,
} from "./shell-html.js";
import {
  hydrateAccount,
  hydrateAppearance,
  hydrateBell,
  hydrateScope,
  hydrateSearch,
  hydrateShell,
  setWaiting,
  syncPinToggles,
} from "./shell-client.js";
import { setUnread, setVersion, versionLabel } from "./version.js";
import {
  closeWhatsNew,
  configureWhatsNew,
  loadWhatsNew,
  openWhatsNew,
  setEntries,
} from "./whatsnew.js";
import { configureReport, openReport } from "./report.js";
import { showUpdate } from "./update-pill.js";
import { busyAction, configureBusy } from "./busy.js";

const state = {
  lang: "en",
  adapter: {},
  reportOff: false,
  pill: null,
};
const lang = () =>
  typeof state.lang === "function" ? state.lang() : state.lang;

export function configure(o = {}) {
  if (o.lang !== undefined) state.lang = o.lang;
  if (o.adapter) state.adapter = o.adapter;
  if (o.reportOff !== undefined) state.reportOff = !!o.reportOff;
  if (o.product) setProduct(o.product.name);
  const ad = state.adapter;
  configureWhatsNew({
    lang,
    changelog: ad.changelog || null,
    ...(o.whatsNew || {}),
  });
  const r = o.report || {};
  configureReport({ lang, adapter: ad, ...r });
  if (ad.request) configureBusy({ request: ad.request });
}

export function t(key, vars) {
  return kitT(lang(), key, vars);
}

export function strings(l, table) {
  addStrings(l, table);
}

export const version = {
  label: versionLabel,
  set: (label) => setVersion(label),
  unread: (on) => setUnread(on),
  /** 0.7.0: the update-waiting pill after the chip; null hides it. */
  waiting: (o) => setWaiting(o),
};

export const whatsNew = {
  open: openWhatsNew,
  close: closeWhatsNew,
  load: loadWhatsNew,
  setEntries,
};

export const update = {
  /** Shows the pill for a new version (Reload: adapter.applyUpdate()). */
  set(o = {}) {
    update.hide();
    state.pill = showUpdate({
      message: o.message ?? kitT(lang(), "kit.update.msg"),
      reloadLabel: o.reloadLabel ?? kitT(lang(), "kit.update.reload"),
      dismissLabel: o.dismissLabel ?? kitT(lang(), "kit.update.notNow"),
      cancelLabel: o.cancelLabel ?? kitT(lang(), "kit.update.cancel"),
      region: o.region ?? kitT(lang(), "kit.update.region"),
      askFirst: o.askFirst,
      onReload:
        o.onReload ||
        (() =>
          Promise.resolve(state.adapter.applyUpdate?.()).then(() =>
            location.reload(),
          )),
      onDismiss: () => {
        state.pill = null;
        o.onDismiss?.();
      },
    });
    return state.pill;
  },
  hide() {
    state.pill?.hide();
    state.pill = null;
  },
};

export const report = {
  open: (opts = {}) =>
    state.reportOff ? Promise.resolve(null) : openReport(opts),
  button: (o = {}) =>
    state.reportOff ? "" : reportButtonHtml({ ...o, lang: lang() }),
};

export const busy = {
  run: (action, run, opts) => busyAction(action, run, opts),
  configure: configureBusy,
};

/**
 * Binds the drawn shell, the chip and Report (see the top), and the 0.7.0
 * pieces it finds: the scope crumbs (opts.scope), the search
 * (opts.search: { onActivate }), the bell (opts.bell: { items, title,
 * empty, onOpen, … }), the account entry (opts.account: { onAction }) and
 * ◐ ▾ (opts.appearance: { menu, onPick }; .appearance on the shell).
 * The shell it returns has .scope, .search and .bell for those found.
 * false for any of them: not wired.
 */
export function hydrate(root, opts = {}) {
  const shell = hydrateShell(root, { lang, ...opts });
  if (opts.scope !== false && root.querySelector(".den-scope"))
    shell.scope = hydrateScope(root, opts.scope || {});
  const search = root.querySelector(".den-search");
  if (search && opts.search !== false)
    shell.search = hydrateSearch(search, opts.search || {});
  const bell = root.querySelector(".den-bell");
  if (bell && opts.bell !== false)
    shell.bell = hydrateBell(bell, { lang, ...(opts.bell || {}) });
  if (opts.account !== false) hydrateAccount(root, opts.account || {});
  const um = root.querySelector(".appearance-btn");
  if (um && opts.appearance)
    shell.appearance = hydrateAppearance(um, { lang, ...opts.appearance });
  const chip = root.querySelector("#version-pill");
  if (chip && opts.versionChip !== false)
    chip.addEventListener("click", () => whatsNew.open());
  if (opts.report !== false) {
    document.addEventListener("click", (e) => {
      const b =
        e.target && e.target.closest
          ? e.target.closest("[data-den-report]")
          : null;
      if (!b) return;
      e.preventDefault();
      const prefill = reportPrefillOf(b);
      void report.open(prefill ? { prefill, opener: b } : { opener: b });
    });
    // ⌘⇧F (Ctrl+Shift+F) opens Report from anywhere, over a dialog too.
    document.addEventListener(
      "keydown",
      (e) => {
        if (
          (e.metaKey || e.ctrlKey) &&
          e.shiftKey &&
          !e.altKey &&
          (e.key === "F" || e.key === "f" || e.code === "KeyF") &&
          !state.reportOff
        ) {
          e.preventDefault();
          void report.open();
        }
      },
      true,
    );
  }
  return shell;
}

export function mount(root, model = {}) {
  root.innerHTML = shellHtml({
    lang: lang(),
    report: !state.reportOff,
    ...model,
  });
  return hydrate(root, model.hydrate || {});
}

const DenUI = {
  configure,
  hydrate,
  mount,
  shellHtml,
  topBarHtml,
  railHtml,
  navItemHtml,
  versionChipHtml,
  reportButtonHtml,
  reportPrefillOf,
  scopeHtml,
  scopeCrumbHtml,
  searchHtml,
  bellButtonHtml,
  bellPanelHtml,
  accountHtml,
  settingsHtml,
  appearanceButtonHtml,
  appearanceMenuHtml,
  waitingHtml,
  hydrateAppearance,
  setWaiting,
  hydrateScope,
  hydrateSearch,
  hydrateBell,
  hydrateAccount,
  syncPinToggles,
  icon,
  esc,
  t,
  strings,
  version,
  whatsNew,
  update,
  report,
  busy,
};

if (typeof window !== "undefined") window.DenUI = DenUI;

export default DenUI;
