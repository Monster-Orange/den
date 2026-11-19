/**
 * Issue 172: alerts outside the bell, from an open Den tab. While the
 * browser lets this page notify (Settings › Notifications › Desktop
 * alerts asks it), the tab reads GET /api/alerts every few seconds, even
 * in the background, and shows each new alert as a desktop notification
 * when the tab isn't in front. A click brings the tab up on the agent's
 * page. The server decides what alerts (a new need only), in the bell's
 * words; the page shows it as given.
 *
 * Two tabs show one: each alert is claimed once per browser, and its id
 * is the notification's tag. A browser that gets push (a service worker
 * subscription) leaves it to the push. The rules (what counts, when it
 * stays quiet, one per item, the words) are alert-rules.js.
 */

import { alertLink, claimAlert, quietInFront } from "./alert-rules.js";

const POLL_MS = 5000;

/** Only Den's own pages: an alert's link (alert-rules.js). */
export { alertLink };

/** This browser's storage, or null when it can't be reached. */
function storageOf(win) {
  try {
    return win.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether this browser gets alerts by push already (issue 172 S2). */
async function pushed(win) {
  try {
    const reg = await win.navigator.serviceWorker?.getRegistration?.("/");
    return !!(reg && (await reg.pushManager?.getSubscription?.()));
  } catch {
    return false;
  }
}

/** Show `a` as a notification; a click opens its page in this tab. */
export function showAlert(win, a) {
  const n = new win.Notification(a.title || "", {
    body: a.body || "",
    tag: a.id,
  });
  n.onclick = () => {
    try {
      win.focus();
      n.close?.();
    } catch {
      /* the page still opens */
    }
    win.location.assign(alertLink(a.link));
  };
  return n;
}

/** Start reading alerts on this page (every page with the header). */
export function initAlerts(win = window) {
  const doc = win.document;
  if (!doc || typeof win.Notification !== "function") return;
  // SEC-1b: a refusal page (421, signed out) makes no /api call.
  if (win.denShell?.apiOff?.() === true) return;
  let seq = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    if (win.Notification.permission !== "granted") {
      seq = null; // allowed later: start from then
      return;
    }
    busy = true;
    try {
      const r = await win.fetch(
        "/api/alerts" + (seq === null ? "" : `?after=${seq}`),
        { headers: { accept: "application/json" }, cache: "no-store" },
      );
      if (!r.ok) return;
      const b = await r.json();
      const first = seq === null;
      seq = typeof b.seq === "number" ? b.seq : seq;
      const list = Array.isArray(b.alerts) ? b.alerts : [];
      if (first || !list.length) return;
      // In front: the bell and the Allow dialog already say it.
      if (quietInFront(doc)) return;
      if (await pushed(win)) return;
      for (const a of list)
        if (a?.id && claimAlert(storageOf(win), a.id)) showAlert(win, a);
    } catch {
      /* next tick */
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = win.setInterval(() => void tick(), POLL_MS);
  win.addEventListener("pagehide", () => win.clearInterval(timer));
}

// ── S2: push, for a phone or a closed tab ─────────────────────────────
// The device subscribes with this install's public key (VAPID) through
// its service worker (/den-sw.js); the server keeps the subscription and
// pushes each alert, encrypted for the device (web-push.ts).

/** Whether this browser can get push at all (an iPhone: from its home screen). */
export function pushSupported(win = window) {
  return (
    !!win.navigator?.serviceWorker &&
    typeof win.PushManager === "function" &&
    typeof win.Notification === "function"
  );
}

/** This browser's push subscription, or null. */
export async function pushSubscription(win = window) {
  try {
    const reg = await win.navigator.serviceWorker?.getRegistration?.("/");
    return (await reg?.pushManager?.getSubscription?.()) || null;
  } catch {
    return null;
  }
}

const keyBytes = (b64u) => {
  const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/**
 * Subscribe this browser: the browser's permission, the service worker,
 * the subscription, then the server keeps it. "ok", "denied" or
 * "unsupported"; throws on a server refusal. `api` reads; `send(path,
 * body)` writes, through the page's working pop-up (BUSY-1), and
 * resolves with the answer's data or null when it didn't succeed.
 */
export async function pushOn(api, send, win = window) {
  if (!pushSupported(win)) return "unsupported";
  if (win.Notification.permission !== "granted") {
    const p = await win.Notification.requestPermission();
    if (p !== "granted") return "denied";
  }
  const nav = win.navigator.serviceWorker;
  await nav.register("/den-sw.js", { scope: "/" });
  const reg = await nav.ready;
  const { publicKey } = await api("GET", "/api/alerts/push-key");
  const sub =
    (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  const kept = await send("/api/alerts/subscribe", {
    subscription: typeof sub.toJSON === "function" ? sub.toJSON() : sub,
  });
  if (!kept) throw new Error("subscribe refused");
  return "ok";
}

/** Stop push to this browser (other devices keep theirs); `send` as pushOn's. */
export async function pushOff(send, win = window) {
  const sub = await pushSubscription(win);
  if (!sub) return;
  try {
    await sub.unsubscribe?.();
  } finally {
    await send("/api/alerts/unsubscribe", { endpoint: sub.endpoint });
  }
}
