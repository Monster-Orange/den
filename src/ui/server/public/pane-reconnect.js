/**
 * 0.4.46: a terminal pane whose socket closed reconnects on its own.
 *
 * The agents keep running in the sessions host when the web server
 * restarts, the laptop sleeps, the network changes, or a tablet's browser
 * drops the socket of a tab in the background. So a pane never waits for
 * a click unless it must:
 *
 *   - a close after the socket had opened: try again after `baseMs`;
 *   - a try that fails (it never opened, and was no refusal): one failure;
 *     the next try waits twice as long, up to `maxMs`;
 *   - `maxFailures` failures within `windowMs`: stop ("tripped"). The pane
 *     says how many tries, with a Reconnect button and the last reason;
 *   - a refusal (sign in, an upgrade the server refused, an ended
 *     session): stop at once, with the button;
 *   - a close while the page is hidden: quiet, counted apart, never
 *     toward the cap. It reconnects when the page is shown again;
 *   - the page shown again, restored from the back-forward cache, or the
 *     browser back online: one try at once, even after the cap tripped;
 *   - a socket that opens clears the count.
 *
 * A try that succeeds within `quietMs` shows nothing ("Reconnecting…"
 * only after it), so a return to the tab never flashes.
 *
 * No DOM here: the page wires `connect` and `paint`; the clock and the
 * timers are passed in so the rules are tested without a browser.
 */

/** The defaults: user.yml panes.* (GET /api/settings panes_reconnect). */
export const PANE_RECONNECT_DEFAULTS = Object.freeze({
  seconds: 1,
  max_seconds: 30,
  max_failures: 10,
  window_seconds: 300,
  connect_timeout_seconds: 10,
});

/** The settings from GET /api/settings, the defaults for what's missing. */
export function reconnectOptions(s) {
  const d = PANE_RECONNECT_DEFAULTS;
  const n = (v, dv, min) =>
    typeof v === "number" && Number.isFinite(v) && v >= min ? v : dv;
  const seconds = n(s?.seconds, d.seconds, 0.1);
  return {
    baseMs: seconds * 1000,
    maxMs: Math.max(seconds, n(s?.max_seconds, d.max_seconds, 0.1)) * 1000,
    maxFailures: Math.round(n(s?.max_failures, d.max_failures, 1)),
    windowMs: n(s?.window_seconds, d.window_seconds, 1) * 1000,
    connectMs:
      n(s?.connect_timeout_seconds, d.connect_timeout_seconds, 1) * 1000,
  };
}

/**
 * One pane's reconnects. `connect()` opens a new socket; the page calls
 * `opened()`, `closed({opened, refused, why})` from its socket, and
 * `nudge()` on visible, pageshow and online. `paint(state)` gets
 * {kind: "live"|"quiet"|"retrying"|"tripped"|"refused", tries, why}.
 */
export function paneReconnect({
  connect,
  paint = () => {},
  hidden = () => false,
  now = () => Date.now(),
  setTimer = (f, ms) => setTimeout(f, ms),
  clearTimer = (h) => clearTimeout(h),
  baseMs = 1000,
  maxMs = 30_000,
  maxFailures = 10,
  windowMs = 300_000,
  quietMs = 1000,
}) {
  const s = {
    failures: [],
    streak: 0,
    hiddenCloses: 0,
    kind: "live",
    why: "",
    timer: null,
    quietTimer: null,
    stopped: false,
  };
  const recent = () => {
    const t = now();
    s.failures = s.failures.filter((at) => t - at < windowMs);
    return s.failures.length;
  };
  const show = (kind) => {
    s.kind = kind;
    paint({ kind, tries: recent(), why: s.why });
  };
  const cancel = () => {
    if (s.timer) clearTimer(s.timer);
    if (s.quietTimer) clearTimer(s.quietTimer);
    s.timer = s.quietTimer = null;
  };
  const tryNow = () => {
    cancel();
    if (s.stopped) return;
    // Quiet first: "Reconnecting…" only if the try takes longer.
    if (s.kind !== "retrying") s.kind = "quiet";
    s.quietTimer = setTimer(() => {
      s.quietTimer = null;
      if (s.kind === "quiet") show("retrying");
    }, quietMs);
    connect();
  };
  const later = (ms) => {
    cancel();
    if (s.kind !== "retrying") show("retrying");
    s.timer = setTimer(() => {
      s.timer = null;
      tryNow();
    }, ms);
  };
  return {
    get state() {
      return {
        kind: s.kind,
        tries: recent(),
        streak: s.streak,
        hiddenCloses: s.hiddenCloses,
      };
    },
    opened() {
      cancel();
      s.failures = [];
      s.streak = 0;
      s.why = "";
      show("live");
    },
    closed({ opened = false, refused = false, why = "" } = {}) {
      if (s.stopped) return;
      cancel();
      s.why = why || s.why;
      if (refused) return show("refused");
      if (hidden()) {
        // A tablet drops a background tab's socket: normal, no message.
        s.hiddenCloses++;
        s.kind = "quiet";
        return;
      }
      if (opened) {
        s.streak = 0;
        return later(baseMs);
      }
      s.failures.push(now());
      s.streak++;
      if (recent() >= maxFailures) return show("tripped");
      later(Math.min(maxMs, baseMs * 2 ** s.streak));
    },
    /** Visible again, back from the cache, or online: one try at once. */
    nudge() {
      if (s.stopped || s.kind === "live" || s.kind === "refused") return;
      tryNow();
    },
    /** The person's Reconnect: a fresh start. */
    retry() {
      s.failures = [];
      s.streak = 0;
      tryNow();
    },
    stop() {
      s.stopped = true;
      cancel();
    },
  };
}
