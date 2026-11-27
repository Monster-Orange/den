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
import {
  checkWebUrl,
  type WebUrl,
  type WebUrlChange,
} from "../../shared/web/web-url.js";
import {
  isLoopbackName,
  isLoopbackUrl,
  loopbackRefusal,
} from "../../shared/web/web-url-check.js";

export { isLoopbackName };

/** The path an alias made the address takes, in its activity row. */
export const ADOPT_PATH = "make-alias-the-address";

/** What adoptAllowed weighs: the request, as the guard saw it. */
export interface AdoptCaller {
  /** An agent's token or actor header. */
  agent: boolean;
  /** The person token (`<cli>` in the owner's own terminal). */
  personToken: boolean;
  /** Beyond this machine (the guard's `beyond`). */
  beyond: boolean;
  /** The browser's live session, how it was made and as whom. */
  session: { via?: string; login?: string } | null;
  /** The owner's GitHub login (web-owner.json, else web.owner_github). */
  ownerLogin: string | null;
}

/**
 * Issue 666: who may make an alias this install's address. Only the owner:
 *  - the person token: a CLI in the owner's own terminal;
 *  - a signed-in browser on this machine (the edge or loopback places it
 *    here; its session came from the owner's `web up` or `web login`);
 *  - a GitHub sign-in as the owner's own login, from anywhere;
 *  - a browser the owner let in from their terminal: a device code
 *    (`web approve`) or a sign-in link (`web login`), the fallback.
 * Never an agent, a browser with no session, another GitHub account, or
 * an org member's claim: a stranger on the network has none of these.
 */
export function adoptAllowed(
  c: AdoptCaller,
): { ok: true; how: string } | { ok: false; why: string } {
  const no = {
    ok: false as const,
    why: "Only this Den's owner can make this its address: sign in as the owner (GitHub), approve this browser in your terminal, or do it on the Den's own machine.",
  };
  if (c.agent) return no;
  if (c.personToken) return { ok: true, how: "the owner's terminal" };
  const s = c.session;
  if (!s) return no;
  if (!c.beyond) return { ok: true, how: "a browser on this machine" };
  if (
    s.via === "github" &&
    !!s.login &&
    !!c.ownerLogin &&
    s.login.toLowerCase() === c.ownerLogin.toLowerCase()
  )
    return { ok: true, how: "the owner's GitHub sign-in" };
  if (s.via === "code")
    return { ok: true, how: "a browser the owner approved with a code" };
  if (s.via === "link")
    return { ok: true, how: "a browser signed in with the owner's link" };
  return no;
}

/**
 * Issue 666: the alias to offer as the address, or null. On an alias
 * whose name isn't web.url, while web.url is unset, loopback, unconfirmed
 * or not working: that alias. Elsewhere (on this machine), while web.url
 * is unset or loopback: the first alias.
 */
export function offeredAlias(
  w: WebUrl | null,
  here: string | null,
  aliases: readonly string[],
  works: boolean,
): string | null {
  const loop = !w || isLoopbackUrl(w.url);
  if (here && here !== w?.url && (loop || !w?.confirmed || !works)) return here;
  if (!here && loop) return aliases[0] ?? null;
  return null;
}

export interface WebUrlRouteDeps {
  /** An agent's request (its token or actor header): never sets it. */
  isAgent: (req: http.IncomingMessage) => boolean;
  read: () => WebUrl | null;
  /** Save it; `how` is for its activity row (issue 666). */
  set: (url: string, how?: WebUrlChange) => string;
  /** Who the request is, for the activity row (its principal). */
  who?: (req: http.IncomingMessage) => string | undefined;
  /**
   * Issue 666: this install's edge aliases that may be its address
   * (aliasCandidates of the edge routes to this server).
   */
  aliases?: () => string[];
  /**
   * The alias this request came in on: through the edge with its proof,
   * over https, on one of `aliases`. Null otherwise.
   */
  here?: (req: http.IncomingMessage) => string | null;
  /** Whether web.url works as Den's named https address now. */
  works?: () => boolean;
  /** Whether the request is the owner's (adoptAllowed), and who. */
  owner?: (
    req: http.IncomingMessage,
  ) => { ok: true; who: string } | { ok: false; why: string };
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
  if (pathname === "/api/web-url/adopt" && req.method === "POST") {
    void adopt(req, res, d).catch((e) => {
      if (!res.headersSent)
        d.sendJson(res, { ok: false, error: (e as Error).message }, 500);
    });
    return true;
  }
  if (pathname !== "/api/web-url") return false;
  if (req.method === "GET") {
    const w = d.read();
    const offer = offeredAlias(
      w,
      d.here?.(req) ?? null,
      d.aliases?.() ?? [],
      d.works?.() ?? true,
    );
    d.sendJson(res, {
      ok: true,
      ...(w ?? { url: null }),
      loopback: isLoopbackUrl(w?.url),
      ...(offer ? { offer } : {}),
    });
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
    const loop = loopbackRefusal(ok.url);
    if (loop) return d.sendJson(res, { ok: false, error: loop }, 400);
    const answers = await checkAnswers(ok.url, d);
    if (!answers.ok)
      return d.sendJson(
        res,
        { ok: false, error: `${answers.why}. Not saved.`, saved: false },
        422,
      );
    try {
      const who = d.who?.(req);
      const url = d.set(ok.url, {
        path: "Settings › Den's address",
        ...(who ? { who } : {}),
      });
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

/**
 * POST /api/web-url/adopt {url}: issue 666's "Make <alias> this Den's
 * address". The url must be one of this install's own aliases (never a
 * name the caller makes up), the caller the owner (adoptAllowed), and the
 * alias must answer as this Den, as Check and save asks.
 */
async function adopt(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  d: WebUrlRouteDeps,
): Promise<void> {
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
  const aliases = d.aliases?.() ?? [];
  if (!("url" in ok) || !aliases.includes(ok.url) || isLoopbackUrl(ok.url))
    return d.sendJson(
      res,
      {
        ok: false,
        code: "not_an_alias",
        error: "That isn't one of this Den's own addresses. Nothing changed.",
      },
      400,
    );
  const owner = d.owner?.(req) ?? {
    ok: false as const,
    why: "Only this Den's owner can make this its address.",
  };
  if (!owner.ok)
    return d.sendJson(
      res,
      { ok: false, code: "owner_only", error: owner.why },
      403,
    );
  const answers = await checkAnswers(ok.url, d);
  if (!answers.ok)
    return d.sendJson(
      res,
      { ok: false, error: `${answers.why}. Not saved.`, saved: false },
      422,
    );
  const url = d.set(ok.url, { path: ADOPT_PATH, who: owner.who });
  d.sendJson(res, { ok: true, url, confirmed: true });
}
