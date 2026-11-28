/**
 * issue 133: Den on the kit's ask-and-tell dialogs (/kit/dialog.js), in place
 * of the browser's confirm(), prompt() and alert(). The kit's OK and Cancel
 * come from Den's catalogs (shell.js, i18n/es.js, i18n/ja.js), and the
 * Report button sits in each dialog's footer (denShell.reportButton).
 *
 *   askConfirm(opts) → Promise<boolean>
 *   askText(opts)    → Promise<string|null>
 *   tell(opts)       → Promise<void>
 *
 * Issues 669, 670: Den's own Yes/No questions and large dialogs are the
 * kit's frame too, never a dialog of Den's own:
 *
 *   dialogHtml(spec)          the kit's, as it is (the second product
 *                             calls the same on its server)
 *   mountDialog(html, opts)   the kit's, with Den's words and Report
 *
 * Callers pass words already in the page's language (denShell.t).
 */
import {
  askConfirm as kitConfirm,
  askText as kitText,
  configureDialog,
  dialogHtml,
  holdOpen,
  mountDialog as kitMount,
  tell as kitTell,
} from "/kit/dialog.js";

export { dialogHtml, holdOpen };

const sh = () => window.denShell;
const t = (key, vars) => sh()?.t?.(key, vars) ?? key;

/** Den's words in the page's language, and its Report, each time. */
function setUp() {
  const lang = sh()?.lang?.() || "en";
  configureDialog({
    lang: () => lang,
    words: {
      [lang]: {
        ok: t("dlg.ok"),
        cancel: t("dlg.cancel"),
        close: t("dlg.close"),
      },
    },
    report: () => sh()?.reportButton?.(true) ?? "",
    // Issue 1054: a dialog's own button that sends shows the kit's dots.
    hold: (b) => sh()?.holdDots?.(b),
  });
}

export function askConfirm(opts) {
  setUp();
  return kitConfirm(opts);
}

export function askText(opts) {
  setUp();
  return kitText(opts);
}

export function tell(opts) {
  setUp();
  return kitTell(opts);
}

/** The kit's frame on the page, with Den's words and Report. */
export function mountDialog(target, opts) {
  setUp();
  return kitMount(target, opts);
}
