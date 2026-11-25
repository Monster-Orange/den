/**
 * A slow terminal socket, for a page's init script: every WebSocket to a
 * URL ending in /io holds its open, and the frames after it, until
 * `window.__releaseIo(["open"])` (then ["message"]), or both at once.
 * Reload the page after adding it.
 *
 *   await context.addInitScript(holdIoScript);
 */
export function holdIoScript(): void {
  // The page's own WebSocket (this runs in the page, not in Node).
  const page = window as unknown as { WebSocket: typeof WebSocket };
  const W = page.WebSocket;
  const held: { k: string; f: () => void }[] = [];
  const go = new Set<string>();
  // Open first, then (on a second call) the frames: a socket whose
  // first frame comes late.
  (window as unknown as { __releaseIo: (k: string[]) => void }).__releaseIo = (
    ks,
  ) => {
    for (const k of ks) go.add(k);
    for (const h of held.splice(0))
      if (go.has(h.k)) h.f();
      else held.push(h);
  };
  class Held extends W {
    constructor(url: string | URL, prot?: string | string[]) {
      super(url, prot);
      if (!String(url).endsWith("/io")) return;
      const fns: Record<string, ((e: Event) => void) | null> = {
        open: null,
        message: null,
      };
      for (const k of ["open", "message"] as const) {
        Object.defineProperty(this, `on${k}`, {
          get: () => fns[k],
          set: (f) => (fns[k] = f),
        });
        super.addEventListener(k, (e: Event) => {
          const f = () => fns[k]?.call(this, e);
          if (go.has(k)) f();
          else held.push({ k, f });
        });
      }
      // Issue 1528: a routed socket (Playwright's routeWebSocket, which
      // the box guard always sets) keeps readyState as its own field and
      // sets it as it opens and closes. Keep those sets, and read them back
      // once open: a getter alone made each set throw, and reading
      // super.readyState found nothing. A native socket has no own field,
      // so it is read from the socket.
      const routed = Object.prototype.hasOwnProperty.call(this, "readyState");
      let state = this.readyState;
      Object.defineProperty(this, "readyState", {
        get: () => {
          const now = routed ? state : super.readyState;
          // Held until released, unless it has closed meanwhile.
          return go.has("open") || now === W.CLOSED ? now : W.CONNECTING;
        },
        set: (v: number) => {
          state = v;
        },
      });
    }
  }
  page.WebSocket = Held as typeof WebSocket;
}
