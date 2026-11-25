/**
 * Issue 1491: an app feed's request, pinned to the address Den resolved
 * and checked for that connect. fetch looks a name up again on its own,
 * so an answer that changes between Den's check and the connect (DNS
 * rebinding) could reach this machine or a private network. Here the
 * socket goes to exactly `address`; the feed's name stays the URL's host,
 * so TLS checks the certificate against it (servername) and the Host
 * header carries it.
 *
 * A redirect is never followed (it would carry the bearer elsewhere): it
 * rejects with `redirect: true`, as fetch's redirect: "error" refuses one.
 * An aborted signal rejects with the signal's reason, so a timeout stays a
 * TimeoutError. The answer is a WHATWG Response, read as fetch's is.
 */
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

export interface PinnedInit {
  headers: Record<string, string>;
  /** The checked address the socket goes to. */
  address: string;
  family: 4 | 6;
  signal?: AbortSignal;
  /** Extra trusted roots (tests); the system's are used otherwise. */
  ca?: string | Buffer;
}

export type PinnedFetch = (url: string, init: PinnedInit) => Promise<Response>;

export const pinnedFetch: PinnedFetch = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      reject(new Error(`unsupported protocol ${u.protocol}`));
      return;
    }
    const signal = init.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const lookup = ((
      _host: string,
      opts: { all?: boolean },
      cb: (...a: unknown[]) => void,
    ) => {
      if (opts?.all) cb(null, [{ address: init.address, family: init.family }]);
      else cb(null, init.address, init.family);
    }) as unknown as LookupFunction;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const tls = u.protocol === "https:";
    const options: https.RequestOptions = {
      method: "GET",
      headers: init.headers,
      lookup,
      ...(tls
        ? {
            // An address has no name to check a certificate against.
            ...(/^[\d.]+$|:/.test(host) ? {} : { servername: host }),
            ...(init.ca ? { ca: init.ca } : {}),
          }
        : {}),
      agent: false,
    };
    const req = (tls ? https : http).request(u, options, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        req.destroy();
        reject(
          Object.assign(new Error("the app answered a redirect"), {
            redirect: true,
          }),
        );
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) for (const x of v) headers.append(k, x);
        else if (v !== undefined) headers.set(k, v);
      }
      const body =
        status === 204 || status === 304
          ? null
          : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
      resolve(new Response(body, { status, headers }));
    });
    const onAbort = () => req.destroy(signal!.reason as Error);
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.aborted ? signal.reason : e);
    });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.end();
  });
