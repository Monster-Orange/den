/**
 * One terminal pane's connection to its session (GET
 * /api/sessions/<id>/io upgraded to a WebSocket), shared by every page
 * with a terminal: the Agents page and the __DEN_TITLE__ agent's page
 * (deep review 0.4.45: the two had drifted apart).
 *
 *   - binary frames are the session's output: written to the terminal;
 *     text frames are JSON, handed to the page (`onText`);
 *   - a close before the socket opened asks the route why with a plain
 *     GET: a 4xx is a refusal (sign in, not allowed, an ended or unknown
 *     session), shown with Reconnect. No answer is no refusal, and
 *     neither is 426: the route would take a socket (WebKit's first try
 *     after a restart can fail), nor 408 or 429: they are tried again;
 *   - 0.4.46: every other close reconnects on its own (pane-reconnect.js:
 *     backoff, a cap, quiet while the page is hidden). Back after a drop,
 *     the terminal is cleared first, since the server replays the screen;
 *   - a try that hasn't opened within `connectMs` (panes.
 *     connect_timeout_seconds, 10) is dropped and counts as a failure: a
 *     browser can leave a socket "connecting" for good while the server is
 *     down (WebKit behind a proxy did). Reconnect, shown again and online
 *     drop such a socket and start fresh;
 *   - leaving the page (pagehide) closes quietly; back from the
 *     back-forward cache, shown again, or back online: one try at once.
 *
 * The page keeps its own terminal and bar; this module never builds DOM.
 */
import { paneReconnect, reconnectOptions } from "/pane-reconnect.js";

const panes = new Set();
let wired = false;

/** Shown again, back from the cache, or online: each dropped pane tries. */
function wireWakeups() {
  if (wired) return;
  wired = true;
  const all = () => {
    for (const c of panes) c.nudge();
  };
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) all();
  });
  window.addEventListener("online", all);
  window.addEventListener("pagehide", () => {
    for (const c of panes) c.suspend();
  });
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    for (const c of panes) c.resume();
  });
}

/** panes.* from GET /api/settings (`panes_reconnect`), the defaults without. */
export async function paneSettings() {
  try {
    const r = await fetch("/api/settings", { headers: { accept: "json" } });
    const b = r.ok ? await r.json() : null;
    return reconnectOptions(b?.panes_reconnect);
  } catch {
    return reconnectOptions(undefined);
  }
}

/**
 * Why session `id`'s io upgrade was refused, in words, and whether it was
 * a refusal (a 4xx but 408, 426 and 429) or no answer (tried again). `words` gives the page's
 * strings: signin, refusedUnknown, refusedStatus(status), notAnswering.
 */
export async function refusalOf(id, words, timeoutMs = 10_000) {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/io`, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const refused =
      r.status >= 400 && r.status < 500 && ![408, 426, 429].includes(r.status);
    if (r.status === 401) return { refused, why: words.signin() };
    const b = await r.json().catch(() => null);
    if (r.status === 426) return { refused, why: words.refusedUnknown() };
    if (typeof b?.error === "string" && b.error)
      return { refused, why: b.error };
    return { refused, why: words.refusedStatus(r.status) };
  } catch {
    return { refused: false, why: words.notAnswering() };
  }
}

/**
 * The pane's connection. Options:
 *   id        the session id
 *   term      () => the xterm Terminal (written to, cleared on a re-open)
 *   csrf      (fresh) => the CSRF token (fresh after a drop: a restarted
 *             server may hold a new one)
 *   settings  reconnectOptions(...) (paneSettings())
 *   words     the strings refusalOf needs
 *   paint     (state) => the page shows it: {kind, tries, why}, kind
 *             live | quiet | retrying | tripped | refused
 *   onOpen    (sock, again) => the socket opened (again: after a drop)
 *   onText    (msg) => a JSON text frame
 *   onClose   ({opened, refused, why}) => after a close, before the retry
 * Returns {connect, retry, nudge, stop, suspend, resume, sock, state}.
 */
export function termPane(o) {
  let sock = null;
  let stopped = false;
  let suspended = false;
  let everOpened = false;
  let opening = false;
  let timer = null;
  const settings = o.settings ?? reconnectOptions(undefined);
  const connectMs = settings.connectMs ?? 10_000;
  const rc = paneReconnect({
    connect: () => void open(),
    paint: (s) => o.paint?.(s),
    hidden: () => document.hidden,
    ...settings,
  });
  /** The token, or null when it doesn't come within connectMs. */
  const token = () =>
    Promise.race([
      Promise.resolve(o.csrf(everOpened)).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), connectMs)),
    ]);
  /** A socket still connecting: dropped, so a fresh try can start. */
  function dropConnecting() {
    if (sock?.readyState !== WebSocket.CONNECTING) return;
    const s = sock;
    sock = null;
    clearTimeout(timer);
    s.onclose = null;
    s.onopen = null;
    s.onmessage = null;
    try {
      s.close();
    } catch {
      /* never opened */
    }
  }
  async function open() {
    if (stopped || suspended || sock || opening) return;
    opening = true;
    let tok;
    try {
      tok = await token();
    } finally {
      opening = false;
    }
    if (stopped || suspended || sock) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let s;
    try {
      s = new WebSocket(
        `${proto}//${location.host}/api/sessions/${encodeURIComponent(o.id)}/io`,
        ["den.io", `den.csrf.${tok ?? ""}`],
      );
    } catch (err) {
      rc.closed({ opened: false, why: err?.message ?? "error" });
      return;
    }
    s.binaryType = "arraybuffer";
    sock = s;
    let opened = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (opened || sock !== s) return;
      dropConnecting();
      if (stopped || suspended) return;
      const why = o.words.notAnswering();
      o.onClose?.({ opened: false, refused: false, why });
      rc.closed({ opened: false, why });
    }, connectMs);
    s.onopen = () => {
      // A socket dropped while it connected may open late: never used.
      if (sock !== s) {
        try {
          s.close();
        } catch {
          /* closing */
        }
        return;
      }
      opened = true;
      clearTimeout(timer);
      const again = everOpened;
      // Back after a drop: the server replays the screen, so start clean.
      if (again) o.term()?.reset();
      everOpened = true;
      rc.opened();
      o.onOpen?.(s, again);
    };
    s.onmessage = (e) => {
      if (sock !== s) return;
      if (typeof e.data === "string") {
        let msg = null;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        o.onText?.(msg);
        return;
      }
      o.term()?.write(new Uint8Array(e.data));
    };
    s.onclose = async (e) => {
      if (sock !== s) return;
      sock = null;
      clearTimeout(timer);
      if (stopped || suspended) return;
      let why = e.reason || String(e.code);
      let refused = false;
      if (!opened) {
        ({ why, refused } = await refusalOf(o.id, o.words, connectMs));
        if (stopped || sock) return;
      }
      o.onClose?.({ opened, refused, why });
      rc.closed({ opened, refused, why });
    };
  }
  const c = {
    connect: open,
    /** The person's Reconnect. */
    retry() {
      dropConnecting();
      rc.retry();
    },
    nudge() {
      if (stopped || suspended) return;
      dropConnecting();
      if (sock || rc.state.kind === "refused") return;
      rc.nudge();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      rc.stop();
      panes.delete(c);
      try {
        sock?.close();
      } catch {
        /* already closed */
      }
      sock = null;
    },
    suspend() {
      suspended = true;
      try {
        sock?.close(1000, "page closed");
      } catch {
        /* already closed */
      }
    },
    resume() {
      suspended = false;
      dropConnecting();
      if (!sock) rc.nudge();
    },
    get sock() {
      return sock;
    },
    get state() {
      return rc.state;
    },
  };
  panes.add(c);
  wireWakeups();
  return c;
}
