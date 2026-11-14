/**
 * MODE-5 (0.4.46): this install's address (web.url, D80) as a page control,
 * Settings › Den's address, in place of `<cli> web url <address>`.
 *
 *   GET  /api/web-url          what is set ({url, confirmed, from}, or url null)
 *   POST /api/web-url {url}    a person's only: "Check and save". The
 *                              address must answer as this Den before it is
 *                              saved; else nothing changes and it says why
 *   GET  /api/web-url/probe?n= the check's other end: 204 for a token this
 *                              server just made, else 404. No sign-in (the
 *                              check comes in through the edge with no
 *                              cookie); it tells nothing else
 *
 * The check: the server makes a one-time token and asks the address for
 * it. Only this server holds it, so a 204 means the name reaches this Den
 * (another server, or the edge's "no route", never answers 204). A
 * loopback name is refused: the address is the one other machines reach.
 */
import * as http from "http";
import { randomBytes } from "crypto";
import { checkWebUrl, type WebUrl } from "../../shared/web-url.js";

export interface WebUrlRouteDeps {
  /** An agent's request (its token or actor header): never sets it. */
  isAgent: (req: http.IncomingMessage) => boolean;
  read: () => WebUrl | null;
  set: (url: string) => string;
  /** GET `url`; its status, or why there was none. */
  ping: (
    url: string,
    timeoutMs: number,
  ) => Promise<{ status?: number; error?: string }>;
  /** web.url_check_seconds: how long the check waits (10). */
  checkMs: () => number;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  sendJson: (res: http.ServerResponse, body: unknown, status?: number) => void;
}

/** Tokens the check made, each good for a minute. */
const tokens = new Map<string, number>();
const TOKEN_MS = 60_000;

function newToken(): string {
  const now = Date.now();
  for (const [t, until] of tokens) if (until < now) tokens.delete(t);
  const t = randomBytes(16).toString("hex");
  tokens.set(t, now + TOKEN_MS);
  return t;
}

/** A name that means this machine only: never the install's address. */
export function isLoopbackName(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    /^127\./.test(h) ||
    h === "0.0.0.0"
  );
}

/** Whether `url` answers as this Den; else why not, in words. */
export async function checkAnswers(
  url: string,
  d: Pick<WebUrlRouteDeps, "ping" | "checkMs">,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const token = newToken();
  try {
    const r = await d.ping(`${url}/api/web-url/probe?n=${token}`, d.checkMs());
    if (r.status === 204) return { ok: true };
    if (r.status !== undefined)
      return {
        ok: false,
        why: `${url} answered, but not as this Den (${r.status})`,
      };
    return {
      ok: false,
      why:
        r.error === "timeout"
          ? `nothing at ${url} answered within ${Math.round(d.checkMs() / 1000)} s`
          : r.error === "dns"
            ? `the name in ${url} doesn't resolve on this machine`
            : `nothing at ${url} answered (${r.error ?? "no answer"})`,
    };
  } finally {
    tokens.delete(token);
  }
}

export function handleWebUrlRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: WebUrlRouteDeps,
): boolean {
  if (pathname === "/api/web-url/probe" && req.method === "GET") {
    const n = new URL(req.url ?? "/", "http://den.invalid").searchParams.get(
      "n",
    );
    const until = n ? tokens.get(n) : undefined;
    res.writeHead(until !== undefined && until >= Date.now() ? 204 : 404, {
      "Cache-Control": "no-store",
    });
    res.end();
    return true;
  }
  if (pathname !== "/api/web-url") return false;
  if (req.method === "GET") {
    const w = d.read();
    d.sendJson(res, w ? { ok: true, ...w } : { ok: true, url: null });
    return true;
  }
  if (req.method !== "POST") return false;
  void (async () => {
    if (d.isAgent(req))
      return d.sendJson(
        res,
        { ok: false, error: "only a person sets this install's address" },
        403,
      );
    let body: { url?: unknown };
    try {
      body = JSON.parse(await d.readBody(req)) as { url?: unknown };
    } catch {
      return d.sendJson(res, { ok: false, error: "not JSON" }, 400);
    }
    const ok = checkWebUrl(body.url);
    if (!("url" in ok))
      return d.sendJson(res, { ok: false, error: ok.error }, 400);
    if (isLoopbackName(new URL(ok.url).hostname))
      return d.sendJson(
        res,
        {
          ok: false,
          error: `${ok.url} names this machine only: the address is the name other devices open`,
        },
        400,
      );
    const answers = await checkAnswers(ok.url, d);
    if (!answers.ok)
      return d.sendJson(
        res,
        { ok: false, error: `${answers.why}. Not saved.`, saved: false },
        422,
      );
    try {
      const url = d.set(ok.url);
      d.sendJson(res, { ok: true, url, confirmed: true });
    } catch (e) {
      d.sendJson(res, { ok: false, error: (e as Error).message }, 500);
    }
  })().catch((e) => {
    if (!res.headersSent)
      d.sendJson(res, { ok: false, error: (e as Error).message }, 500);
  });
  return true;
}
