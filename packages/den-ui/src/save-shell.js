/**
 * den-ui 0.7.5 (issue 394): a rail change saved so that leaving the page
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
 * - Answers true when the server said ok, else false (never throws). A
 *   save handed to a beacon answers whether the browser queued it.
 */
export function saveShell(url, patch, opts = {}) {
  const changedAt =
    typeof opts.changedAt === "number" && Number.isFinite(opts.changedAt)
      ? opts.changedAt
      : Date.now();
  const body = JSON.stringify({ shell: { ...(patch || {}), changedAt } });
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
    (r) => done(!!r && r.ok !== false),
    () => {
      // Cancelled as the page went: the beacon is the save.
      const hidden = doc && doc.visibilityState === "hidden";
      if (hidden) beacon();
      return done(beaconed ? beaconQueued : false);
    },
  );
}
