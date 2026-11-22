/**
 * 0.4.45: a device's name (the server's English: "Chrome on Linux", "A
 * browser on macOS", "Unknown browser") in the page's words; the browser's
 * and the system's names stay as they are. Its own file (issue 310) so the
 * Account area (account-den.js) and Settings (settings-registry.js) share
 * it without loading each other.
 */

/** A built-in word in the page's language (denShell.tr), else `en`. */
function L(key, en, vars) {
  const sh = typeof window !== "undefined" ? window.denShell : null;
  const s = sh && typeof sh.tr === "function" ? sh.tr(key, en) : en;
  return String(s).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}

export function deviceWords(name, tr = L) {
  const s = String(name ?? "").trim();
  if (!s || s === "Unknown browser")
    return tr("set.ui.unknownBrowser", "Unknown browser");
  const any = /^A browser on (.+)$/.exec(s);
  if (any) return tr("set.ui.aBrowserOn", "A browser on {os}", { os: any[1] });
  const on = /^(.+?) on (.+)$/.exec(s);
  if (on)
    return tr("set.ui.deviceOn", "{browser} on {os}", {
      browser: on[1],
      os: on[2],
    });
  return s;
}
