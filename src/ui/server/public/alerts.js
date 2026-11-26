/**
 * Issue 172: alerts outside the bell, from an open Den tab. The tab
 * reads GET /api/alerts every few seconds, even in the background, and
 * shows each new alert as a desktop notification when the tab isn't in
 * front. A click brings the tab up on the agent's page. The server
 * decides what alerts (a new need; issue 774: a finished turn, when the
 * person turned it on; never a muted agent, never in quiet hours), in
 * the bell's words; the page shows it as given: the words as the
 * heading, the project under them.
 *
 * Issue 774, browser side only:
 *   - a short sound with each alert, when the person turned sounds on
 *     (alert-sounds.js): one for "needs you", a softer one for
 *     "finished"; it plays even when the browser can't notify;
 *   - the count of agents that need the person, in the tab's title and
 *     on its icon (tab-count.js), when "Count in the tab" is on.
 *   alertPlan says what one alert does in this tab (the mock's table of
 *   when it stays quiet).
 *
 * No double alert: each alert is claimed once per browser (two tabs show
 * one notification and play one sound). The tab in front claims at once;
 * a tab behind waits a moment, so the one in front wins. The alert's id
 * is the notification's tag. A browser that gets push (a service worker
 * subscription) leaves the notification to the push; its tab still
 * plays the sound. Issue 774 row 7b: unless the tab shows: then the
 * server streams the alert to it first (alertStream) and the push waits.
 */
import { playAlertSound, primeAlertSounds } from "./alert-sounds.js";
import { tabCount } from "./tab-count.js";

const POLL_MS = 5000;
const CLAIMED = "den-alerts-shown";
/** A tab behind waits this long before it claims, so the one in front wins. */
const BEHIND_WAIT_MS = 1500;

/** Only Den's own pages: an alert's link. */
export const alertLink = (l) =>
  typeof l === "string" && /^\/(?!\/)/.test(l) ? l : "/agents";

/** True the first time this browser sees alert `id` (two tabs: one shows it). */
function claim(win, id) {
  try {
    const seen = JSON.parse(win.localStorage.getItem(CLAIMED) || "[]");
    if (seen.includes(id)) return false;
    seen.push(id);
    win.localStorage.setItem(CLAIMED, JSON.stringify(seen.slice(-100)));
  } catch {
    /* no storage: the tag still folds two into one */
  }
  return true;
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
  // Issue 774: the words are the heading, the project the line under it.
  const n = new win.Notification(a.body || a.title || "", {
    body: a.project || "",
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

/**
 * Issue 774: what alert `a` does in this tab: { notify, sound } (sound
 * "needs", "finished" or null). `prefs`: the person's switches
 * ({desktop, sound}); `env`: this tab now ({front, permission ("granted",
 * "denied", "default" or "unsupported"), pushed, agent: the agent this
 * page shows, or null}).
 */
export function alertPlan(a, prefs, env) {
  // Looking at that agent: nothing (its page says it).
  if (env.front && env.agent && env.agent === a.agent)
    return { notify: false, sound: null };
  const notify =
    !env.front &&
    prefs.desktop !== false &&
    env.permission === "granted" &&
    !env.pushed;
  const sound =
    prefs.sound === true ? (a.why === "finished" ? "finished" : "needs") : null;
  return { notify, sound };
}

/**
 * Issue 774: alert `a` in this tab, once per browser. `deps`: { show(a),
 * play(kind), wait(ms) } (the page's own, or a test's).
 */
export async function deliverAlert(win, a, prefs, env, deps) {
  if (!a?.id) return null;
  if (!env.front) await deps.wait(BEHIND_WAIT_MS);
  // The tab in front claims even when it does nothing: a tab behind then
  // shows no notification for what the person sees already.
  if (!claim(win, a.id)) return null;
  const plan = alertPlan(a, prefs, env);
  if (plan.notify) {
    try {
      deps.show(a);
    } catch {
      /* the bell has it */
    }
  }
  if (plan.sound) {
    try {
      deps.play(plan.sound);
    } catch {
      /* no sound: the bell has it */
    }
  }
  // What this tab did (null: another tab of this browser has it).
  return plan;
}

/** This tab now: { front, permission, pushed, agent } (alertPlan's env). */
function tabEnv(win) {
  const doc = win.document;
  const N = win.Notification;
  return {
    front: doc?.visibilityState === "visible" && !!doc?.hasFocus?.(),
    permission: typeof N === "function" ? N.permission : "unsupported",
    pushed: false,
    agent: pageAgent(win),
  };
}

/**
 * Issue 774 row 7b: this tab's alert stream (GET /api/alerts/stream).
 * The server names the tab; the tab says which device it is (this
 * browser's push subscription's endpoint, in the body) and whether it
 * shows. An alert streamed here is this device's: its push waits, so the
 * tab shows it itself and acks it. `o`: { prefs() (the person's switches,
 * from the last poll), deps (deliverAlert's), post(path, body) }.
 */
export function alertStream(win, o) {
  let tab = "";
  const presence = async () => {
    if (!tab) return;
    const sub = await pushSubscription(win);
    await o.post("/api/alerts/presence", {
      tab,
      endpoint: sub?.endpoint || null,
      visible: win.document?.visibilityState === "visible",
    });
  };
  const onEvent = async (e) => {
    if (e?.type === "tab" && typeof e.tab === "string") {
      tab = e.tab;
      await presence();
    } else if (e?.type === "drop" && typeof e.id === "string") {
      // Another tab of this device showed it: never here too.
      claim(win, e.id);
    } else if (e?.type === "alert" && tab && e.alert?.id) {
      const env = tabEnv(win);
      const plan = await deliverAlert(win, e.alert, o.prefs(), env, o.deps);
      // Ack only what reached the person here: otherwise the push goes.
      if (plan && (plan.notify || plan.sound || env.front))
        await o.post("/api/alerts/ack", { tab, id: e.alert.id });
    }
  };
  return { onEvent, presence };
}

/**
 * The agent this page shows, or null: the Agents page's session in front
 * (?front=, else its one ?open=), as its list row's agent id (an alert
 * names the agent, the address names the session).
 */
export function pageAgent(win) {
  try {
    const u = new URL(win.location.href);
    if (u.pathname !== "/agents") return null;
    const open = (u.searchParams.get("open") ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const sid =
      u.searchParams.get("front") || (open.length === 1 ? open[0] : "");
    if (!sid) return null;
    const row = win.document?.querySelector?.(
      `#agl button[data-id="${String(sid).replace(/["\\]/g, "\\$&")}"]`,
    );
    return row?.closest?.("[data-agent]")?.dataset?.agent || null;
  } catch {
    return null;
  }
}

/** Start reading alerts on this page (every page with the header). */
export function initAlerts(win = window) {
  const doc = win.document;
  if (!doc) return;
  // SEC-1b: a refusal page (421, signed out) makes no /api call.
  if (win.denShell?.apiOff?.() === true) return;
  const tab = tabCount(win);
  let seq = null;
  let busy = false;
  let primed = false;
  const deps = {
    show: (a) => showAlert(win, a),
    play: (kind) => playAlertSound(win, kind),
    wait: (ms) => new Promise((r) => win.setTimeout(r, ms)),
  };
  let lastPrefs = { desktop: true, sound: false, tab_count: true };
  // Issue 774 row 7b: the stream, only where this browser has a push
  // subscription (or once it subscribes here). Without one there is no
  // push for this tab to beat, and the poll shows the alerts: a page's
  // load opens nothing and writes nothing (R21).
  let streaming = false;
  const openStream = () => {
    if (streaming) return;
    streaming = true;
    const post = async (path, body) => {
      try {
        const r = await win.fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return r.ok;
      } catch {
        return false;
      }
    };
    const st = alertStream(win, { prefs: () => lastPrefs, deps, post });
    const es = new win.EventSource("/api/alerts/stream");
    es.onmessage = (m) => {
      try {
        void st.onEvent(JSON.parse(m.data));
      } catch {
        /* not ours */
      }
    };
    doc.addEventListener("visibilitychange", () => void st.presence());
    win.addEventListener("pagehide", () => es.close());
  };
  if (typeof win.EventSource === "function" && pushSupported(win)) {
    void pushSubscription(win).then((sub) => {
      if (sub) openStream();
    });
    win.addEventListener("den:push-on", openStream);
  }
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await win.fetch(
        "/api/alerts" + (seq === null ? "" : `?after=${seq}`),
        { headers: { accept: "application/json" }, cache: "no-store" },
      );
      if (!r.ok) return;
      const b = await r.json();
      const prefs = b.prefs || { desktop: true, sound: false, tab_count: true };
      lastPrefs = prefs;
      // Issue 774: the count, quiet hours or not; zero shows nothing.
      tab.show(prefs.tab_count === false ? 0 : Number(b.count) || 0);
      if (prefs.sound && !primed) {
        primed = true;
        primeAlertSounds(win);
      }
      const first = seq === null;
      seq = typeof b.seq === "number" ? b.seq : seq;
      const list = Array.isArray(b.alerts) ? b.alerts : [];
      if (first || !list.length) return;
      const env = tabEnv(win);
      if (env.permission === "granted") env.pushed = await pushed(win);
      for (const a of list) void deliverAlert(win, a, prefs, env, deps);
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
  // Issue 774 row 7b: this page's alert stream opens now (initAlerts).
  try {
    win.dispatchEvent(new win.Event("den:push-on"));
  } catch {
    /* the next page opens it */
  }
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
