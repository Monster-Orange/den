/**
 * den-ui 0.10.0 (issue 394): a rail change saved so that leaving the page
 * can't lose it. A pin, an unpin, collapse, an order or the dock is saved
 * as the person goes on clicking; a plain fetch is cancelled when the page
 * unloads, and the next page then shows the server's older copy.
 *
 *   saveShell(url, patch, { headers?, changedAt? }) → Promise<boolean>
 *
 * - POSTs { shell: { ...patch, changedAt } } as JSON with keepalive, so the
 *   request outlives the page. changedAt is when the change was made (ms;
 *   now unless given): the server keeps the newer of two saves of a key.
 * - If the page hides or unloads (pagehide, or visibilitychange to hidden)
 *   before the save is confirmed, it is sent again with
 *   navigator.sendBeacon, a Blob of the same JSON: some browsers drop a
 *   keepalive request as a page goes. A beacon carries no custom header
 *   (headers are for the fetch only), so the host's server accepts the
 *   beacon form for its shell save on the request's Origin. The same
 *   changedAt rides both, so a save that arrives twice is stored once.
 * - A body over KEEPALIVE_MAX_BYTES (64 KB: browsers refuse a bigger
 *   keepalive fetch or beacon) goes as a plain fetch instead, as a save
 *   did before: it can still be lost as the page goes, but never refused.
 * - Answers true when the server said ok, else false (never throws). A
 *   save handed to a beacon answers whether the browser queued it.
 */
export const KEEPALIVE_MAX_BYTES = 64 * 1024;

/**
 * den-ui 0.11.0 (issue 394): a save no answer came back for. The page
 * that made it may be gone before the server answers, and the next page
 * may read the server's copy before the save lands. With
 * `opts.pending = { storage, key, who }`, saveShell keeps each key's value
 * and time in `storage` until any answer comes back (saved or refused:
 * either way the server has decided), and pendingOver lays what is still
 * kept over the server's copy, so that page doesn't show the old value.
 *
 * An entry is dropped, never laid over, when it is older than maxAgeMs
 * (PENDING_MAX_AGE_MS unless the page gives its setting), when the server has a newer save of its key (another
 * device's: `stamps`, the server's per-key times), or when it was made by
 * someone else (`who`, when both are known).
 */
export const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

function readPending(store) {
  try {
    const v = JSON.parse(store.storage.getItem(store.key) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function writePending(store, v) {
  try {
    if (Object.keys(v).length)
      store.storage.setItem(store.key, JSON.stringify(v));
    else store.storage.removeItem(store.key);
  } catch {
    /* a convenience only */
  }
}
function notePending(store, patch, at) {
  const v = readPending(store);
  for (const k of Object.keys(patch || {}))
    v[k] = { value: patch[k], at, who: store.who ?? null };
  writePending(store, v);
}
function settlePending(store, patch, at) {
  const v = readPending(store);
  for (const k of Object.keys(patch || {})) if (v[k]?.at === at) delete v[k];
  writePending(store, v);
}

/**
 * The server's shell block with this browser's unanswered saves over it,
 * and the saves to send again (each with its own time, so the server
 * stores a repeat once). Entries that may not be laid over are removed.
 */
export function pendingOver(
  store,
  shell,
  stamps,
  now = Date.now(),
  maxAgeMs = PENDING_MAX_AGE_MS,
) {
  const v = readPending(store);
  const out = { ...(shell || {}) };
  const resend = [];
  let changed = false;
  for (const [k, e] of Object.entries(v)) {
    const at = e && typeof e.at === "number" ? e.at : NaN;
    const theirs = stamps && typeof stamps[k] === "number" ? stamps[k] : -1;
    const stale =
      !Number.isFinite(at) ||
      now - at > maxAgeMs ||
      at > now + maxAgeMs ||
      theirs >= at ||
      // Once the page knows who is signed in, only that person's saves:
      // one made before anyone was known can't be told apart, so it goes.
      (store.who != null && e.who !== store.who);
    if (stale) {
      delete v[k];
      changed = true;
      continue;
    }
    out[k] = e.value;
    resend.push({ patch: { [k]: e.value }, at });
  }
  if (changed) writePending(store, v);
  return { shell: out, resend };
}

/** A string's size in UTF-8 bytes (an upper bound without TextEncoder). */
function byteSize(s) {
  if (typeof TextEncoder === "function")
    return new TextEncoder().encode(s).length;
  return s.length * 3;
}

export function saveShell(url, patch, opts = {}) {
  const changedAt =
    typeof opts.changedAt === "number" && Number.isFinite(opts.changedAt)
      ? opts.changedAt
      : Date.now();
  const body = JSON.stringify({ shell: { ...(patch || {}), changedAt } });
  const store =
    opts.pending && opts.pending.storage && opts.pending.key
      ? opts.pending
      : null;
  if (store) notePending(store, patch, changedAt);
  /** The server answered (saved or refused): nothing is left to keep. */
  const answered = (r) => {
    if (store && r) settlePending(store, patch, changedAt);
    return !!r && r.ok !== false;
  };
  const win = typeof window !== "undefined" ? window : null;
  const doc = typeof document !== "undefined" ? document : null;
  let settled = false;
  let beaconed = false;
  let beaconQueued = false;

  const beacon = () => {
    if (settled || beaconed) return;
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (!nav || typeof nav.sendBeacon !== "function") return;
    beaconed = true;
    try {
      beaconQueued = nav.sendBeacon(
        url,
        new Blob([body], { type: "application/json" }),
      );
    } catch {
      beaconQueued = false;
    }
  };
  const onHide = () => beacon();
  const onVisibility = () => {
    if (doc && doc.visibilityState === "hidden") beacon();
  };
  const listen = (on) => {
    const m = on ? "addEventListener" : "removeEventListener";
    if (win && typeof win[m] === "function") win[m]("pagehide", onHide);
    if (doc && typeof doc[m] === "function")
      doc[m]("visibilitychange", onVisibility);
  };
  const done = (ok) => {
    settled = true;
    listen(false);
    return ok;
  };

  if (byteSize(body) > KEEPALIVE_MAX_BYTES) {
    if (typeof fetch !== "function") return Promise.resolve(false);
    let plain;
    try {
      plain = fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.headers || {}),
        },
        body,
      });
    } catch (e) {
      plain = Promise.reject(e);
    }
    return Promise.resolve(plain).then(answered, () => false);
  }
  if (typeof fetch !== "function") {
    beacon();
    return Promise.resolve(done(beaconQueued));
  }
  listen(true);
  // Hidden already (a save made as the page goes): the beacon now too.
  if (doc && doc.visibilityState === "hidden") beacon();
  let sent;
  try {
    sent = fetch(url, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      body,
    });
  } catch (e) {
    sent = Promise.reject(e);
  }
  return Promise.resolve(sent).then(
    (r) => done(answered(r)),
    () => {
      // Cancelled as the page went: the beacon is the save.
      const hidden = doc && doc.visibilityState === "hidden";
      if (hidden) beacon();
      return done(beaconed ? beaconQueued : false);
    },
  );
}
