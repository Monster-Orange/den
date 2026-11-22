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

/**
 * Issue 310: where a device signed in from, as a place, never its address
 * (the approved mock shows "Local network"): this computer (loopback), the
 * local network (private, link-local, a VPN's 100.64/10, IPv6 ULA and
 * link-local), else nothing. An address on screen is a person's IP.
 */
export function placeOf(client, tr = L) {
  let a = String(client ?? "")
    .trim()
    .toLowerCase();
  if (!a) return "";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const here = () => tr("acct.thisComputer", "This computer");
  const lan = () => tr("acct.localNetwork", "Local network");
  if (a === "::1" || a === "localhost") return here();
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (v4) {
    const [x, y] = [Number(v4[1]), Number(v4[2])];
    if (x === 127) return here();
    if (
      x === 10 ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 169 && y === 254) ||
      (x === 100 && y >= 64 && y <= 127)
    )
      return lan();
    return "";
  }
  if (/^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a))
    return lan();
  return "";
}
