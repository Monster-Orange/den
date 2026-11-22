/**
 * Issue 625, clauses 9 and 10: a browser on a test box, driving an app on
 * this machine through a tunnel back to it, sees this machine as its
 * loopback. localhost, 127.0.0.1 and *.localhost are then this machine,
 * where :80 and :443 may be live services. So a box run:
 *
 *  - declares its base URLs, each loopback with an explicit port other
 *    than 80 or 443 (`checkBaseUrl`; `gate run --base-url`, which hands
 *    the run DEN_GATE_ALLOW, the host:port list);
 *  - guards every browser context so only those host:ports load
 *    (`guardContext`, `guardBrowser`), and reports each block;
 *  - pins localhost names to 127.0.0.1 in its own process
 *    (`pinLoopbackNames`): the tunnel's sockets are opened by the client,
 *    and Node may try ::1 first while the forwarders listen on IPv4 only.
 *
 * The run's own Playwright setup calls these, with what Den handed it:
 *
 *   import { allowFromEnv, connectGuarded, guardBrowser, pinLoopbackNames }
 *   pinLoopbackNames();
 *   const allow = allowFromEnv(process.env);   // DEN_GATE_ALLOW
 *   guardBrowser(await connectGuarded(chromium, process.env.DEN_PW_WS),
 *     allow, (url) => console.error(`blocked: ${url}`));
 *
 * Issue 1033: connectGuarded connects with exposeNetwork from
 * DEN_PW_EXPOSE (the gate hands a box run "<loopback>"), so the box's
 * browser reaches this machine's ports. A box run that connects without
 * it is told once (warnBoxExpose).
 */
import dns from "dns";

/** A host this machine's loopback answers. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(h)
  );
}

/**
 * Issue 991: `host:*`, any port on that host but 80 and 443 (Den's own
 * browser suites start their server on a free port). URL can't parse a
 * `*` port, so it is read here: the URL with the port taken out.
 */
const ANY_PORT = /^([a-z][a-z0-9+.-]*:\/\/[^/:@]+):\*(\/.*)?$/i;

/** A box run's base URL: null when fine, else what is wrong. */
export function checkBaseUrl(raw: string): string | null {
  const any = ANY_PORT.exec(raw);
  let u: URL;
  try {
    u = new URL(any ? any[1]! + (any[2] ?? "") : raw);
  } catch {
    return `${raw} is not an address`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return `${raw}: a base URL is http or https`;
  if (!isLoopbackHost(u.hostname))
    return `${raw}: a box run's base URL is loopback (localhost, *.localhost or 127.0.0.1)`;
  if (any) return null;
  if (!u.port || u.port === "80" || u.port === "443")
    return `${raw}: give an explicit port other than 80 or 443, or * for any other port (this machine's live services may be there)`;
  return null;
}

/** "host:port" for a checked base URL ("host:*" for any port). */
export function allowOf(raw: string): string {
  const any = ANY_PORT.exec(raw);
  if (any) return `${new URL(any[1]!).hostname.toLowerCase()}:*`;
  const u = new URL(raw);
  return `${u.hostname.toLowerCase()}:${u.port}`;
}

/** The run's allowed host:ports, as Den handed them (DEN_GATE_ALLOW). */
export function allowFromEnv(env: NodeJS.ProcessEnv): string[] {
  return (env.DEN_GATE_ALLOW ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const HARMLESS = new Set(["about:", "data:"]);

/**
 * Whether a page may load `raw`: only a declared host:port, never 80/443.
 * A "host:*" entry (issue 991) covers only `ownPorts`, the ports the run
 * opened itself; with none given it covers nothing, so a box's browser
 * never reaches another service on this machine's loopback.
 */
export function allowedUrl(
  raw: string,
  allow: string[],
  ownPorts?: { has(port: number): boolean },
): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (HARMLESS.has(u.protocol)) return true;
  if (u.protocol === "blob:") return allowedUrl(u.pathname, allow, ownPorts);
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return false;
  if (u.username || u.password) return false;
  // 80 and 443 (written out, or the scheme's own) are never allowed, not
  // even by a "host:*" entry.
  if (!u.port || u.port === "80" || u.port === "443") return false;
  const host = u.hostname.toLowerCase();
  const want = `${host}:${u.port}`;
  const own = ownPorts?.has(Number(u.port)) ?? false;
  return allow
    .map((a) => a.toLowerCase())
    .some((a) => a === want || (own && a === `${host}:*`));
}

/** The few Playwright shapes the guard uses (no Playwright import). */
interface RouteLike {
  request(): { url(): string };
  continue(): Promise<unknown>;
  abort(code?: string): Promise<unknown>;
}
interface WsRouteLike {
  url(): string;
  connectToServer(): unknown;
  close(): unknown;
}
export interface ContextLike {
  route(pattern: string, h: (r: RouteLike) => Promise<void>): Promise<unknown>;
  routeWebSocket?(
    pattern: RegExp,
    h: (ws: WsRouteLike) => Promise<void> | void,
  ): Promise<unknown>;
}

/** Guards one browser context: anything else is stopped and reported. */
export async function guardContext<C extends ContextLike>(
  ctx: C,
  allow: string[],
  onBlock: (url: string) => void = () => {},
  ownPorts?: { has(port: number): boolean },
): Promise<C> {
  await ctx.route("**/*", async (route) => {
    const url = route.request().url();
    if (allowedUrl(url, allow, ownPorts)) {
      await route.continue();
      return;
    }
    onBlock(url);
    await route.abort("blockedbyclient");
  });
  if (typeof ctx.routeWebSocket === "function")
    await ctx.routeWebSocket(/.*/, (ws) => {
      const url = ws.url();
      if (allowedUrl(url, allow, ownPorts)) {
        ws.connectToServer();
        return;
      }
      onBlock(url);
      ws.close();
    });
  return ctx;
}

/** Every context the browser makes is guarded (service workers off). */
export function guardBrowser<
  B extends { newContext(o?: Record<string, unknown>): Promise<ContextLike> },
>(
  browser: B,
  allow: string[],
  onBlock: (url: string) => void = () => {},
  ownPorts?: { has(port: number): boolean },
): B {
  const make = browser.newContext.bind(browser);
  browser.newContext = async (o: Record<string, unknown> = {}) =>
    guardContext(
      await make({ ...o, serviceWorkers: "block" }),
      allow,
      onBlock,
      ownPorts,
    );
  return browser;
}

const isLocalName = (h: unknown) => {
  const s = String(h).toLowerCase();
  return s === "localhost" || s.endsWith(".localhost");
};
const V4 = { address: "127.0.0.1", family: 4 } as const;

/**
 * Pins localhost and *.localhost to 127.0.0.1 in this process, for both
 * dns.lookup and dns.promises.lookup; an IPv6-only ask for them fails.
 * Returns an undo.
 */
export function pinLoopbackNames(): () => void {
  const orig = dns.lookup;
  const origP = dns.promises.lookup;
  const refused = () =>
    Object.assign(new Error("localhost names are pinned to 127.0.0.1"), {
      code: "ENOTFOUND",
    });
  const pinned = function (
    host: string,
    opts: unknown,
    cb?: (...a: unknown[]) => void,
  ) {
    if (typeof opts === "function") {
      cb = opts as (...a: unknown[]) => void;
      opts = {};
    }
    if (!isLocalName(host))
      return (orig as (...a: unknown[]) => unknown).call(dns, host, opts, cb);
    const o =
      typeof opts === "number"
        ? { family: opts }
        : ((opts ?? {}) as { family?: number; all?: boolean });
    if (o.family === 6) return process.nextTick(cb!, refused());
    return o.all
      ? process.nextTick(cb!, null, [V4])
      : process.nextTick(cb!, null, V4.address, V4.family);
  };
  (dns as { lookup: unknown }).lookup = pinned;
  (dns.promises as { lookup: unknown }).lookup = async (
    host: string,
    opts?: { family?: number; all?: boolean } | number,
  ) => {
    if (!isLocalName(host))
      return (origP as (...a: unknown[]) => unknown).call(
        dns.promises,
        host,
        opts,
      );
    const o = typeof opts === "number" ? { family: opts } : (opts ?? {});
    if (o.family === 6) throw refused();
    return o.all ? [V4] : { ...V4 };
  };
  return () => {
    (dns as { lookup: unknown }).lookup = orig;
    (dns.promises as { lookup: unknown }).lookup = origP;
  };
}

/** Issue 1033: where the gate says what a box run's client exposes. */
export const PW_EXPOSE_ENV = "DEN_PW_EXPOSE";

/**
 * Issue 1033: connect() options with exposeNetwork from DEN_PW_EXPOSE,
 * unless the caller gave its own. Nothing set: the options as given.
 */
export function connectOptions<O extends { exposeNetwork?: string }>(
  env: NodeJS.ProcessEnv,
  o?: O,
): O & { exposeNetwork?: string } {
  const out = { ...(o ?? {}) } as O & { exposeNetwork?: string };
  const want = env[PW_EXPOSE_ENV]?.trim();
  if (out.exposeNetwork === undefined && want) out.exposeNetwork = want;
  return out;
}

let warnedExpose = false;

/**
 * Issue 1033: a box run (DEN_GATE_SLOT_BOX set, not "local") connecting
 * without exposeNetwork <loopback> (or *): its pages on this machine are
 * refused. Said once per process; true when it was said now.
 */
export function warnBoxExpose(
  env: NodeJS.ProcessEnv,
  o: { exposeNetwork?: string } | undefined,
  say: (line: string) => void = (l) => console.error(l),
): boolean {
  const box = env.DEN_GATE_SLOT_BOX?.trim();
  if (!box || box === "local" || warnedExpose) return false;
  const exposed = (o?.exposeNetwork ?? "").split(",").map((x) => x.trim());
  if (exposed.includes("<loopback>") || exposed.includes("*")) return false;
  warnedExpose = true;
  say(
    "box run without exposeNetwork <loopback>: pages on this machine will be refused; pass DEN_PW_EXPOSE to connect()",
  );
  return true;
}

/**
 * Issue 1033: connects to the run's Playwright server with exposeNetwork
 * from DEN_PW_EXPOSE (connectOptions), saying once if a box run still
 * goes without it.
 */
export async function connectGuarded<O extends { exposeNetwork?: string }, B>(
  type: { connect(ws: string, o: O): Promise<B> },
  ws: string,
  o?: O,
  env: NodeJS.ProcessEnv = process.env,
  say?: (line: string) => void,
): Promise<B> {
  const opts = connectOptions(env, o);
  warnBoxExpose(env, opts, say);
  return type.connect(ws, opts);
}
