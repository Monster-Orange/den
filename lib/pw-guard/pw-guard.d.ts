/** A host this machine's loopback answers. */
export declare function isLoopbackHost(host: string): boolean;
/** A box run's base URL: null when fine, else what is wrong. */
export declare function checkBaseUrl(raw: string): string | null;
/** "host:port" for a checked base URL ("host:*" for any port). */
export declare function allowOf(raw: string): string;
/** The run's allowed host:ports, as Den handed them (DEN_GATE_ALLOW). */
export declare function allowFromEnv(env: NodeJS.ProcessEnv): string[];
/**
 * Whether a page may load `raw`: only a declared host:port, never 80/443.
 * A "host:*" entry (issue 991) covers only `ownPorts`, the ports the run
 * opened itself; with none given it covers nothing, so a box's browser
 * never reaches another service on this machine's loopback.
 */
export declare function allowedUrl(raw: string, allow: string[], ownPorts?: {
    has(port: number): boolean;
}): boolean;
/** The few Playwright shapes the guard uses (no Playwright import). */
interface RouteLike {
    request(): {
        url(): string;
    };
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
    routeWebSocket?(pattern: RegExp, h: (ws: WsRouteLike) => Promise<void> | void): Promise<unknown>;
}
/** Guards one browser context: anything else is stopped and reported. */
export declare function guardContext<C extends ContextLike>(ctx: C, allow: string[], onBlock?: (url: string) => void, ownPorts?: {
    has(port: number): boolean;
}): Promise<C>;
/** Every context the browser makes is guarded (service workers off). */
export declare function guardBrowser<B extends {
    newContext(o?: Record<string, unknown>): Promise<ContextLike>;
}>(browser: B, allow: string[], onBlock?: (url: string) => void, ownPorts?: {
    has(port: number): boolean;
}): B;
/**
 * Pins localhost and *.localhost to 127.0.0.1 in this process, for both
 * dns.lookup and dns.promises.lookup; an IPv6-only ask for them fails.
 * Returns an undo.
 */
export declare function pinLoopbackNames(): () => void;
/** Issue 1033: where the gate says what a box run's client exposes. */
export declare const PW_EXPOSE_ENV = "DEN_PW_EXPOSE";
/**
 * Issue 1033: connect() options with exposeNetwork from DEN_PW_EXPOSE,
 * unless the caller gave its own. Nothing set: the options as given.
 */
export declare function connectOptions<O extends {
    exposeNetwork?: string;
}>(env: NodeJS.ProcessEnv, o?: O): O & {
    exposeNetwork?: string;
};
/**
 * Issue 1033: a box run (DEN_GATE_SLOT_BOX set, not "local") connecting
 * without exposeNetwork <loopback> (or *): its pages on this machine are
 * refused. Said once per process; true when it was said now.
 */
export declare function warnBoxExpose(env: NodeJS.ProcessEnv, o: {
    exposeNetwork?: string;
} | undefined, say?: (line: string) => void): boolean;
/**
 * Issue 1033: connects to the run's Playwright server with exposeNetwork
 * from DEN_PW_EXPOSE (connectOptions), saying once if a box run still
 * goes without it.
 */
export declare function connectGuarded<O extends {
    exposeNetwork?: string;
}, B>(type: {
    connect(ws: string, o: O): Promise<B>;
}, ws: string, o?: O, env?: NodeJS.ProcessEnv, say?: (line: string) => void): Promise<B>;
export {};
