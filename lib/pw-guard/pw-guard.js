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
 *   import { connectGuarded, pinLoopbackNames }
 *   pinLoopbackNames();
 *   const browser = await connectGuarded(chromium, process.env.DEN_PW_WS);
 *
 * Issue 1033: connectGuarded connects with exposeNetwork from
 * DEN_PW_EXPOSE (the gate hands a box run "<loopback>"), so the box's
 * browser reaches this machine's ports. A box run that connects without
 * it is told once (warnBoxExpose).
 *
 * Issue 1205: the connect is guarded. When it exposes this machine's
 * network, the browser comes back already guarded by DEN_GATE_ALLOW (no
 * list: nothing loads), each block reported. A browser connected another
 * way needs guardBrowser; guarding twice is harmless (a second guard can
 * only narrow what loads).
 */
import dns from "dns";
/** A host this machine's loopback answers. */
export function isLoopbackHost(host) {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    return (h === "localhost" ||
        h.endsWith(".localhost") ||
        h === "::1" ||
        /^127(?:\.\d{1,3}){3}$/.test(h));
}
/**
 * Issue 991: `host:*`, any port on that host but 80 and 443 (Den's own
 * browser suites start their server on a free port). URL can't parse a
 * `*` port, so it is read here: the URL with the port taken out.
 */
const ANY_PORT = /^([a-z][a-z0-9+.-]*:\/\/[^/:@]+):\*(\/.*)?$/i;
/** A box run's base URL: null when fine, else what is wrong. */
export function checkBaseUrl(raw) {
    const any = ANY_PORT.exec(raw);
    let u;
    try {
        u = new URL(any ? any[1] + (any[2] ?? "") : raw);
    }
    catch {
        return `${raw} is not an address`;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
        return `${raw}: a base URL is http or https`;
    if (!isLoopbackHost(u.hostname))
        return `${raw}: a box run's base URL is loopback (localhost, *.localhost or 127.0.0.1)`;
    if (any)
        return null;
    if (!u.port || u.port === "80" || u.port === "443")
        return `${raw}: give an explicit port other than 80 or 443, or * for any other port (this machine's live services may be there)`;
    return null;
}
/** "host:port" for a checked base URL ("host:*" for any port). */
export function allowOf(raw) {
    const any = ANY_PORT.exec(raw);
    if (any)
        return `${new URL(any[1]).hostname.toLowerCase()}:*`;
    const u = new URL(raw);
    return `${u.hostname.toLowerCase()}:${u.port}`;
}
/** The run's allowed host:ports, as Den handed them (DEN_GATE_ALLOW). */
export function allowFromEnv(env) {
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
export function allowedUrl(raw, allow, ownPorts) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        return false;
    }
    if (HARMLESS.has(u.protocol))
        return true;
    if (u.protocol === "blob:")
        return allowedUrl(u.pathname, allow, ownPorts);
    if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol))
        return false;
    if (u.username || u.password)
        return false;
    // 80 and 443 (written out, or the scheme's own) are never allowed, not
    // even by a "host:*" entry.
    if (!u.port || u.port === "80" || u.port === "443")
        return false;
    const host = sameHost(u.hostname);
    const own = ownPorts?.has(Number(u.port)) ?? false;
    return allow.some((a) => {
        const at = a.lastIndexOf(":");
        if (at < 0)
            return false;
        if (sameHost(a.slice(0, at)) !== host)
            return false;
        const port = a.slice(at + 1);
        return port === u.port || (own && port === "*");
    });
}
/**
 * The host an allow entry is matched by. A box run pins localhost and
 * *.localhost to 127.0.0.1 (`pinLoopbackNames`), and Den's own test
 * servers listen on "localhost", so the three are one host: a run allowed
 * 127.0.0.1:* reaches localhost:<its port>, and the reverse. ::1 and the
 * rest of 127/8 aren't pinned, so they stay names of their own.
 */
function sameHost(host) {
    const h = host.toLowerCase();
    return h === "127.0.0.1" || isLocalName(h) ? "127.0.0.1" : h;
}
/**
 * Routes one context through every guard in `guards` (read at each
 * request, so a guard added later counts): a URL loads only when each
 * allows it, and each guard that refuses it hears of it.
 */
async function routeThrough(ctx, guards) {
    const refusedBy = (url) => guards.filter((g) => !allowedUrl(url, g.allow, g.ownPorts));
    await ctx.route("**/*", async (route) => {
        const url = route.request().url();
        const no = refusedBy(url);
        if (!no.length) {
            await route.continue();
            return;
        }
        for (const g of no)
            g.onBlock(url);
        await route.abort("blockedbyclient");
    });
    if (typeof ctx.routeWebSocket === "function")
        await ctx.routeWebSocket(/.*/, (ws) => {
            const url = ws.url();
            const no = refusedBy(url);
            if (!no.length) {
                ws.connectToServer();
                return;
            }
            for (const g of no)
                g.onBlock(url);
            ws.close();
        });
    return ctx;
}
/** Guards one browser context: anything else is stopped and reported. */
export async function guardContext(ctx, allow, onBlock = () => { }, ownPorts) {
    return routeThrough(ctx, [{ allow, onBlock, ownPorts }]);
}
/** Where a guarded browser keeps its guards (issue 1205). */
const GUARDS = Symbol.for("den.gate.pwGuards");
/**
 * Every context the browser makes is guarded (service workers off),
 * newPage's own one too. Issue 1205: guarding a browser again adds this
 * guard beside the first, and never loosens it: a URL loads only when
 * every guard allows it, one route per context. The same allow list and
 * reporter again changes nothing.
 */
export function guardBrowser(browser, allow, onBlock = () => { }, ownPorts) {
    const held = browser;
    const guards = held[GUARDS];
    if (guards) {
        // A repeat is the same list and reporter; its ownPorts isn't compared,
        // so a repeat with wider own ports is dropped (errs tight).
        const key = [...allow].sort().join(",");
        const same = guards.some((g) => [...g.allow].sort().join(",") === key && g.onBlock === onBlock);
        if (!same)
            guards.push({ allow: [...allow], onBlock, ownPorts });
        return browser;
    }
    const list = [{ allow: [...allow], onBlock, ownPorts }];
    Object.defineProperty(held, GUARDS, { value: list });
    const make = browser.newContext.bind(browser);
    browser.newContext = async (o = {}) => routeThrough(await make({ ...o, serviceWorkers: "block" }), list);
    // Playwright's browser.newPage makes its own context, not through
    // newContext: give it a guarded one, closed with the page.
    if (typeof browser.newPage === "function")
        browser.newPage = async (o) => {
            const ctx = (await browser.newContext(o));
            const page = await ctx.newPage();
            page.once?.("close", () => void ctx.close?.().catch(() => { }));
            return page;
        };
    return browser;
}
const isLocalName = (h) => {
    const s = String(h).toLowerCase();
    return s === "localhost" || s.endsWith(".localhost");
};
const V4 = { address: "127.0.0.1", family: 4 };
/**
 * Pins localhost and *.localhost to 127.0.0.1 in this process, for both
 * dns.lookup and dns.promises.lookup; an IPv6-only ask for them fails.
 * Returns an undo.
 */
export function pinLoopbackNames() {
    const orig = dns.lookup;
    const origP = dns.promises.lookup;
    const refused = () => Object.assign(new Error("localhost names are pinned to 127.0.0.1"), {
        code: "ENOTFOUND",
    });
    const pinned = function (host, opts, cb) {
        if (typeof opts === "function") {
            cb = opts;
            opts = {};
        }
        if (!isLocalName(host))
            return orig.call(dns, host, opts, cb);
        const o = typeof opts === "number"
            ? { family: opts }
            : (opts ?? {});
        if (o.family === 6)
            return process.nextTick(cb, refused());
        return o.all
            ? process.nextTick(cb, null, [V4])
            : process.nextTick(cb, null, V4.address, V4.family);
    };
    dns.lookup = pinned;
    dns.promises.lookup = async (host, opts) => {
        if (!isLocalName(host))
            return origP.call(dns.promises, host, opts);
        const o = typeof opts === "number" ? { family: opts } : (opts ?? {});
        if (o.family === 6)
            throw refused();
        return o.all ? [V4] : { ...V4 };
    };
    return () => {
        dns.lookup = orig;
        dns.promises.lookup = origP;
    };
}
/** Issue 1033: where the gate says what a box run's client exposes. */
export const PW_EXPOSE_ENV = "DEN_PW_EXPOSE";
/**
 * Issue 1033: connect() options with exposeNetwork from DEN_PW_EXPOSE,
 * unless the caller gave its own. Nothing set: the options as given.
 */
export function connectOptions(env, o) {
    const out = { ...(o ?? {}) };
    const want = env[PW_EXPOSE_ENV]?.trim();
    if (out.exposeNetwork === undefined && want)
        out.exposeNetwork = want;
    return out;
}
let warnedExpose = false;
/**
 * Issue 1033: a box run (DEN_GATE_SLOT_BOX set, not "local") connecting
 * without exposeNetwork <loopback> (or *): its pages on this machine are
 * refused. Said once per process; true when it was said now.
 */
export function warnBoxExpose(env, o, say = (l) => console.error(l)) {
    const box = env.DEN_GATE_SLOT_BOX?.trim();
    if (!box || box === "local" || warnedExpose)
        return false;
    const exposed = (o?.exposeNetwork ?? "").split(",").map((x) => x.trim());
    if (exposed.includes("<loopback>") || exposed.includes("*"))
        return false;
    warnedExpose = true;
    say("box run without exposeNetwork <loopback>: pages on this machine will be refused; pass DEN_PW_EXPOSE to connect()");
    return true;
}
/**
 * Issue 1033: connects to the run's Playwright server with exposeNetwork
 * from DEN_PW_EXPOSE (connectOptions), saying once if a box run still
 * goes without it.
 *
 * Issue 1205: when the connection exposes this machine's network (any
 * exposeNetwork), the browser comes back already guarded (guardBrowser):
 * pages load only DEN_GATE_ALLOW's host:ports (or `guard.allow`), each
 * block is reported, and with no allow list nothing loads. It never
 * reaches this machine unguarded. Not exposed: the browser as given.
 */
export async function connectGuarded(type, ws, o, env = process.env, say, guard = {}) {
    const opts = connectOptions(env, o);
    warnBoxExpose(env, opts, say);
    const browser = await type.connect(ws, opts);
    if (!opts.exposeNetwork?.trim())
        return browser;
    const tell = say ?? ((l) => console.error(l));
    try {
        // Loaded here, not at the top: own-ports watches every listen in the
        // process, which only a run that exposes its loopback needs. A server
        // started before own-ports first loads isn't seen: claim its port with
        // boxOwnPort. (The package export loads own-ports when it is imported.)
        const own = guard.ownPorts ?? (await import("./own-ports.js")).ownPorts();
        return guardBrowser(browser, guard.allow ?? allowFromEnv(env), guard.onBlock ?? ((url) => tell(`pw-guard: refused ${url}`)), own);
    }
    catch (err) {
        // Never hand back, or leave open, a browser that isn't guarded.
        await browser.close?.().catch(() => { });
        throw err;
    }
}
