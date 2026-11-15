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
 * Callers pass words already in the page's language (denShell.t).
 */
import {
  askConfirm as kitConfirm,
  askText as kitText,
  configureDialog,
  tell as kitTell,
} from "/kit/dialog.js";

const sh = () => window.denShell;
const t = (key, vars) => sh()?.t?.(key, vars) ?? key;

/** Den's words in the page's language, and its Report, each time. */
function setUp() {
  const lang = sh()?.lang?.() || "en";
  configureDialog({
    lang: () => lang,
    words: { [lang]: { ok: t("dlg.ok"), cancel: t("dlg.cancel") } },
    report: () => sh()?.reportButton?.(true) ?? "",
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
